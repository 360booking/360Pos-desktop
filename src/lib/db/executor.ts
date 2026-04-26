/**
 * Thin database abstraction.
 *
 * Production binds to tauri-plugin-sql. Tests bind to a JS-side SQLite
 * (sql.js, better-sqlite3, or a hand-rolled in-memory shim — Sprint 2
 * uses the hand-rolled shim to keep the dependency graph tiny).
 *
 * The surface mirrors the subset of @tauri-apps/plugin-sql we actually
 * call: parameterised select / execute, plus a transactional helper.
 */

export interface SqlExecutor {
  /** SELECT — returns rows as plain objects. */
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /** INSERT/UPDATE/DELETE/PRAGMA — returns lastInsertId + rowsAffected. */
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;

  /**
   * Run `fn` inside a transaction. The implementation must guarantee
   * that, on throw, all writes performed inside `fn` are rolled back.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
