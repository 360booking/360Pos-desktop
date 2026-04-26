/**
 * Background bootstrap scheduler — Sprint 4 / 1.
 *
 * Runs `runBootstrap()` every 30 minutes after the initial hydrate,
 * skipping the tick when the device is offline so we don't pile up
 * failed fetches. The scheduler is intentionally simple: a `setInterval`
 * with an "is a run in flight" guard. Backoff on failure is left to the
 * inner HTTP transport — this loop just retries on the next tick.
 *
 * Non-disruption rules are enforced by `hydrateCatalog`, not here:
 *   - line items keep their price/VAT snapshot;
 *   - missing products become is_active=0 (still visible on open orders).
 */
import { runBootstrap, type RunBootstrapResult } from './runBootstrap';
import type { SqlExecutor } from '@/lib/db/executor';

export const BOOTSTRAP_REFRESH_MS = 30 * 60 * 1000; // 30 min

export interface BootstrapSchedulerOptions {
  exec: SqlExecutor;
  restaurantId?: string | null;
  /** Returns false when the desktop should skip the network call. */
  isOnline?: () => boolean;
  /** Telemetry hook — called after every attempt. */
  onResult?: (r: RunBootstrapResult) => void;
  /** Override the cadence in tests; defaults to 30 minutes. */
  intervalMs?: number;
}

export interface BootstrapScheduler {
  /** Stop the periodic refresh. */
  stop: () => void;
  /** Force a refresh now (used by the operator's "Refresh" button). */
  runNow: () => Promise<RunBootstrapResult>;
}

export function startBootstrapScheduler(
  opts: BootstrapSchedulerOptions,
): BootstrapScheduler {
  const interval = opts.intervalMs ?? BOOTSTRAP_REFRESH_MS;
  const isOnline = opts.isOnline ?? (() => true);

  let inFlight: Promise<RunBootstrapResult> | null = null;

  async function tick(force: boolean): Promise<RunBootstrapResult> {
    if (inFlight) return inFlight;
    if (!force && !isOnline()) {
      const skipped: RunBootstrapResult = {
        ok: false,
        error: new Error('OFFLINE_SKIPPED'),
      };
      opts.onResult?.(skipped);
      return skipped;
    }
    const p = runBootstrap({ exec: opts.exec, restaurantId: opts.restaurantId });
    inFlight = p;
    try {
      const r = await p;
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
