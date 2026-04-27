/**
 * Sprint 11.5 — strict in-memory ring buffer for debug logging.
 *
 * Hard rules (per pilot incident on 2026-04-27):
 *  - dbg() / dbgError() are SYNCHRONOUS and NEVER touch SQLite.
 *  - Operational tables (events, sync_outbox, orders, catalog,
 *    recovery, fiscal attempts, audit) remain the ONLY persistent
 *    state the engine writes through tauriExecutor.
 *  - No auto-flush, no eager persist, no setInterval that touches the
 *    DB. The "Trimite loguri" button is the ONE manual path that ships
 *    in-memory log lines to the backend; it never writes to SQLite.
 *  - The settings.debug.enabled toggle is still persisted (one tiny
 *    write on toggle), so the choice survives restart, but every
 *    subsequent log call is RAM-only.
 *
 * Why: prior versions routed dbg() into device_logs through the same
 * tauriExecutor mutex that serialises persistBatch / pull / outbox
 * pushes. With ~30 clicks/min the queue saturated (dbQueueDepth: 173,
 * runPull stuck 9 minutes, outboxWorker never ticked, queueDepth grew
 * unbounded, KDS empty). RAM-only logging removes that contention
 * point entirely.
 */
import { initDb } from '@/lib/db';
import { logger } from '@/lib/logger';

const SETTINGS_KEY = 'debug.enabled';
export const RING_BUFFER_MAX = 5_000;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RingLog {
  ts: string; // ISO timestamp
  level: LogLevel;
  source: string;
  message: string;
  context: Record<string, unknown> | null;
}

let _enabled = false;
let _initialised = false;
const _ring: RingLog[] = [];
const _listeners = new Set<(on: boolean) => void>();

export function isDebugEnabled(): boolean {
  return _enabled;
}

export function onDebugToggle(fn: (on: boolean) => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function readInitialised(): boolean {
  return _initialised;
}

export function readRingBufferCount(): number {
  return _ring.length;
}

/** Snapshot the ring buffer for export / shipping. Returns a fresh
 *  array — caller can mutate freely. */
export function readRingBuffer(): RingLog[] {
  return _ring.slice();
}

/** Drop everything in the buffer (used after a successful manual
 *  ship if the operator wants a clean slate). */
export function clearRingBuffer(): void {
  _ring.length = 0;
}

/** Toggle persistence is the ONLY DB write this module ever makes,
 *  and only when the user flips the toggle (rare). All other logging
 *  stays in RAM. */
export async function loadDebugFlag(): Promise<boolean> {
  try {
    const db = await initDb();
    const rows = await db.select<{ value_json: string }[]>(
      'SELECT value_json FROM settings WHERE key = ?',
      [SETTINGS_KEY],
    );
    const raw = rows[0]?.value_json ?? null;
    _enabled = raw === 'true' || raw === '1' || raw === '"true"';
  } catch {
    _enabled = false;
  }
  _initialised = true;
  for (const fn of _listeners) fn(_enabled);
  return _enabled;
}

export async function setDebugEnabled(on: boolean): Promise<void> {
  _enabled = on;
  try {
    const db = await initDb();
    await db.execute(
      `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                      updated_at = datetime('now')`,
      [SETTINGS_KEY, on ? 'true' : 'false'],
    );
  } catch (err) {
    logger.warn('debug', 'persist toggle failed', { err: String(err) });
  }
  for (const fn of _listeners) fn(_enabled);
}

/** Push a row into the ring buffer. Synchronous, no await, no DB. */
function push(level: LogLevel, source: string, message: string, ctx?: unknown): void {
  const entry: RingLog = {
    ts: new Date().toISOString(),
    level,
    source,
    message,
    context: ctx == null ? null : safeContext(ctx),
  };
  _ring.push(entry);
  if (_ring.length > RING_BUFFER_MAX) _ring.shift();
}

function safeContext(value: unknown, depth = 0): Record<string, unknown> | null {
  if (value == null) return null;
  if (depth > 3) return { _truncated: true };
  if (typeof value !== 'object') return { value: String(value).slice(0, 500) };
  if (Array.isArray(value)) {
    const arr = value.slice(0, 20).map((v) => sanitise(v, depth + 1));
    return { _array: arr, _length: value.length };
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (count++ > 30) {
      out._truncated = true;
      break;
    }
    out[k] = sanitise(v, depth + 1);
  }
  return out;
}

function sanitise(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 3) return '<truncated>';
  if (typeof value === 'function') return '<function>';
  if (typeof value === 'string') {
    return value.length > 500 ? value.slice(0, 480) + '…' : value;
  }
  if (Array.isArray(value)) {
    return value.length > 20
      ? `<array length=${value.length}>`
      : value.map((v) => sanitise(v, depth + 1));
  }
  if (typeof value === 'object') {
    return safeContext(value, depth);
  }
  return value;
}

/** Emit a debug line. Always writes to console; pushes to RAM ring
 *  ONLY when the toggle is on. NEVER touches SQLite. */
export function dbg(source: string, message: string, ctx?: unknown): void {
  if (!_enabled) return;
  // eslint-disable-next-line no-console
  console.log(`[POS-DBG] ${source}: ${message}`, ctx ?? '');
  push('debug', source, message, ctx);
}

/** Always emit (errors are rare and matter even with debug off).
 *  Console + RAM ring. NEVER touches SQLite. */
export function dbgError(source: string, message: string, ctx?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[POS-ERR] ${source}: ${message}`, ctx ?? '');
  push('error', source, message, ctx);
}

/** Wrap a function so each call logs entry/exit/exception when debug
 *  is on. Errors are always recorded (dbgError) regardless. */
export function instrument<Args extends unknown[], R>(
  source: string,
  name: string,
  fn: (...args: Args) => Promise<R> | R,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const t0 = Date.now();
    if (_enabled) dbg(source, `${name} ▶`);
    try {
      const out = await fn(...args);
      if (_enabled) dbg(source, `${name} ◀ ${Date.now() - t0}ms`);
      return out;
    } catch (err) {
      dbgError(source, `${name} ✖ ${Date.now() - t0}ms`, {
        message: (err as Error)?.message ?? String(err),
      });
      throw err;
    }
  };
}

// ─── Backwards-compat no-ops removed; the engine no longer attaches
// or detaches an executor for the logger. Existing callers that used
// these names are kept stub-compatible so a single sprint deploy
// doesn't ripple breakage.
export function attachExecutorForLogs(_exec: unknown): void {
  // intentionally no-op in 11.5 — logging is RAM-only
}
export function detachExecutorForLogs(): void {
  // intentionally no-op in 11.5
}
export async function flushDebugBufferNow(): Promise<void> {
  // intentionally no-op in 11.5 — buffer is read directly by the shipper
}
