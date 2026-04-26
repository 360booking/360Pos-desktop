/**
 * Bridge to the optional native sidecars.
 *
 * Sprint 0: only `fiscalBridgeStatus()` — does the binary exist alongside
 * the app? Real lifecycle (spawn, JSON-RPC, restart on crash) is in Sprint 5.
 */
import { invoke } from '@tauri-apps/api/core';

export interface FiscalBridgeStatus {
  present: boolean;
  path: string | null;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function fiscalBridgeStatus(): Promise<FiscalBridgeStatus> {
  if (!isTauri()) return { present: false, path: null };
  return invoke<FiscalBridgeStatus>('fiscal_bridge_status');
}

export async function appDataDir(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string>('app_data_dir');
}
