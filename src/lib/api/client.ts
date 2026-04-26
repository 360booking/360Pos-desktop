/**
 * HTTP client for the backend.
 *
 * Sprint 3: hits /api/pos/* (no longer the legacy /api/health). Sprint
 * 10: every non-auth request gets `Authorization: Bearer <accessToken>`
 * automatically. On 401 we try the refresh token once; if that also
 * fails we drop the in-memory tokens and surface the original error so
 * the React tree bounces back to LoginScreen.
 *
 * Routes that explicitly opt out (login / refresh / logout) pass
 * `skipAuth: true` in the request config.
 */
import axios, { type AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { isAccessTokenStale, readAccessToken, useAuthStore } from '@/store/auth';
import { refresh as refreshAccessToken } from '@/lib/api/auth';

declare module 'axios' {
  interface AxiosRequestConfig {
    /** Set true on /api/pos/auth/* routes to skip Authorization + refresh logic. */
    skipAuth?: boolean;
  }
  interface InternalAxiosRequestConfig {
    skipAuth?: boolean;
    /** Internal: prevents infinite retry loops in the 401 interceptor. */
    _retried?: boolean;
  }
}

let _client: AxiosInstance | null = null;
let _refreshInflight: Promise<string | null> | null = null;

/**
 * Single-flight refresh. If a request triggers refresh while another
 * is already in progress, both await the same promise so we never
 * double-spend the refresh token.
 */
async function performRefreshOnce(): Promise<string | null> {
  if (_refreshInflight) return _refreshInflight;
  const stored = useAuthStore.getState().refreshToken;
  if (!stored) return null;
  _refreshInflight = (async () => {
    try {
      const out = await refreshAccessToken(stored);
      useAuthStore.getState().applyTokens(out.accessToken, out.expiresIn);
      return out.accessToken;
    } catch (err) {
      logger.warn('http', 'refresh failed — clearing auth', { err: String(err) });
      await useAuthStore.getState().clear();
      return null;
    } finally {
      _refreshInflight = null;
    }
  })();
  return _refreshInflight;
}

function shouldAttachAuth(cfg: InternalAxiosRequestConfig): boolean {
  if (cfg.skipAuth) return false;
  const url = String(cfg.url ?? '');
  if (url.includes('/api/pos/auth/')) return false;
  return true;
}

export function getApiClient(): AxiosInstance {
  if (_client) return _client;
  _client = axios.create({
    baseURL: getConfig().backendUrl,
    timeout: 5_000,
    headers: { 'X-Pos-Client': 'pos-desktop' },
  });

  _client.interceptors.request.use(async (cfg) => {
    if (!shouldAttachAuth(cfg)) return cfg;
    // Pre-emptively refresh if the access token is within 30s of expiry.
    // Cheap insurance against the very common pattern of triggering a
    // burst of POS requests at the moment a token rolls over.
    if (isAccessTokenStale() && useAuthStore.getState().refreshToken) {
      await performRefreshOnce();
    }
    const token = readAccessToken();
    if (token) {
      cfg.headers = cfg.headers ?? {};
      cfg.headers.Authorization = `Bearer ${token}`;
    }
    return cfg;
  });

  _client.interceptors.response.use(
    (resp) => resp,
    async (error: AxiosError) => {
      const cfg = error.config as InternalAxiosRequestConfig | undefined;
      const status = error.response?.status;
      if (!cfg || cfg._retried || cfg.skipAuth || status !== 401) {
        return Promise.reject(error);
      }
      if (!shouldAttachAuth(cfg)) return Promise.reject(error);
      cfg._retried = true;
      const newToken = await performRefreshOnce();
      if (!newToken) {
        // Refresh failed; auth was already cleared by performRefreshOnce.
        return Promise.reject(error);
      }
      cfg.headers = cfg.headers ?? ({} as InternalAxiosRequestConfig['headers']);
      (cfg.headers as Record<string, string>).Authorization = `Bearer ${newToken}`;
      return _client!.request(cfg);
    },
  );

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
    const r = await getApiClient().get('/api/pos/health', {
      timeout: 3_000,
      skipAuth: true,
    });
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
