/**
 * Smoke test for the SQLite migration pipeline. Catches the class of
 * bug we hit on the first Windows pilot: migration 6 used to ship a
 * `CREATE TABLE IF NOT EXISTS fiscal_attempts` that no-op'd against
 * the legacy table from 0001 (different schema) and the subsequent
 * CREATE INDEX on a column that did not exist failed with
 * "no such column: fiscal_device_id".
 *
 * Each migration script is applied in order against a fresh sql.js
 * in-memory DB, then we assert that every column the Rust persist +
 * runtime_config layer reads is actually present on the resulting
 * tables.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database } from 'sql.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..');

function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function colNames(db: Database, table: string): string[] {
  const res = db.exec(`PRAGMA table_info(${table})`);
  if (res.length === 0) return [];
  // sql.js: { columns: [...], values: [[...], ...] }
  // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
  const nameIdx = res[0].columns.indexOf('name');
  return res[0].values.map((row) => String(row[nameIdx]));
}

function tableNames(db: Database): string[] {
  const res = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  if (res.length === 0) return [];
  return res[0].values.map((row) => String(row[0]));
}

describe('SQLite migrations', () => {
  let db: Database;
  let files: string[] = [];

  beforeAll(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    files = listMigrations();
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      db.exec(sql);
    }
  });

  afterAll(() => {
    db.close();
  });

  it('applies every .sql in order without error', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        '0001_init.sql',
        '0006_fiscal_attempts.sql',
        '0007_fiscal_runtime_config.sql',
      ]),
    );
  });

  it('fiscal_attempts has the Sprint 11 columns the Rust layer needs', () => {
    const names = colNames(db, 'fiscal_attempts');
    for (const expected of [
      'id',
      'mutation_id',
      'order_local_id',
      'device_id',
      'fiscal_device_id',
      'provider',
      'printer_model',
      'serial_port',
      'baud',
      'protocol_variant',
      'status',
      'fiscal_number',
      'fiscal_date',
      'raw_request',
      'raw_response',
      'parsed_response',
      'error_code',
      'error_message',
      'status_bytes',
      'created_at',
      'updated_at',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('fiscal_runtime_config has the columns the Settings UI writes', () => {
    const names = colNames(db, 'fiscal_runtime_config');
    for (const expected of [
      'id',
      'provider',
      'serial_port',
      'baud',
      'protocol_variant',
      'operator',
      'operator_password',
      'printer_model',
      'use_rust',
      'enable_raw_logs',
      'vat_map_json',
      'cmd_codes_json',
      'updated_at',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('fiscal_runtime_config rejects rows with id != 1', () => {
    db.exec(
      "INSERT INTO fiscal_runtime_config (id, provider) VALUES (1, 'simulator')",
    );
    expect(() =>
      db.exec(
        "INSERT INTO fiscal_runtime_config (id, provider) VALUES (2, 'datecs_dp25')",
      ),
    ).toThrow();
    db.exec('DELETE FROM fiscal_runtime_config');
  });

  it('payment_attempts + station_pairings exist after 0006', () => {
    const names = tableNames(db);
    expect(names).toContain('payment_attempts');
    expect(names).toContain('station_pairings');
  });
});
