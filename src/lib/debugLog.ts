/**
 * Verbose debug logging — Sprint 11.
 *
 * When `enabled` is true, instrumented call sites write structured log
 * lines into the local `device_logs` table. The shipper later batches
 * those lines to `POST /api/pos/diagnostics/dump` so support can read
 * them on the backend without screen-sharing or DevTools access.
 *
 * Toggle is persisted under `settings.debug.enabled` so it survives
 * restarts. Default OFF — wrapping has near-zero cost when disabled
 * (one branch + early return).
 */
import { initDb } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { SqlExecutor } from '@/lib/db/executor';

const SETTINGS_KEY = 'debug.enabled';

let _enabled = false;
let _initialised = false;
const _listeners = new Set<(on: boolean) => void>();

/**
 * Sprint 11.1 hot-fix — persist() writes were going to the underlying
 * tauri-plugin-sql connection directly, bypassing the tauriExecutor's
 * FIFO mutex. That made fire-and-forget INSERTs into `device_logs`
 * race with the engine's hydrate transaction; in some interleavings
 * the BEGIN landed but the catalog statements ran on a different
 * connection, so the eventual COMMIT failed with
 *   "cannot commit - no transaction is active".
 *
 * Fix: never touch the DB from persist() until startSyncEngine
 * explicitly attaches the executor. Until then we hold log lines in
 * a small ring buffer; the engine drains it through the mutex once
 * hydrate is done.
 */
let _exec: SqlExecutor | null = null;
const _buffer: Array<[string, string, string, string | null]> = [];
const BUFFER_LIMIT = 1000;

export function isDebugEnabled(): boolean {
  return _enabled;
}

export function onDebugToggle(fn: (on: boolean) => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Loads the persisted toggle. Goes through the attached executor
 *  (engine's mutex) when available; falls back to a direct read only
 *  when no executor is attached yet — at startup the engine itself
 *  awaits this BEFORE attaching, but we still don't want to race the
 *  hydrate transaction, so the engine now calls us AFTER hydrate
 *  completes (see lib/sync/bootstrap.ts).
 */
export async function loadDebugFlag(): Promise<boolean> {
  try {
    let raw: string | null = null;
    if (_exec) {
      const rows = await _exec.select<{ value_json: string }>(
        'SELECT value_json FROM settings WHERE key = ?',
        [SETTINGS_KEY],
      );
      raw = rows[0]?.value_json ?? null;
    } else {
      const db = await initDb();
      const rows = await db.select<{ value_json: string }[]>(
        'SELECT value_json FROM settings WHERE key = ?',
        [SETTINGS_KEY],
      );
      raw = rows[0]?.value_json ?? null;
    }
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
    if (_exec) {
      await _exec.execute(
        `INSERT INTO settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = datetime('now')`,
        [SETTINGS_KEY, on ? 'true' : 'false'],
      );
    } else {
      const db = await initDb();
      await db.execute(
        `INSERT INTO settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = datetime('now')`,
        [SETTINGS_KEY, on ? 'true' : 'false'],
      );
    }
  } catch (err) {
    logger.warn('debug', 'persist toggle failed', { err: String(err) });
  }
  for (const fn of _listeners) fn(_enabled);
}

/**
 * Sprint 11.3 — pilot reproduced UI freeze with dbQueueDepth 111 and
 * outboxWorker logs entirely absent. Cause: each instrumented call site
 * fires 1-3 dbg() calls, each enqueueing an INSERT INTO device_logs
 * through the same FIFO mutex that serializes order writes, pulls and
 * outbox pushes. Under load (a fast operator clicking) the mutex
 * couldn't drain, persistBatch transactions never finished, the
 * outbox worker never got its turn to read pendingDue, and push to the
 * backend never happened. Diagnostic logging starved the production path.
 *
 * Fix: dbg() writes only to an in-memory ring buffer. A background
 * flusher batches up to N rows into ONE multi-INSERT every FLUSH_MS so
 * the mutex sees exactly one transaction per flush window.
 *
 * dbgError() still uses the buffer (no exception to the rule — errors
 * during a UI freeze must not deadlock harder), but the buffer is
 * priority-flushed when an error lands so we don't lose context.
 */
const FLUSH_MS = 5_000;
const FLUSH_MAX_BATCH = 200;
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _flushInflight = false;

function persist(
  level: 'debug' | 'info' | 'warn' | 'error',
  source: string,
  message: string,
  ctx?: unknown,
): void {
  const ctxJson = ctx == null ? null : JSON.stringify(ctx);
  _buffer.push([level, source, message, ctxJson]);
  if (_buffer.length > BUFFER_LIMIT) _buffer.shift();
  if (level === 'error' && _exec) {
    // Errors are rare — flush eagerly so the next "Trimite loguri"
    // includes them even if the 5s flusher hasn't fired yet.
    void flushBufferToDb();
  }
}

async function flushBufferToDb(): Promise<void> {
  if (_flushInflight) return;
  if (_exec == null) return;
  if (_buffer.length === 0) return;
  _flushInflight = true;
  try {
    const exec = _exec;
    while (_buffer.length > 0 && _exec === exec) {
      const batch = _buffer.splice(0, Math.min(_buffer.length, FLUSH_MAX_BATCH));
      // One transaction → one mutex acquisition → no per-row enqueue churn.
      try {
        await exec.transaction(async (tx) => {
          for (const [level, source, message, ctxJson] of batch) {
            await tx.execute(
              'INSERT INTO device_logs (level, source, message, context_json) VALUES (?, ?, ?, ?)',
              [level, source, message, ctxJson],
            );
          }
        });
      } catch {
        // If the batch fails, drop it — diagnostic logging must NEVER
        // backpressure the production path, even on retry.
      }
    }
  } finally {
    _flushInflight = false;
  }
}

/** Engine startup hands us its executor once hydrate has committed.
 *  Starts the periodic flusher so dbg() messages eventually land in
 *  device_logs without per-call mutex contention. */
export function attachExecutorForLogs(exec: SqlExecutor): void {
  _exec = exec;
  if (_flushTimer == null) {
    _flushTimer = setInterval(() => {
      void flushBufferToDb();
    }, FLUSH_MS);
  }
  // Drain the boot-time buffer in the background, but with the same
  // batched-transaction strategy.
  void flushBufferToDb();
}

export function detachExecutorForLogs(): void {
  _exec = null;
  if (_flushTimer != null) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
}

/** Force a flush now (e.g. before "Trimite loguri" so the latest
 *  in-memory lines reach device_logs before the shipper reads it). */
export async function flushDebugBufferNow(): Promise<void> {
  await flushBufferToDb();
}

/** Emit a debug line (no-op when disabled). Always also goes to console.
 *  Use this from instrumented call sites; cost when disabled is one
 *  branch + early return. */
export function dbg(source: string, message: string, ctx?: unknown): void {
  if (!_enabled) return;
  // eslint-disable-next-line no-console
  console.log(`[POS-DBG] ${source}: ${message}`, ctx ?? '');
  void persist('debug', source, message, ctx);
}

/** Always emit, regardless of toggle. For errors we want to see even
 *  when the user forgot to enable debug — they'll be flushed on the
 *  next "Trimite loguri" press. */
export function dbgError(source: string, message: string, ctx?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[POS-ERR] ${source}: ${message}`, ctx ?? '');
  void persist('error', source, message, ctx);
}

/** Wrap a function so each call logs entry/exit/exception when debug is
 *  ON. Errors always get logged (even when OFF) under `dbgError`. */
export function instrument<Args extends unknown[], R>(
  source: string,
  name: string,
  fn: (...args: Args) => Promise<R> | R,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const t0 = Date.now();
    if (_enabled) dbg(source, `${name} ▶`, { args: safeArgs(args) });
    try {
      const out = await fn(...args);
      if (_enabled) {
        dbg(source, `${name} ◀ ${Date.now() - t0}ms`, { result: safeResult(out) });
      }
      return out;
    } catch (err) {
      dbgError(source, `${name} ✖ ${Date.now() - t0}ms`, {
        message: (err as Error)?.message ?? String(err),
        stack: (err as Error)?.stack,
        args: safeArgs(args),
      });
      throw err;
    }
  };
}

/** Stringify-friendly version of args — strips functions, caps depth. */
function safeArgs(args: unknown[]): unknown {
  return args.map((a) => safeResult(a));
}

function safeResult(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 3) return '<truncated>';
  if (typeof value === 'function') return '<function>';
  if (Array.isArray(value)) {
    if (value.length > 20) return `<array length=${value.length}>`;
    return value.map((v) => safeResult(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (count++ > 30) {
        out['...'] = `<truncated, ${Object.keys(value as object).length} keys>`;
        break;
      }
      out[k] = safeResult(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) {
    return value.slice(0, 480) + `…<+${value.length - 480}>`;
  }
  return value;
}

export function readInitialised(): boolean {
  return _initialised;
}
