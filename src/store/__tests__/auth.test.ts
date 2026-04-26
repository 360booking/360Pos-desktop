/**
 * Sprint 10 — auth store tests.
 *
 * The store calls into @/lib/auth/storage which itself reaches into the
 * Tauri SQLite plugin. We mock the storage module so the tests stay
 * pure logic and pass under vitest's node environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/storage', () => ({
  readAuthFile: vi.fn(async () => null),
  writeAuthFile: vi.fn(async () => {}),
  clearAuthFile: vi.fn(async () => {}),
  getDeviceId: vi.fn(async () => 'mock-device-id'),
}));

import { useAuthStore, isAccessTokenStale, readAccessToken } from '../auth';
import * as storage from '@/lib/auth/storage';

const baseLogin = {
  accessToken: 'access-aaaa',
  refreshToken: 'refresh-bbbb',
  tokenType: 'bearer',
  expiresIn: 900,
  user: { id: 'u1', email: 'w@example.com', displayName: 'Waiter', role: 'waiter' },
  tenant: {
    id: 't1',
    slug: 'demo',
    name: 'Demo',
    timezone: 'Europe/Bucharest',
    currency: 'RON',
  },
  restaurants: [
    { id: 'r1', name: 'Main', isDefault: true },
    { id: 'r2', name: 'Patio', isDefault: false },
  ],
  device: { deviceId: 'd1', deviceName: 'Desktop', registered: true },
};

beforeEach(() => {
  useAuthStore.setState({
    status: 'unauthenticated',
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
  });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAuthStore.setLogin', () => {
  it('marks the store authenticated and auto-selects the default restaurant', () => {
    useAuthStore.getState().setLogin(baseLogin, false);
    const s = useAuthStore.getState();
    expect(s.status).toBe('authenticated');
    expect(s.user?.email).toBe('w@example.com');
    expect(s.selectedRestaurant?.id).toBe('r1');
    expect(s.accessToken).toBe('access-aaaa');
  });

  it('persists refresh token only when stayLoggedIn=true', async () => {
    useAuthStore.getState().setLogin(baseLogin, true);
    // microtask drain for the void writeAuthFile inside setLogin
    await Promise.resolve();
    expect(storage.writeAuthFile).toHaveBeenCalledTimes(1);
    expect(storage.clearAuthFile).not.toHaveBeenCalled();

    vi.clearAllMocks();
    useAuthStore.getState().setLogin(baseLogin, false);
    await Promise.resolve();
    expect(storage.writeAuthFile).not.toHaveBeenCalled();
    expect(storage.clearAuthFile).toHaveBeenCalledTimes(1);
  });
});

describe('useAuthStore.selectRestaurant', () => {
  it('switches the selected restaurant when the id is in the list', () => {
    useAuthStore.getState().setLogin(baseLogin, false);
    useAuthStore.getState().selectRestaurant('r2');
    expect(useAuthStore.getState().selectedRestaurant?.id).toBe('r2');
  });

  it('ignores unknown restaurant ids', () => {
    useAuthStore.getState().setLogin(baseLogin, false);
    useAuthStore.getState().selectRestaurant('does-not-exist');
    expect(useAuthStore.getState().selectedRestaurant?.id).toBe('r1');
  });
});

describe('useAuthStore.clear', () => {
  it('wipes all in-memory auth state and removes persisted token', async () => {
    useAuthStore.getState().setLogin(baseLogin, true);
    await Promise.resolve();
    await useAuthStore.getState().clear();
    const s = useAuthStore.getState();
    expect(s.status).toBe('unauthenticated');
    expect(s.accessToken).toBeNull();
    expect(s.refreshToken).toBeNull();
    expect(s.user).toBeNull();
    expect(s.selectedRestaurant).toBeNull();
    expect(storage.clearAuthFile).toHaveBeenCalled();
  });
});

describe('isAccessTokenStale', () => {
  it('returns true when there is no token', () => {
    expect(isAccessTokenStale()).toBe(true);
  });

  it('returns false when the token has > 30s left', () => {
    useAuthStore.getState().setLogin(baseLogin, false); // expiresIn=900
    expect(isAccessTokenStale()).toBe(false);
  });

  it('returns true when the token is within 30s of expiry', () => {
    useAuthStore.setState({
      accessToken: 'x',
      accessTokenExpiresAt: Date.now() + 10_000,
    });
    expect(isAccessTokenStale()).toBe(true);
  });
});

describe('readAccessToken', () => {
  it('returns the in-memory access token without exposing the store', () => {
    useAuthStore.getState().setLogin(baseLogin, false);
    expect(readAccessToken()).toBe('access-aaaa');
  });
});
