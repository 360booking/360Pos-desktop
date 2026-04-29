/**
 * Test-only SqlExecutor backed by sql.js. Lets unit tests run real SQL
 * against the production migration files instead of pattern-matching
 * SQL strings in JS.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database } from 'sql.js';

import type { SqlExecutor } from '../executor';

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = join(dirname(__filename), '..', '..', '..', 'sql', 'migrations');

function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export interface SqlJsHarness {
  db: Database;
  exec: SqlExecutor;
  close(): void;
}

export async function makeSqlJsExec(): Promise<SqlJsHarness> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const f of listMigrations()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    db.exec(sql);
  }

  const exec: SqlExecutor = {
    async select<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
      const stmt = db.prepare(sql);
      stmt.bind((params ?? []) as never);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      stmt.free();
      return out;
    },
    async execute(sql: string, params?: unknown[]) {
      const stmt = db.prepare(sql);
      stmt.bind((params ?? []) as never);
      stmt.step();
      stmt.free();
      return { rowsAffected: db.getRowsModified() } as never;
    },
    async transaction(fn) {
      // sql.js doesn't enforce isolation but supports BEGIN/COMMIT.
      db.exec('BEGIN');
      try {
        const r = await fn(this);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return {
    db,
    exec,
    close: () => db.close(),
  };
}
