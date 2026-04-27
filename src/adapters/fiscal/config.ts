// C12 — TS facade over the Rust `fiscal_pull_config` / `fiscal_get_cached_config`
// commands. Centralized so the panel + any future startup hook share one shape.
import { invoke } from '@tauri-apps/api/core';

export interface FiscalConfigBundle {
  bridge_id: string;
  tenant_id: string;
  printer_model: string | null;
  /** Resolved protocol config — `cmd_codes`, `protocol`, `encoding_offset`, etc. */
  protocol: Record<string, unknown>;
}

export async function pullFiscalConfig(
  serverBaseUrl: string,
  deviceToken: string,
): Promise<FiscalConfigBundle> {
  return invoke<FiscalConfigBundle>('fiscal_pull_config', {
    serverBaseUrl,
    deviceToken,
  });
}

export async function getCachedFiscalConfig(): Promise<FiscalConfigBundle | null> {
  return invoke<FiscalConfigBundle | null>('fiscal_get_cached_config');
}
