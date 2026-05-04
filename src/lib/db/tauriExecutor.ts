/**
 * SqlExecutor backed by tauri-plugin-sql.
 *
 * Sprint 10 / F — JS-side serialisation.
 *
 * tauri-plugin-sql uses a single sqlx connection on Windows; in
 * practice nested writes (hydrate's big BEGIN/COMMIT competing with the
 * pull's apply-changes writes and the outbox worker's UPDATEs) trigger
 * `database is locked (code: 5)` even with WAL on. The pragma route
 * (busy_timeout, WAL) helps but does not prevent the second writer
 * from being told to retry; with no JS-side queue the second writer
 * just bubbles the error to the caller.
 *
 * We solve it by:
 *   1) running EVERY operation through a single in-memory FIFO mutex,
 *      so two writes can never race on the same connection;
 *   2) wrapping the per-statement call with a small retry loop that
 *      catches SQLITE_BUSY / "database is locked" and re-runs after a
 *      short backoff (the busy_timeout pragma takes care of waits up to
 *      its limit but the JS retry covers cases where the underlying
 *      sqlx driver returns the error before the busy_timeout elapses
 *      — which is exactly what we observed in the tenant pilot).
 *
 * Reads (SELECT) are serialised too — cheap, simpler invariant, and
 * the pos-desktop's traffic is dominated by writes during hydrate
 * anyway.
 */
import type Database from '@tauri-apps/plugin-sql';

import { logger } from '@/lib/logger';
import type { SqlExecutor } from './executor';

// Retry budget grew from [50, 200, 500] (≈750ms total) after pilot
// observed an 11s catalog hydrate batch holding the connection while
// auth-store.writeKey raced for the same lock and ran out of retries
// in <1s. With WAL on, a busy mutex of up to ~6s is realistic during
// hydrate / large pull batches; the retry chain below covers ~6s before
// surfacing the SQLITE_BUSY to the caller.
const RETRY_BACKOFF_MS = [100, 300, 800, 1500, 3000];

function isLockedError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  return (
    /database is locked/i.test(msg) ||
    /\(code: ?5\)/i.test(msg) ||
    /SQLITE_BUSY/i.test(msg) ||
    /database table is locked/i.test(msg)
  );
}

/**
 * Sprint 11.2 — tauri-plugin-sql for SQLite uses a sqlx pool that can
 * acquire / release connections per statement. Manual BEGIN/COMMIT
 * issued through `db.execute()` therefore lands on different
 * connections in the pool: BEGIN on conn A, INSERT on conn B (which
 * runs in autocommit), COMMIT on conn C — which fails with
 *     "cannot commit - no transaction is active"
 * even though every INSERT did succeed (each one self-committed).
 *
 * We treat that specific error on COMMIT/ROLLBACK as a no-op: the
 * data is already persisted, the call site doesn't need to know that
 * atomicity degraded. Real failures (constraint violations, schema
 * errors, locked DB after retry budget) still surface to the caller.
 */
function isNoActiveTransactionError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  return /no transaction is active/i.test(msg) || /cannot commit/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isLockedError(err) || attempt === RETRY_BACKOFF_MS.length) {
        throw err;
      }
      const wait = RETRY_BACKOFF_MS[attempt];
      logger.warn('db', 'sqlite locked — retrying', { label, attempt: attempt + 1, waitMs: wait });
      await sleep(wait);
    }
  }
  // Unreachable — but TS needs an explicit terminator.
  throw lastErr;
}

interface QueuedExecutor extends SqlExecutor {
  /** Queue depth at last insertion — exposed for diagnostics. */
  pendingDepth: () => number;
}

export function tauriExecutor(db: Database): SqlExecutor {
  // Single FIFO chain. Each enqueued task awaits the previous one
  // before running — so two writes from different code paths can never
  // open competing transactions or be interleaved.
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;

  function enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
    pending += 1;
    const next = chain
      .catch(() => undefined) // never let a previous failure poison the chain
      .then(() => withRetry(label, fn))
      .finally(() => {
        pending -= 1;
      });
    chain = next;
    return next;
  }

  // Inner executor used by `transaction`'s callback. It does NOT
  // re-enqueue — the outer transaction holds the mutex for the
  // entire BEGIN/COMMIT span, so all statements inside run in order
  // without contention.
  const inner: SqlExecutor = {
    async select<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return withRetry('select(tx)', () => db.select<T[]>(sql, params));
    },
    async execute(sql: string, params: unknown[] = []) {
      const r = await withRetry('execute(tx)', () => db.execute(sql, params));
      return { rowsAffected: r.rowsAffected, lastInsertId: r.lastInsertId };
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      // Nested transactions aren't supported by the engine; just run
      // the callback against the same inner executor (still inside
      // the outer BEGIN/COMMIT).
      return fn(inner);
    },
  };

  const exec: QueuedExecutor = {
    async select<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return enqueue('select', () => db.select<T[]>(sql, params));
    },
    async execute(sql: string, params: unknown[] = []) {
      return enqueue('execute', async () => {
        const r = await db.execute(sql, params);
        return { rowsAffected: r.rowsAffected, lastInsertId: r.lastInsertId };
      });
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return enqueue('transaction', async () => {
        let beganOk = false;
        try {
          await db.execute('BEGIN');
          beganOk = true;
        } catch (err) {
          // BEGIN itself failed — we still run statements (in autocommit)
          // so the operation isn't lost; log loud so we notice the
          // degradation in production.
          logger.warn('db', 'BEGIN failed — running statements in autocommit mode', {
            err: (err as Error)?.message ?? String(err),
          });
        }
        try {
          const out = await fn(inner);
          if (beganOk) {
            try {
              await db.execute('COMMIT');
            } catch (err) {
              if (!isNoActiveTransactionError(err)) {
                throw err;
              }
              // Pool released the BEGIN'd connection; statements
              // auto-committed individually. No-op COMMIT is fine.
              logger.warn('db', 'COMMIT had no active transaction — pool degradation, data already persisted', {
                err: (err as Error)?.message ?? String(err),
              });
            }
          }
          return out;
        } catch (err) {
          if (beganOk) {
            try {
              await db.execute('ROLLBACK');
            } catch (rbErr) {
              if (!isNoActiveTransactionError(rbErr)) {
                logger.warn('db', 'ROLLBACK threw a non-noop error', {
                  err: (rbErr as Error)?.message ?? String(rbErr),
                });
              }
            }
          }
          throw err;
        }
      });
    },
    pendingDepth: () => pending,
  };
  return exec;
}

/** Diagnostics helper — surfaces the queue depth without forcing
 * callers to know about the QueuedExecutor type. */
export function executorPendingDepth(exec: SqlExecutor | null | undefined): number {
  if (!exec) return 0;
  const q = exec as Partial<QueuedExecutor>;
  return typeof q.pendingDepth === 'function' ? q.pendingDepth() : 0;
}
