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

const SETTINGS_KEY = 'debug.enabled';

let _enabled = false;
let _initialised = false;
const _listeners = new Set<(on: boolean) => void>();

export function isDebugEnabled(): boolean {
  return _enabled;
}

export function onDebugToggle(fn: (on: boolean) => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** One-shot read at engine startup. Safe to call before initDb resolves —
 *  it'll initialise the toggle to OFF and resync once the DB is ready. */
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

/** Internal: write a row to the local `device_logs` table. Failures
 *  are swallowed — debug logging must NEVER block the caller. */
async function persist(
  level: 'debug' | 'info' | 'warn' | 'error',
  source: string,
  message: string,
  ctx?: unknown,
): Promise<void> {
  try {
    const db = await initDb();
    await db.execute(
      'INSERT INTO device_logs (level, source, message, context_json) VALUES (?, ?, ?, ?)',
      [level, source, message, ctx == null ? null : JSON.stringify(ctx)],
    );
  } catch {
    // swallow — diagnostic logging is best-effort
  }
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
