/**
 * Auth store — Sprint 10.
 *
 * Holds the runtime auth state: access token (memory only), refresh
 * token (memory + optionally persisted to disk if "Stay signed in" was
 * checked), and the user/tenant/restaurant identity returned by the
 * login endpoint.
 *
 * The access token NEVER appears in toString output, never goes through
 * the diagnostics snapshot, and never lives on disk. The refresh token
 * is persisted to %APPDATA%/360booking-pos/auth.json (or the OS
 * equivalent) only when stayLoggedIn=true. We do not encrypt with
 * stronghold yet — see Sprint 11 follow-up for OS keychain integration.
 */
import { create } from 'zustand';

import type {
  AuthDevice,
  AuthRestaurant,
  AuthTenant,
  AuthUser,
  LoginResponse,
} from '@/lib/api/auth';
import { logger } from '@/lib/logger';
import { getDeviceId, readAuthFile, writeAuthFile, clearAuthFile } from '@/lib/auth/storage';

export type AuthStatus = 'booting' | 'unauthenticated' | 'authenticated';

export interface AuthState {
  status: AuthStatus;

  accessToken: string | null;
  refreshToken: string | null;
  /** When the access token expires (epoch ms). null when missing. */
  accessTokenExpiresAt: number | null;
  stayLoggedIn: boolean;

  user: AuthUser | null;
  tenant: AuthTenant | null;
  restaurants: AuthRestaurant[];
  selectedRestaurant: AuthRestaurant | null;
  device: AuthDevice | null;

  /** Non-null when the last login attempt failed. UI clears on next attempt. */
  lastError: string | null;

  /**
   * Replace the in-memory tokens (used by the axios interceptor after
   * a successful refresh). Persists to disk if stayLoggedIn=true.
   */
  applyTokens: (accessToken: string, expiresIn: number, refreshToken?: string | null) => void;

  /** Save the full login response. Persists to disk if stayLoggedIn=true. */
  setLogin: (resp: LoginResponse, stayLoggedIn: boolean) => void;

  /** Pick a restaurant from the post-login list. */
  selectRestaurant: (id: string) => void;

  /** Wipe all in-memory auth state + on-disk persisted refresh token. */
  clear: () => Promise<void>;

  /** Best-effort restore of refresh token from disk on app launch. */
  hydrateFromDisk: () => Promise<void>;

  setError: (msg: string | null) => void;
}

const INITIAL: Omit<
  AuthState,
  'applyTokens' | 'setLogin' | 'selectRestaurant' | 'clear' | 'hydrateFromDisk' | 'setError'
> = {
  status: 'booting',
  accessToken: null,
  refreshToken: null,
  accessTokenExpiresAt: null,
  stayLoggedIn: false,
  user: null,
  tenant: null,
  restaurants: [],
  selectedRestaurant: null,
  device: null,
  lastError: null,
};

function expiresAt(expiresIn: number): number {
  return Date.now() + expiresIn * 1_000;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  ...INITIAL,

  applyTokens: (accessToken, expiresIn, refreshToken) => {
    set({
      accessToken,
      accessTokenExpiresAt: expiresAt(expiresIn),
      refreshToken: refreshToken ?? get().refreshToken,
    });
    if (get().stayLoggedIn) {
      void writeAuthFile({
        refreshToken: get().refreshToken ?? '',
        userEmail: get().user?.email ?? null,
        savedAt: Date.now(),
      }).catch((err) => logger.warn('auth', 'persist failed', { err: String(err) }));
    }
  },

  setLogin: (resp, stayLoggedIn) => {
    const restaurants = resp.restaurants ?? [];
    const selected =
      restaurants.find((r) => r.isDefault) ?? restaurants[0] ?? null;
    set({
      status: 'authenticated',
      accessToken: resp.accessToken,
      accessTokenExpiresAt: expiresAt(resp.expiresIn),
      refreshToken: resp.refreshToken,
      stayLoggedIn,
      user: resp.user,
      tenant: resp.tenant,
      restaurants,
      selectedRestaurant: selected,
      device: resp.device,
      lastError: null,
    });
    if (stayLoggedIn) {
      void writeAuthFile({
        refreshToken: resp.refreshToken,
        userEmail: resp.user.email,
        savedAt: Date.now(),
      }).catch((err) => logger.warn('auth', 'persist failed', { err: String(err) }));
    } else {
      void clearAuthFile().catch(() => undefined);
    }
  },

  selectRestaurant: (id) => {
    const r = get().restaurants.find((x) => x.id === id);
    if (r) set({ selectedRestaurant: r });
  },

  clear: async () => {
    await clearAuthFile().catch(() => undefined);
    set({ ...INITIAL, status: 'unauthenticated' });
  },

  hydrateFromDisk: async () => {
    try {
      const stored = await readAuthFile();
      if (stored?.refreshToken) {
        set({
          refreshToken: stored.refreshToken,
          stayLoggedIn: true,
          status: 'unauthenticated',
        });
        return;
      }
    } catch (err) {
      logger.warn('auth', 'hydrate failed', { err: String(err) });
    }
    set({ status: 'unauthenticated' });
  },

  setError: (msg) => set({ lastError: msg }),
}));

/** Convenience selector — used by the axios interceptor (no React). */
export function readAccessToken(): string | null {
  return useAuthStore.getState().accessToken;
}

/** Convenience: is the access token within 30s of expiry. */
export function isAccessTokenStale(): boolean {
  const exp = useAuthStore.getState().accessTokenExpiresAt;
  if (!exp) return true;
  return Date.now() >= exp - 30_000;
}

export function authDeviceId(): Promise<string> {
  return getDeviceId();
}
