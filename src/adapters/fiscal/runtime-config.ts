// Runtime config facade — UI form ↔ SQLite store.
//
// IMPORTANT: writes go through the SAME `tauri-plugin-sql` pool the rest of
// the sync engine uses (initDb()), NOT through a separate rusqlite handle in
// Rust. The earlier shape (invoke 'fiscal_set_runtime_config') opened a
// second SQLite handle which fought the sqlx pool — under load the writer
// pool would hold a transaction open across IPC tick, the rusqlite write
// would time out at busy_timeout, and the Settings save returned
// "database is locked". Keeping all writers on one pool sidesteps that.
//
// Reads still go through the Rust command because `fiscal_use_rust_enabled`
// is called from React effects before initDb() resolves on cold start
// (gated by a NO_CREATE open in Rust to avoid the migration race).
//
// Wire shape stays snake_case to mirror the Rust DTO so log lines + DB
// dumps line up regardless of which side wrote the row.

import { invoke } from '@tauri-apps/api/core';
import { getDb } from '@/lib/db';

export interface FiscalRuntimeConfig {
  provider: string | null;
  serial_port: string | null;
  baud: number | null;
  protocol_variant: string | null;
  operator: string | null;
  operator_password: string | null;
  printer_model: string | null;
  use_rust: boolean | null;
  enable_raw_logs: boolean | null;
  vat_map_json: string | null;
  cmd_codes_json: string | null;
  updated_at?: string | null;
}

export async function getFiscalRuntimeConfig(): Promise<FiscalRuntimeConfig> {
  return invoke<FiscalRuntimeConfig>('fiscal_get_runtime_config');
}

export async function setFiscalRuntimeConfig(
  config: FiscalRuntimeConfig,
): Promise<FiscalRuntimeConfig> {
  // Use the shared sqlx pool. UPSERT mirrors what `runtime_config::write`
  // does in Rust; the only difference is which SQLite handle issues it.
  const db = await getDb();
  await db.execute(
    `INSERT INTO fiscal_runtime_config (
        id, provider, serial_port, baud, protocol_variant,
        operator, operator_password, printer_model,
        use_rust, enable_raw_logs,
        vat_map_json, cmd_codes_json, updated_at
     ) VALUES (
        1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, datetime('now')
     )
     ON CONFLICT(id) DO UPDATE SET
        provider          = excluded.provider,
        serial_port       = excluded.serial_port,
        baud              = excluded.baud,
        protocol_variant  = excluded.protocol_variant,
        operator          = excluded.operator,
        operator_password = excluded.operator_password,
        printer_model     = excluded.printer_model,
        use_rust          = excluded.use_rust,
        enable_raw_logs   = excluded.enable_raw_logs,
        vat_map_json      = excluded.vat_map_json,
        cmd_codes_json    = excluded.cmd_codes_json,
        updated_at        = datetime('now')`,
    [
      config.provider,
      config.serial_port,
      config.baud,
      config.protocol_variant,
      config.operator,
      config.operator_password,
      config.printer_model,
      config.use_rust === null ? null : config.use_rust ? 1 : 0,
      config.enable_raw_logs === null ? null : config.enable_raw_logs ? 1 : 0,
      config.vat_map_json,
      config.cmd_codes_json,
    ],
  );
  // Round-trip through the Rust read so the caller gets exactly what the
  // Rust effective_* helpers will see on the next print/test invocation.
  return invoke<FiscalRuntimeConfig>('fiscal_get_runtime_config');
}

export async function listSerialPorts(): Promise<string[]> {
  return invoke<string[]>('fiscal_list_ports');
}
