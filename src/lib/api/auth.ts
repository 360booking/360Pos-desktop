/**
 * POS desktop auth API client (Sprint 10).
 *
 * Talks to the new /api/pos/auth/* endpoints. Returns plain objects
 * the auth store can persist; never logs tokens.
 */
import axios, { AxiosError } from 'axios';

import { getApiClient } from './client';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export interface AuthTenant {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  currency: string;
}

export interface AuthRestaurant {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface AuthDevice {
  deviceId: string;
  deviceName: string | null;
  registered: boolean;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  user: AuthUser;
  tenant: AuthTenant;
  restaurants: AuthRestaurant[];
  device: AuthDevice;
}

export interface LoginInput {
  email: string;
  password: string;
  deviceId: string;
  deviceName?: string;
  appVersion?: string;
  hostname?: string;
  os?: string;
}

export class LoginError extends Error {
  status: number;
  detail: string;
  retryAfterSeconds?: number;

  constructor(status: number, detail: string, retryAfterSeconds?: number) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function pickDetail(err: AxiosError, fallback: string): string {
  const data = err.response?.data as { detail?: unknown } | undefined;
  if (data && typeof data.detail === 'string') return data.detail;
  return fallback;
}

/** Login. Throws LoginError on non-2xx so the caller can show a toast. */
export async function login(body: LoginInput): Promise<LoginResponse> {
  try {
    const r = await getApiClient().post<LoginResponse>(
      '/api/pos/auth/login',
      body,
      { skipAuth: true } as never,
    );
    return r.data;
  } catch (e) {
    const ax = e as AxiosError;
    const status = ax.response?.status ?? 0;
    if (status === 429) {
      const retryAfter = Number(ax.response?.headers?.['retry-after'] ?? '60');
      throw new LoginError(429, 'Prea multe încercări. Reîncearcă mai târziu.', retryAfter);
    }
    if (status === 401) throw new LoginError(401, pickDetail(ax, 'Email sau parolă greșite.'));
    if (status === 403) throw new LoginError(403, pickDetail(ax, 'Cont fără acces la POS.'));
    if (status === 503) throw new LoginError(503, 'Serviciul de login este indisponibil.');
    if (!ax.response) throw new LoginError(0, 'Backend-ul nu răspunde. Verifică conexiunea.');
    throw new LoginError(status, pickDetail(ax, 'Login eșuat.'));
  }
}

/** Refresh a single access token. Returns the new token + expires_in (seconds). */
export async function refresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const r = await getApiClient().post<{ accessToken: string; expiresIn: number }>(
    '/api/pos/auth/refresh',
    { refreshToken },
    { skipAuth: true } as never,
  );
  return r.data;
}

/** Best-effort logout. Always resolves — caller treats failure as already-logged-out. */
export async function logout(refreshToken: string | null): Promise<void> {
  if (!refreshToken) return;
  try {
    await getApiClient().post(
      '/api/pos/auth/logout',
      { refreshToken },
      { skipAuth: true, timeout: 3_000 } as never,
    );
  } catch (e) {
    if (axios.isAxiosError(e) && (e.response?.status ?? 0) >= 500) {
      // server side hiccup — token may still be valid, but the user is
      // intentionally logging out so we discard locally anyway.
    }
  }
}
