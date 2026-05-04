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
import { rememberHealth } from '@/lib/api/healthLast';
import { recordFailure, recordSuccess } from '@/lib/reachability';

declare module 'axios' {
  interface AxiosRequestConfig {
    /** Set true on /api/pos/auth/* routes to skip Authorization + refresh logic. */
    skipAuth?: boolean;
    /**
     * Skip the *pre-emptive* refresh check on the request interceptor —
     * the request still attaches the current access token, just doesn't
     * touch local SQLite (auth-store.applyTokens) before sending. Used
     * for time-critical operations (fiscal Z/X/storno) where a busy
     * SQLite mutex would otherwise stall the request behind a hydrate
     * or pull batch and surface as a 15s axios timeout even though the
     * backend is fine. The 401 retry path stays active, so an actually
     * expired token still gets refreshed once.
     */
    skipAuthRefresh?: boolean;
  }
  interface InternalAxiosRequestConfig {
    skipAuth?: boolean;
    skipAuthRefresh?: boolean;
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
    // 15s default — 5s was too aggressive for real-world POS networks
    // (residential wifi to Hetzner). Backend itself answers in <50ms on
    // the polling endpoints, but transient jitter would routinely take
    // requests past 5s and break sync/alerts/health in batches. Heavier
    // calls (fiscal Z, periodic-memory, storno) override per-request.
    timeout: 15_000,
    headers: { 'X-Pos-Client': 'pos-desktop' },
  });

  _client.interceptors.request.use(async (cfg) => {
    if (!shouldAttachAuth(cfg)) return cfg;
    // Pre-emptively refresh if the access token is within 30s of expiry.
    // Cheap insurance against the very common pattern of triggering a
    // burst of POS requests at the moment a token rolls over. SKIPPED
    // when the caller passes skipAuthRefresh:true — the 401 path still
    // catches a truly expired token and retries once.
    if (
      !cfg.skipAuthRefresh &&
      isAccessTokenStale() &&
      useAuthStore.getState().refreshToken
    ) {
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
    (resp) => {
      // Faza 2 — every successful round-trip resets the offline counter
      // and flips us back online if we were marked offline.
      recordSuccess();
      return resp;
    },
    async (error: AxiosError) => {
      const cfg = error.config as InternalAxiosRequestConfig | undefined;
      const status = error.response?.status;
      // Feed the reachability detector. It internally ignores 4xx so a
      // business rejection (cancelled order, validation) doesn't trip
      // the offline banner.
      recordFailure(error);
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

export type HealthErrorClass =
  | 'network'
  | 'cors'
  | 'timeout'
  | 'http_status'
  | 'invalid_url'
  | 'unknown';

export interface HealthResponse {
  ok: boolean;
  latencyMs: number;
  /** URL the request actually went to — surfaced in LoginScreen for support. */
  resolvedUrl: string;
  serverVersion?: string;
  posApiVersion?: string;
  serverTime?: string;
  /** Set when ok=false. Class + short message + status (if any). */
  errorClass?: HealthErrorClass;
  errorDetail?: string;
  errorStatus?: number;
}

function composeHealthUrl(baseUrl: string): string {
  // Defend against config.json setting backendUrl with a trailing slash
  // ("https://360booking.ro/") which would axios-resolve to
  // "https://360booking.ro/api/pos/health" anyway, but the visible URL
  // we display in diagnostics should be unambiguous.
  const trimmed = (baseUrl || '').replace(/\/+$/, '');
  return `${trimmed}/api/pos/health`;
}

function classifyAxiosError(err: unknown): {
  cls: HealthErrorClass;
  detail: string;
  status?: number;
} {
  if (!axios.isAxiosError(err)) {
    return { cls: 'unknown', detail: String(err) };
  }
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) {
    return { cls: 'timeout', detail: err.message };
  }
  if (err.response) {
    return {
      cls: 'http_status',
      detail: `HTTP ${err.response.status}`,
      status: err.response.status,
    };
  }
  // No response object means the browser layer dropped the response —
  // CORS rejection looks like this in a Tauri webview, as does a real
  // network failure. We can't tell them apart from JS without parsing
  // the dev console; in the wild, "Network Error" + Tauri webview is
  // overwhelmingly CORS, so we surface that hint.
  if (err.request && /Network Error/i.test(err.message)) {
    return { cls: 'cors', detail: 'Network Error (likely CORS or DNS)' };
  }
  return { cls: 'network', detail: err.message };
}

export async function health(): Promise<HealthResponse> {
  const t0 = performance.now();
  const baseUrl = getConfig().backendUrl;
  const url = composeHealthUrl(baseUrl);
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    const out: HealthResponse = {
      ok: false,
      latencyMs: 0,
      resolvedUrl: url,
      errorClass: 'invalid_url',
      errorDetail: `backendUrl invalid: ${baseUrl || '<empty>'}`,
    };
    rememberHealth(out);
    return out;
  }
  try {
    const r = await getApiClient().get('/api/pos/health', {
      timeout: 8_000,
      skipAuth: true,
    });
    const latencyMs = Math.round(performance.now() - t0);
    const out: HealthResponse = {
      ok: r.status >= 200 && r.status < 300,
      latencyMs,
      resolvedUrl: url,
      serverVersion: r.data?.app_version,
      posApiVersion: r.data?.pos_api_version,
      serverTime: r.data?.server_time,
    };
    rememberHealth(out);
    return out;
  } catch (err) {
    const c = classifyAxiosError(err);
    logger.warn('http', 'health probe failed', {
      url,
      cls: c.cls,
      detail: c.detail,
      status: c.status,
    });
    const out: HealthResponse = {
      ok: false,
      latencyMs: Math.round(performance.now() - t0),
      resolvedUrl: url,
      errorClass: c.cls,
      errorDetail: c.detail,
      errorStatus: c.status,
    };
    rememberHealth(out);
    return out;
  }
}
