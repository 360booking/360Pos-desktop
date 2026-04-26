/**
 * Diagnostics snapshot — Sprint 9.5.
 *
 * Collects the minimum data we need to triage a Windows pilot issue
 * without screen-sharing. NO secrets are ever included: deviceToken,
 * JWT bearer, OAuth refresh tokens are masked or excluded entirely.
 *
 * The snapshot is shaped as a flat record so it copy/pastes nicely
 * into a Slack thread or email.
 */
import { getConfig } from '@/lib/config';
import { useDeviceStatus } from '@/store/deviceStatus';
import { useCatalog } from '@/store/catalog';
import { useRecovery } from '@/store/recovery';
import { useRemote } from '@/store/remote';
import { getSyncEngine } from '@/lib/sync/bootstrap';

export interface DiagnosticsSnapshot {
  // ─── App / config ─────────────────────────────────────────────────
  appVersion: string;
  buildProfile: string;
  syncTransportMode: string;
  simulatorMode: boolean;
  backendUrl: string;
  deviceId: string;
  tenantId: string | null;
  restaurantId: string | null;

  // ─── User (from bootstrap snapshot) ───────────────────────────────
  userRole: string | null;
  userName: string | null;

  // ─── Local DB ─────────────────────────────────────────────────────
  /** Filename only (full path lives at %APPDATA%\360booking-pos\). */
  sqliteDbName: string;

  // ─── Sync state ───────────────────────────────────────────────────
  queueDepth: number;
  syncFailed: number;
  syncDead: number;
  lastBootstrapSuccessAt: string | null;
  lastBootstrapStaleMinutes: number | null;

  // ─── Operator-facing status ───────────────────────────────────────
  recoveryOpenCount: number;
  remoteOpenOrders: number;
  remoteActiveTickets: number;

  // ─── Adapters (from deviceStatus store) ───────────────────────────
  fiscalAdapter: string;
  paymentAdapter: string;
  printerAdapter: string;
  online: boolean;

  // ─── Engine sanity ────────────────────────────────────────────────
  engineRunning: boolean;
  generatedAt: string;
}

/** Tokens / secrets policy: keep them out entirely. We never include
 * the raw config object — only fields we explicitly opt into. */
export function snapshot(): DiagnosticsSnapshot {
  const cfg = getConfig();
  const ds = useDeviceStatus.getState();
  const cat = useCatalog.getState();
  const rec = useRecovery.getState();
  const rem = useRemote.getState();
  const engine = getSyncEngine();

  let staleMin: number | null = null;
  if (cat.lastSuccessfulAt) {
    const ts = Date.parse(cat.lastSuccessfulAt);
    if (!Number.isNaN(ts)) {
      staleMin = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
    }
  }

  return {
    appVersion: '0.1.0',
    buildProfile: cfg.buildProfile,
    syncTransportMode: cfg.syncTransportMode,
    simulatorMode: cfg.simulatorMode,
    backendUrl: cfg.backendUrl,
    deviceId: cfg.deviceId ?? '<unpaired>',
    tenantId: cfg.tenantId,
    restaurantId: cfg.restaurantId,

    userRole: cat.currentUser?.role ?? null,
    userName: cat.currentUser?.name ?? null,

    sqliteDbName: 'pos-desktop.db',

    queueDepth: ds.queueDepth,
    syncFailed: ds.sync.failed,
    syncDead: ds.sync.dead,
    lastBootstrapSuccessAt: cat.lastSuccessfulAt,
    lastBootstrapStaleMinutes: staleMin,

    recoveryOpenCount: rec.rows.length,
    remoteOpenOrders: rem.orders.filter((o) => o.is_open === 1).length,
    remoteActiveTickets: rem.tickets.length,

    fiscalAdapter: cfg.fiscalAdapter,
    paymentAdapter: cfg.paymentAdapter,
    printerAdapter: cfg.printerAdapter,
    online: ds.online,

    engineRunning: engine !== null,
    generatedAt: new Date().toISOString(),
  };
}

/** Belt-and-braces masking helper: any value that looks like a JWT
 * (three base64 segments separated by `.`) or a long opaque token
 * (>32 chars, no spaces) gets reduced to a head/tail preview.
 *
 * Used by the "Copy" path so a user pasting into Slack doesn't leak
 * a token. The DiagnosticsSnapshot fields above are already
 * token-free; this is the second line of defence for any field a
 * future Sprint accidentally adds without thinking. */
export function maskSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return maskString(value);
  }
  if (Array.isArray(value)) {
    return value.map(maskSecrets);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Mask by-key for known sensitive names too.
      if (/(token|secret|password|jwt|bearer|authorization)/i.test(k)) {
        out[k] = typeof v === 'string' ? maskString(v, true) : '<redacted>';
      } else {
        out[k] = maskSecrets(v);
      }
    }
    return out;
  }
  return value;
}

function maskString(s: string, force = false): string {
  // JWT-like: 3 base64-ish segments separated by dot.
  const jwtRe = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  if (jwtRe.test(s)) {
    return `${s.slice(0, 6)}…${s.slice(-4)} <jwt>`;
  }
  // Long opaque token (force-on by-key, otherwise 40+ chars no spaces).
  if (force || (s.length >= 40 && /^\S+$/.test(s) && !s.includes(' '))) {
    return `${s.slice(0, 4)}…${s.slice(-2)} <redacted>`;
  }
  return s;
}

/** Convenience: serialise a masked snapshot to a paste-friendly string. */
export function snapshotAsText(): string {
  const masked = maskSecrets(snapshot()) as Record<string, unknown>;
  const lines = Object.entries(masked).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return [`360booking POS desktop diagnostics`, `=================================`, ...lines].join('\n');
}
