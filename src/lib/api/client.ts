/**
 * HTTP client for the backend.
 *
 * Sprint 3: hits /api/pos/* (no longer the legacy /api/health). The
 * shared axios instance is reused by HttpSyncTransport so config and
 * auth header live in one place.
 */
import axios, { type AxiosInstance } from 'axios';
import { getConfig } from '@/lib/config';

let _client: AxiosInstance | null = null;

export function getApiClient(): AxiosInstance {
  if (!_client) {
    _client = axios.create({
      baseURL: getConfig().backendUrl,
      timeout: 5_000,
      headers: { 'X-Pos-Client': 'pos-desktop' },
    });
  }
  return _client;
}

export interface HealthResponse {
  ok: boolean;
  latencyMs: number;
  serverVersion?: string;
  posApiVersion?: string;
  serverTime?: string;
}

export async function health(): Promise<HealthResponse> {
  const t0 = performance.now();
  try {
    const r = await getApiClient().get('/api/pos/health', { timeout: 3_000 });
    const latencyMs = Math.round(performance.now() - t0);
    return {
      ok: r.status >= 200 && r.status < 300,
      latencyMs,
      serverVersion: r.data?.app_version,
      posApiVersion: r.data?.pos_api_version,
      serverTime: r.data?.server_time,
    };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - t0) };
  }
}
