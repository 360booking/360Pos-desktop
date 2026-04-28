/**
 * Thin structured logger.
 *
 * - Writes to console for the dev tools view.
 * - Keeps the last 500 entries in a ring buffer so the in-app
 *   Diagnostic tab can render a live tail without round-tripping to
 *   the Rust log file. Sprint 11 added the persistence to SQLite
 *   (`debugLog.ts`); the ring buffer is the read-side window into
 *   what just happened.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Verbose mode toggle — when off (default), pos.* debug logs are dropped
 * from the ring buffer + console to keep production noise low. When on,
 * everything goes through. Operator can flip this from Settings →
 * Diagnostic. Persisted in localStorage so the setting survives reloads.
 *
 * info/warn/error are NEVER suppressed regardless of the toggle.
 */
const VERBOSE_KEY = 'pos.logger.verbose';

function readVerbose(): boolean {
  try {
    return localStorage.getItem(VERBOSE_KEY) === 'true';
  } catch {
    return false;
  }
}

let _verbose: boolean = readVerbose();

export function setVerboseLogging(on: boolean): void {
  _verbose = on;
  try {
    localStorage.setItem(VERBOSE_KEY, on ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

export function isVerboseLogging(): boolean {
  return _verbose;
}

export interface LogEntry {
  ts: string;
  level: Level;
  source: string;
  message: string;
  ctx?: unknown;
}

const MAX_ENTRIES = 500;
const _entries: LogEntry[] = [];
const _listeners = new Set<() => void>();

export function getRecentLogEntries(limit?: number): LogEntry[] {
  if (limit === undefined || limit >= _entries.length) return _entries.slice();
  return _entries.slice(_entries.length - limit);
}

export function clearLogEntries(): void {
  _entries.length = 0;
  for (const fn of _listeners) {
    try { fn(); } catch { /* swallow */ }
  }
}

/** Subscribe to ring-buffer updates. Returns an unsubscribe fn. */
export function subscribeLogs(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

function emit(level: Level, source: string, message: string, ctx?: unknown): void {
  // Drop debug-level pos.* logs unless verbose mode is on. Keeps the
  // ring buffer + console clean in production while letting the operator
  // flip a switch in Diagnostic when they need full traces.
  if (level === 'debug' && !_verbose) return;
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](
    `[${level}] ${source}: ${message}`,
    ctx ?? '',
  );
  _entries.push({ ts: new Date().toISOString(), level, source, message, ctx });
  if (_entries.length > MAX_ENTRIES) {
    _entries.splice(0, _entries.length - MAX_ENTRIES);
  }
  for (const fn of _listeners) {
    try { fn(); } catch { /* swallow */ }
  }
}

export const logger = {
  debug: (source: string, message: string, ctx?: unknown) =>
    emit('debug', source, message, ctx),
  info: (source: string, message: string, ctx?: unknown) =>
    emit('info', source, message, ctx),
  warn: (source: string, message: string, ctx?: unknown) =>
    emit('warn', source, message, ctx),
  error: (source: string, message: string, ctx?: unknown) =>
    emit('error', source, message, ctx),
};
