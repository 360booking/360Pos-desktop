/**
 * Thin structured logger.
 *
 * - Writes to console for the dev tools view.
 * - In Sprint 0 it does NOT yet persist to SQLite — that hooks in once
 *   the DB is opened in App.tsx and we have a stable event_id ordering
 *   to flush against. The persistence path is added in Sprint 2 with
 *   the sync engine.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, source: string, message: string, ctx?: unknown): void {
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](
    `[${level}] ${source}: ${message}`,
    ctx ?? '',
  );
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
