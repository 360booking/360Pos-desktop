/**
 * Heartbeat scheduler — Sprint 8.
 *
 * Every HEARTBEAT_INTERVAL_MS the desktop POSTs a short status report
 * to /api/pos/devices/{deviceId}/heartbeat. Two reasons:
 *
 *   1. Device-level liveness — the backend's pos_devices table tracks
 *      last_seen_at + status so support can tell which stations are
 *      online without screen-sharing.
 *   2. Lock renewal — `renewLocksFor` carries the order_ids this
 *      desktop currently owns. The backend bumps owner_expires_at on
 *      rows where it IS the owner AND is_open = true, so a busy
 *      operator never loses a table to the 10-minute TTL while
 *      they're still actively running it.
 *
 * If the heartbeat call fails, we don't retry inside the tick — the
 * next interval will just send a fresh request. The status bar
 * surfaces the last failure timestamp so support can spot a wedged
 * heartbeat without digging into logs.
 */
import { getApiClient } from '@/lib/api/client';
import { getConfig } from '@/lib/config';
import { useRemote } from '@/store/remote';
import { useDeviceStatus } from '@/store/deviceStatus';

export const HEARTBEAT_INTERVAL_MS = 60_000; // 60 seconds

export interface HeartbeatResult {
  ok: boolean;
  /** Server-reported renewed count (currently echoed via 200). */
  attemptedRenewals: number;
  error?: Error;
}

export interface HeartbeatSchedulerOptions {
  isOnline?: () => boolean;
  intervalMs?: number;
  onResult?: (r: HeartbeatResult) => void;
}

export interface HeartbeatScheduler {
  stop: () => void;
  runNow: () => Promise<HeartbeatResult>;
}

function ownedOrderIds(deviceId: string | null): string[] {
  if (!deviceId) return [];
  const remote = useRemote.getState().orders;
  return remote
    .filter((o) => o.is_open === 1 && o.owner_device_id === deviceId)
    .map((o) => o.id);
}

async function tickOnce(): Promise<HeartbeatResult> {
  const cfg = getConfig();
  if (!cfg.deviceId) {
    return { ok: false, attemptedRenewals: 0, error: new Error('UNPAIRED') };
  }
  const status = useDeviceStatus.getState();
  const ids = ownedOrderIds(cfg.deviceId);
  try {
    await getApiClient().post(`/api/pos/devices/${encodeURIComponent(cfg.deviceId)}/heartbeat`, {
      onlineStatus: 'online',
      queueDepth: status.queueDepth,
      failedCount: status.sync.failed,
      deadCount: status.sync.dead,
      appVersion: '0.1.0',
      renewLocksFor: ids,
    });
    return { ok: true, attemptedRenewals: ids.length };
  } catch (err) {
    return { ok: false, attemptedRenewals: ids.length, error: err as Error };
  }
}

export function startHeartbeatScheduler(
  opts: HeartbeatSchedulerOptions = {},
): HeartbeatScheduler {
  const interval = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const isOnline = opts.isOnline ?? (() => true);

  let inFlight: Promise<HeartbeatResult> | null = null;

  async function tick(force: boolean): Promise<HeartbeatResult> {
    if (inFlight) return inFlight;
    if (!force && !isOnline()) {
      const skipped: HeartbeatResult = {
        ok: false,
        attemptedRenewals: 0,
        error: new Error('OFFLINE_SKIPPED'),
      };
      opts.onResult?.(skipped);
      return skipped;
    }
    inFlight = tickOnce();
    try {
      const r = await inFlight;
      opts.onResult?.(r);
      return r;
    } finally {
      inFlight = null;
    }
  }

  const handle = setInterval(() => {
    void tick(false);
  }, interval);

  return {
    stop: () => clearInterval(handle),
    runNow: () => tick(true),
  };
}
