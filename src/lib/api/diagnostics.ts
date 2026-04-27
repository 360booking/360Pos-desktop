/**
 * Diagnostics dump uploader — Sprint 11.
 *
 * Posts a batch of `device_logs` rows to /api/pos/diagnostics/dump so
 * support can read them server-side. Unlike the existing
 * /api/pos/devices/{deviceId}/logs endpoint, this one accepts shipments
 * even when device pairing is broken — exactly when support needs the
 * data most.
 */
import { getApiClient } from './client';

export interface DumpLogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
  context?: Record<string, unknown> | null;
  createdAt?: string | null;
}

export interface DumpRequest {
  logs: DumpLogLine[];
  deviceId?: string | null;
  appVersion?: string | null;
}

export interface DumpResponse {
  accepted: number;
}

export async function postDiagnosticsDump(body: DumpRequest): Promise<DumpResponse> {
  const r = await getApiClient().post<DumpResponse>(
    '/api/pos/diagnostics/dump',
    body,
  );
  return r.data;
}
