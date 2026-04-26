/**
 * Application configuration.
 *
 * Two sources, merged with later sources winning:
 *   1) bundled defaults (this file)
 *   2) Vite envs (VITE_*) — for dev overrides
 *   3) %APPDATA%/360booking-pos/config.json — written by Settings UI
 *
 * Sprint 0 wires (1) and (2). Disk persistence lands in Sprint 5 alongside
 * the Settings → Devices screen.
 */

export type AdapterChoice<T extends string> = T | 'simulator';

export type SyncTransportMode = 'memory' | 'http';

export interface AppConfig {
  backendUrl: string;
  tenantId: string | null;
  tenantSlug: string | null;
  restaurantId: string | null;
  deviceId: string | null;
  fiscalAdapter: AdapterChoice<'datecs'>;
  paymentAdapter: AdapterChoice<'bt-ecr'>;
  printerAdapter: AdapterChoice<'escpos'>;
  fiscalComPort: string | null;
  paymentComPort: string | null;
  printerComPort: string | null;
  simulatorMode: boolean;
  buildProfile: 'demo' | 'tenant';
  /** Sprint 3: 'memory' = in-memory shim (default), 'http' = real backend. */
  syncTransportMode: SyncTransportMode;
}

const DEFAULTS: AppConfig = {
  backendUrl: 'http://localhost:8000',
  tenantId: null,
  tenantSlug: null,
  restaurantId: null,
  deviceId: null,
  fiscalAdapter: 'simulator',
  paymentAdapter: 'simulator',
  printerAdapter: 'simulator',
  fiscalComPort: null,
  paymentComPort: null,
  printerComPort: null,
  simulatorMode: true,
  buildProfile: 'demo',
  syncTransportMode: 'memory',
};

function fromEnv(): Partial<AppConfig> {
  const e = (k: string): string | undefined =>
    (import.meta.env as Record<string, string | undefined>)[k];
  const profile = (e('POS_BUILD_PROFILE') ?? 'demo') as 'demo' | 'tenant';
  const explicitMode = e('VITE_SYNC_TRANSPORT_MODE') as SyncTransportMode | undefined;
  // Heuristic: tenant profile + a backend URL ⇒ default to http.
  // Anything else (demo / no backend) ⇒ memory shim.
  const inferredMode: SyncTransportMode =
    explicitMode ??
    (profile === 'tenant' && e('VITE_BACKEND_URL') ? 'http' : 'memory');
  return {
    backendUrl: e('VITE_BACKEND_URL') ?? undefined,
    tenantSlug: e('VITE_TENANT_SLUG') ?? null,
    restaurantId: e('VITE_RESTAURANT_ID') ?? null,
    buildProfile: profile,
    simulatorMode: profile !== 'tenant',
    syncTransportMode: inferredMode,
  };
}

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;
  const env = fromEnv();
  _config = {
    ...DEFAULTS,
    ...Object.fromEntries(
      Object.entries(env).filter(([, v]) => v !== undefined),
    ),
  } as AppConfig;
  return _config;
}

export function getConfig(): AppConfig {
  return loadConfig();
}
