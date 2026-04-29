/**
 * localPaymentSyncWorker — Faza 2.
 *
 * Periodically drains `local_payment_outbox` rows that the desktop
 * collected while offline. Each row carries:
 *   - `idempotency_key` — sent as the `Idempotency-Key` header so a
 *     retry returns the same outcome from the backend (Faza 1 contract);
 *   - `external_fiscal_receipt_number` — the bon emitted locally by the
 *     DP-25X; the backend attaches it instead of issuing a new one;
 *   - `fiscalization_source = 'device_offline'` — provenance flag.
 *
 * Lifecycle per row:
 *   pending_sync → syncing → synced              (on 200)
 *                          ↘ pending_sync (next_retry_at)  (on transient)
 *                          ↘ failed                          (on 4xx)
 *
 * The worker pauses when reachability flips false. As soon as a REST
 * call succeeds (the reachability detector watches axios responses),
 * the worker tick that lands first will drain the queue.
 *
 * Backoff: 30s, 2m, 8m, 30m, 1h capped. Resets on success.
 */
import {
  claimNextBatch,
  markFailed,
  markRetry,
  markSynced,
  markSyncing,
  type LocalPaymentOutboxRow,
} from '@/lib/db/localPaymentOutbox';
import {
  RestaurantOrderApiError,
  restaurantOrdersApi,
} from '@/lib/api/restaurantOrders';
import { isReachable, recordFailure } from '@/lib/reachability';
import type { SqlExecutor } from '@/lib/db/executor';
import { logger } from '@/lib/logger';

export const SYNC_INTERVAL_MS = 15_000;
export const BATCH_SIZE = 10;

const BACKOFF_LADDER_MS = [
  30_000,    //   30 s
  2 * 60_000, //  2 min
  8 * 60_000, //  8 min
  30 * 60_000, // 30 min
  60 * 60_000, //  1 h
];

export interface SyncWorkerResult {
  attempted: number;
  synced: number;
  retried: number;
  failed: number;
  /** Set when a tick was skipped because we're offline. */
  skipped?: 'offline' | 'in_flight';
}

export interface SyncWorkerOptions {
  exec: SqlExecutor;
  isOnline?: () => boolean;
  onResult?: (r: SyncWorkerResult) => void;
  intervalMs?: number;
  batchSize?: number;
  /** Test seam — override `Date.now()` so backoff math is deterministic. */
  now?: () => number;
}

export interface SyncWorkerHandle {
  stop: () => void;
  /** Force a tick now (e.g. immediately after reachability flips true). */
  runNow: () => Promise<SyncWorkerResult>;
}

function backoffForAttempt(attempt: number): number {
  // Row.attempts is incremented on `markSyncing` BEFORE the network
  // call. So a row with attempts=1 is on its first try; the backoff
  // ladder is therefore indexed by attempts-1 (capped).
  const idx = Math.min(BACKOFF_LADDER_MS.length - 1, Math.max(0, attempt - 1));
  return BACKOFF_LADDER_MS[idx];
}

function isRetriable(err: unknown): boolean {
  if (err instanceof RestaurantOrderApiError) {
    if (err.status == null) return true; // network drop
    // 409 IDEMPOTENCY_IN_PROGRESS is transient.
    if (err.status === 409) return true;
    if (err.status >= 500) return true;
    // Other 4xx are non-retriable bugs (validation, auth).
    return false;
  }
  // Anything not classified as our API error is treated as a transient
  // transport problem — be lenient so we don't lose money rows on a
  // weird browser/CORS state.
  return true;
}

async function syncRow(
  exec: SqlExecutor,
  row: LocalPaymentOutboxRow,
  now: () => number,
): Promise<'synced' | 'retried' | 'failed'> {
  await markSyncing(exec, row.id);
  try {
    await restaurantOrdersApi.recordPayment(
      row.order_id,
      {
        method: row.method as 'cash' | 'card' | 'voucher' | 'other',
        amount: row.amount_cents / 100,
        fiscalReceiptNumber: row.external_fiscal_receipt_number ?? undefined,
        fiscalizationSource: row.fiscalization_source as 'cloud' | 'device_offline',
      },
      { idempotencyKey: row.idempotency_key },
    );
    await markSynced(exec, row.id);
    logger.info('pos.cash.sync', 'outbox row synced', {
      outboxId: row.id,
      orderId: row.order_id,
      amountCents: row.amount_cents,
      idempotencyKey: row.idempotency_key,
      fiscalReceiptNumber: row.external_fiscal_receipt_number,
    });
    return 'synced';
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // Feed reachability — a network drop here should flip us offline so
    // the next tick gets short-circuited (we don't want to burn the
    // backoff ladder on a connection that's already down).
    recordFailure(err);
    if (isRetriable(err)) {
      const delay = backoffForAttempt(row.attempts + 1);
      const nextRetry = new Date(now() + delay).toISOString();
      await markRetry(exec, row.id, message, nextRetry);
      logger.warn('pos.cash.sync', 'outbox row queued for retry', {
        outboxId: row.id,
        attempts: row.attempts + 1,
        nextRetry,
        err: message,
      });
      return 'retried';
    }
    await markFailed(exec, row.id, message);
    logger.error('pos.cash.sync', 'outbox row marked FAILED (non-retriable)', {
      outboxId: row.id,
      err: message,
    });
    return 'failed';
  }
}

export async function runSyncTick(
  opts: SyncWorkerOptions,
): Promise<SyncWorkerResult> {
  const isOnline = opts.isOnline ?? isReachable;
  const now = opts.now ?? (() => Date.now());
  const batch = opts.batchSize ?? BATCH_SIZE;

  if (!isOnline()) {
    return { attempted: 0, synced: 0, retried: 0, failed: 0, skipped: 'offline' };
  }
  const rows = await claimNextBatch(opts.exec, batch);
  if (rows.length === 0) {
    return { attempted: 0, synced: 0, retried: 0, failed: 0 };
  }
  let synced = 0;
  let retried = 0;
  let failed = 0;
  for (const row of rows) {
    const outcome = await syncRow(opts.exec, row, now);
    if (outcome === 'synced') synced += 1;
    else if (outcome === 'retried') retried += 1;
    else failed += 1;
    // Stop early if a transient error flipped us offline; the rest of
    // the batch will be retried on the next tick.
    if (!isOnline()) break;
  }
  return { attempted: rows.length, synced, retried, failed };
}

export function startLocalPaymentSyncWorker(
  opts: SyncWorkerOptions,
): SyncWorkerHandle {
  const interval = opts.intervalMs ?? SYNC_INTERVAL_MS;
  let inFlight: Promise<SyncWorkerResult> | null = null;

  async function tick(): Promise<SyncWorkerResult> {
    if (inFlight) return inFlight;
    const p = runSyncTick(opts);
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
    void tick();
  }, interval);

  return {
    stop: () => clearInterval(handle),
    runNow: () => tick(),
  };
}
