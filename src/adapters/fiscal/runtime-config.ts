// Runtime config facade — UI form ↔ Rust SQLite store. Keeps the snake_case
// Rust shape on the wire (matches src-tauri/src/fiscal/runtime_config.rs) and
// converts to camelCase only inside the panel component.
//
// All four fields can be null when no row exists yet; the UI shows that as
// blank inputs and "use_rust=false" so the simulator stays in charge until the
// operator explicitly saves a Datecs config.

import { invoke } from '@tauri-apps/api/core';

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
  return invoke<FiscalRuntimeConfig>('fiscal_set_runtime_config', { config });
}

export async function listSerialPorts(): Promise<string[]> {
  return invoke<string[]>('fiscal_list_ports');
}
