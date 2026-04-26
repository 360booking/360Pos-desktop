/**
 * SqlExecutor backed by tauri-plugin-sql.
 *
 * The plugin already serialises calls per-connection, so we model
 * `transaction()` as a literal BEGIN/COMMIT pair. Nested transactions
 * are not supported (and not used by the sync engine).
 */
import type Database from '@tauri-apps/plugin-sql';
import type { SqlExecutor } from './executor';

export function tauriExecutor(db: Database): SqlExecutor {
  const exec: SqlExecutor = {
    async select<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return db.select<T[]>(sql, params);
    },
    async execute(sql: string, params: unknown[] = []) {
      const r = await db.execute(sql, params);
      return { rowsAffected: r.rowsAffected, lastInsertId: r.lastInsertId };
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      await db.execute('BEGIN');
      try {
        const out = await fn(exec);
        await db.execute('COMMIT');
        return out;
      } catch (err) {
        try {
          await db.execute('ROLLBACK');
        } catch {
          // swallow — surface the original error
        }
        throw err;
      }
    },
  };
  return exec;
}
