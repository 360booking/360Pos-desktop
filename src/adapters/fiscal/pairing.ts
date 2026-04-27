// B11 — TS facade over Rust station_pairings commands. Audit Q2: 1:1:1
// strict (one station = one fiscal device + one payment terminal). Schema
// permits more later via nullable FK; UI/flow stays single-pair in Sprint 1.
import { invoke } from '@tauri-apps/api/core';

export interface StationPairing {
  device_id: string;
  fiscal_device_id: string | null;
  payment_terminal_id: string | null;
  fiscal_provider: string | null;
  payment_provider: string | null;
}

export async function getStationPairing(
  deviceId: string,
): Promise<StationPairing | null> {
  return invoke<StationPairing | null>('fiscal_get_station_pairing', {
    deviceId,
  });
}

export async function upsertStationPairing(row: StationPairing): Promise<void> {
  await invoke('fiscal_upsert_station_pairing', { row });
}

export async function clearStationPairing(deviceId: string): Promise<void> {
  await invoke('fiscal_clear_station_pairing', { deviceId });
}
