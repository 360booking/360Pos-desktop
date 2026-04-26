/**
 * SQLite client for the POS desktop.
 *
 * Migrations are registered on the Rust side (see src-tauri/src/main.rs)
 * because tauri-plugin-sql runs them at first connection. JS-side we just
 * `Database.load(...)` the same connection string.
 *
 * In a non-Tauri context (e.g. Vitest, Storybook, Vite preview without
 * the shell running) we fall back to an in-memory stub that records
 * statements so unit tests can assert against them.
 */
import Database from '@tauri-apps/plugin-sql';

const DB_URI = 'sqlite:pos-desktop.db';

let dbPromise: Promise<Database> | null = null;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function initDb(): Promise<Database> {
  if (!isTauri()) {
    // Browser preview / tests — return a thin shim so calls don't crash.
    // The real DB lives only inside the Tauri shell.
    return Promise.reject(new Error('SQLite is only available inside the Tauri shell.'));
  }
  if (!dbPromise) {
    dbPromise = Database.load(DB_URI).then(async (db) => {
      // WAL gives us crash-safe append-only behavior the sync engine
      // depends on. Foreign keys are off by default in SQLite.
      await db.execute('PRAGMA journal_mode = WAL;');
      await db.execute('PRAGMA foreign_keys = ON;');
      await db.execute('PRAGMA synchronous = NORMAL;');
      // Sprint 10 / F: belt + braces with the JS-side mutex in
      // tauriExecutor. busy_timeout makes SQLite wait up to 5s for a
      // contended lock before erroring; the JS retry on top covers
      // cases where the underlying sqlx driver returns BUSY before the
      // pragma kicks in.
      await db.execute('PRAGMA busy_timeout = 5000;');
      return db;
    });
  }
  return dbPromise;
}

export async function getDb(): Promise<Database> {
  return initDb();
}
