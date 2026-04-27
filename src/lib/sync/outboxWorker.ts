/**
 * Outbox worker.
 *
 * Loop:
 *  1. Read pendingDue() — events whose next_retry_at ≤ now.
 *  2. Group by order_local_id (or `__no_order__` for system events).
 *     Send ONE batch per order so server sees the events in their
 *     creation order without parallel writers fighting over the same
 *     order. Batches across different orders go in parallel.
 *  3. For each result:
 *       accepted/duplicate → markSynced
 *       conflict           → markFailed (retry won't help, server-rule)
 *       failed (retryable) → scheduleRetry(attempt+1, backoff)
 *       failed (fatal)     → markDead
 *  4. On TransportOfflineError / TransportTimeoutError → schedule retry
 *     for ALL events in the failed batch.
 *
 * Pure logic; the `tick()` is side-effect-free if you inject deterministic
 * `now()`. The `start()` helper wraps tick in setInterval.
 */
import {
  TransportOfflineError,
  TransportTimeoutError,
  type PushEnvelope,
  type PushOutcome,
  type SyncTransport,
} from './transport';
import type { EventStore, OutboxItem } from './eventStore';
import { nextRetryIso } from './backoff';
import { dbg, dbgError } from '@/lib/debugLog';

export interface OutboxWorker {
  /** Run one tick. Returns the outcomes processed (handy for tests). */
  tick(): Promise<PushOutcome[]>;
  /** Start the polling loop. Returns a stop function. */
  start(intervalMs?: number): () => void;
}

export interface WorkerDeps {
  store: EventStore;
  transport: SyncTransport;
  now: () => string; // ISO
  /** Hook fired AFTER each tick, with what happened. UI uses this to refresh status. */
  onTick?: (outcomes: PushOutcome[]) => void;
  /** Hook fired when a batch is rejected for being offline / timeout. */
  onTransportError?: (err: Error, batch: OutboxItem[]) => void;
}

interface BatchKey {
  orderId: string;
  items: OutboxItem[];
}

function groupByOrder(items: OutboxItem[]): BatchKey[] {
  const groups = new Map<string, OutboxItem[]>();
  for (const it of items) {
    const k = it.orderLocalId ?? '__no_order__';
    const arr = groups.get(k) ?? [];
    arr.push(it);
    groups.set(k, arr);
  }
  return Array.from(groups, ([orderId, items]) => ({ orderId, items }));
}

function envelopeOf(item: OutboxItem): PushEnvelope {
  return {
    mutationId: item.mutationId,
    attempt: item.attempts,
    event: {
      mutationId: item.mutationId,
      type: item.type as never, // narrow at boundary; we trust the store
      localTimestamp: '', // round-tripped by the server, not used for routing
      deviceId: '',
      orderLocalId: item.orderLocalId ?? '',
      orderServerId: null,
      payload: JSON.parse(item.payloadJson),
    },
  };
}

export function createOutboxWorker(deps: WorkerDeps): OutboxWorker {
  const { store, transport, now, onTick, onTransportError } = deps;

  async function processBatch(batch: OutboxItem[]): Promise<PushOutcome[]> {
    // Mark each event processing so a subsequent tick before this one
    // resolves doesn't double-send (idempotency on the server, but we
    // also don't want to spam attempts).
    for (const it of batch) {
      await store.markProcessing(it.id);
    }

    const envelopes = batch.map(envelopeOf);
    let outcomes: PushOutcome[];
    try {
      outcomes = await transport.pushEvents(envelopes);
    } catch (err) {
      const e = err as Error;
      // Transport-level failure: schedule retry for everyone in the batch.
      if (e instanceof TransportOfflineError || e instanceof TransportTimeoutError || true) {
        const nowIso = now();
        for (const it of batch) {
          const nextAttempt = it.attempts + 1;
          await store.scheduleRetry(
            it.id,
            nextAttempt,
            nextRetryIso(nowIso, nextAttempt),
            e.message,
          );
        }
        onTransportError?.(e, batch);
        return [];
      }
    }

    // Per-event handling.
    const byMutation = new Map(batch.map((it) => [it.mutationId, it]));
    for (const outcome of outcomes!) {
      const item = byMutation.get(outcome.mutationId);
      if (!item) continue;

      if (outcome.status === 'accepted' || outcome.status === 'duplicate') {
        await store.markSynced(
          item.id,
          outcome.serverState ? JSON.stringify(outcome.serverState) : null,
          now(),
        );
        continue;
      }
      if (outcome.status === 'conflict') {
        await store.markFailed(
          item.id,
          `${outcome.errorCode ?? 'CONFLICT'}: ${outcome.errorMessage ?? ''}`,
        );
        continue;
      }
      if (outcome.status === 'failed') {
        const nextAttempt = item.attempts + 1;
        if (outcome.retryable === false) {
          await store.markDead(
            item.id,
            `${outcome.errorCode ?? 'FATAL'}: ${outcome.errorMessage ?? ''}`,
          );
        } else {
          await store.scheduleRetry(
            item.id,
            nextAttempt,
            nextRetryIso(now(), nextAttempt),
            `${outcome.errorCode ?? 'ERR'}: ${outcome.errorMessage ?? ''}`,
          );
        }
      }
    }
    return outcomes!;
  }

  const worker: OutboxWorker = {
    async tick(): Promise<PushOutcome[]> {
      const due = await store.pendingDue(now());
      if (due.length === 0) {
        onTick?.([]);
        return [];
      }
      dbg('outboxWorker', 'tick — due batch', {
        due: due.length,
        types: due.map((d) => d.type),
      });
      const groups = groupByOrder(due);
      let results: PushOutcome[][];
      try {
        results = await Promise.all(groups.map((g) => processBatch(g.items)));
      } catch (err) {
        dbgError('outboxWorker', 'tick processBatch threw', {
          message: (err as Error)?.message ?? String(err),
        });
        throw err;
      }
      const flat = results.flat();
      dbg('outboxWorker', 'tick done', {
        processed: flat.length,
        summary: flat.reduce<Record<string, number>>((acc, o) => {
          acc[o.status] = (acc[o.status] ?? 0) + 1;
          return acc;
        }, {}),
      });
      onTick?.(flat);
      return flat;
    },

    start(intervalMs = 2_000): () => void {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const loop = async () => {
        if (stopped) return;
        try {
          await worker.tick();
        } catch {
          // Swallow; the next tick retries. Tests assert via `tick()` directly.
        }
        if (!stopped) {
          timer = setTimeout(loop, intervalMs);
        }
      };
      timer = setTimeout(loop, intervalMs);
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    },
  };

  return worker;
}
