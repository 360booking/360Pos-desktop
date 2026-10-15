/**
 * Native calls used by the guide. Every one is an EXISTING command the
 * service form already uses (same runtime-config row, same enrolment
 * commands), except `fiscal_list_ports_detailed`, which only adds friendly
 * port names and falls back to the plain list on an older build.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { listSerialPorts } from '@/adapters/fiscal/runtime-config';

import type { DetectProgress, DetectReport, PortInfo, ProbeReport } from './logic';

export interface ClaimResponse {
  device_token: string;
  bridge_id: string;
  tenant_id: string;
  websocket_url: string;
}

export interface SavedBridgeCredentials {
  server_base_url: string;
  websocket_url: string;
  device_token: string;
  bridge_id: string;
  tenant_id: string;
  printer_model: string | null;
  device_id: string | null;
  claimed_at: string | null;
  updated_at: string | null;
}

export interface BridgeState {
  configured: boolean;
  connected: boolean;
  bridge_id: string | null;
  tenant_id: string | null;
  printer_model: string | null;
  last_heartbeat_at: number | null;
  last_error: string | null;
  close_code: number | null;
  /** Server refused the token (admin „Deconectează” / newer enrolment). */
  revoked?: boolean;
}

export const DEFAULT_SERVER = 'https://360booking.ro';

export async function listPorts(): Promise<PortInfo[]> {
  try {
    const detailed = await invoke<PortInfo[]>('fiscal_list_ports_detailed');
    if (Array.isArray(detailed)) return detailed;
  } catch {
    /* older build without the command — plain names below */
  }
  const names = await listSerialPorts();
  return names.map((name) => ({ name }));
}

export const guideApi = {
  probe: (port: string, baud: number) => invoke<ProbeReport>('fiscal_probe', { port, baud }),
  /** „Caută casa de marcat”: STATUS only, saves port + baud + dialect when found. */
  detect: (includeOthers: boolean) => invoke<DetectReport>('fiscal_detect_register', { includeOthers, save: true }),
  cancelDetect: () => invoke<void>('fiscal_detect_cancel'),
  onDetectProgress: (fn: (p: DetectProgress) => void): Promise<UnlistenFn> =>
    listen<DetectProgress>('fiscal-detect-progress', (e) => fn(e.payload)),
  testConnection: () => invoke<{ ok: boolean; detail: string }>('fiscal_test_connection'),
  savedCredentials: () => invoke<SavedBridgeCredentials | null>('fiscal_get_saved_bridge_credentials'),
  clearCredentials: () => invoke<void>('fiscal_clear_saved_bridge_credentials'),
  bridgeState: () => invoke<BridgeState>('fiscal_bridge_state'),
  claim: (serverBaseUrl: string, code: string, printerModel: string, deviceId: string | null) =>
    invoke<ClaimResponse>('fiscal_bridge_claim', { serverBaseUrl, code, printerModel, deviceId }),
  run: (websocketUrl: string, deviceToken: string, printerModel: string) =>
    invoke<void>('fiscal_bridge_run', { websocketUrl, deviceToken, printerModel }),
};
