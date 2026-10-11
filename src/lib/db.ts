/**
 * SQLite client for the POS desktop.
 *
 * Etapa 5 — "database is locked" fix. Statements no longer go through
 * tauri-plugin-sql's sqlx pool (BEGIN/COMMIT could land on different pooled
 * connections and leave a write transaction dangling). Instead:
 *
 *   1. tauri-plugin-sql is loaded ONCE, only so it runs the migrations
 *      registered in src-tauri/src/lib.rs (its `_sqlx_migrations` table
 *      stays authoritative), then its pool is closed;
 *   2. every statement goes to the Rust single-connection store
 *      (`db_select` / `db_execute` / `db_begin` / `db_commit` /
 *      `db_rollback`, src-tauri/src/localdb.rs): WAL, busy_timeout,
 *      BEGIN IMMEDIATE on the same connection;
 *   3. JS keeps ONE FIFO for all callers (tauriExecutor.enqueueDb), so a
 *      transaction can never interleave with a stray write.
 *
 * In a non-Tauri context (Vitest, Vite preview) initDb() rejects, as before.
 */
import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';

import { enqueueDb, type StatementDb } from './db/tauriExecutor';

const DB_URI = 'sqlite:pos-desktop.db';

export interface DesktopDb {
  select<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
}

let dbPromise: Promise<DesktopDb> | null = null;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Direct (un-queued) statements — only for code already holding the FIFO. */
export const rawDb: StatementDb = {
  async select<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
    return (await invoke('db_select', { sql, params })) as T;
  },
  async execute(sql: string, params: unknown[] = []) {
    return invoke<{ rowsAffected: number; lastInsertId?: number }>('db_execute', { sql, params });
  },
  begin: () => invoke<void>('db_begin'),
  commit: () => invoke<void>('db_commit'),
  rollback: () => invoke<void>('db_rollback'),
};

/** Same statements, but in line behind any running transaction. */
const queuedDb: DesktopDb = {
  select<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
    return enqueueDb('select', () => rawDb.select<T>(sql, params));
  },
  execute(sql: string, params: unknown[] = []) {
    return enqueueDb('execute', () => rawDb.execute(sql, params));
  },
};

async function runMigrations(): Promise<void> {
  const legacy = await Database.load(DB_URI);
  try {
    await legacy.close();
  } catch {
    // Closing is only hygiene — the pool is idle either way.
  }
}

export async function initDb(): Promise<DesktopDb> {
  if (!isTauri()) {
    // Browser preview / tests — the real DB lives only inside the Tauri shell.
    return Promise.reject(new Error('SQLite is only available inside the Tauri shell.'));
  }
  if (!dbPromise) {
    dbPromise = (async () => {
      await runMigrations();
      // A transaction left open by a previous page instance (reload in the
      // middle of a hydrate) is rolled back before anything else runs.
      await invoke('db_reset_session');
      return queuedDb;
    })();
    dbPromise.catch(() => {
      // Let the next caller retry instead of caching a failure forever.
      dbPromise = null;
    });
  }
  return dbPromise;
}

export async function getDb(): Promise<DesktopDb> {
  return initDb();
}
