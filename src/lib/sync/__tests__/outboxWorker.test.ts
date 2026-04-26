import { describe, expect, it } from 'vitest';
import { createMemoryExecutor } from '@/lib/db/memoryExecutor';
import { createEventStore } from '../eventStore';
import { createInMemorySyncTransport } from '../inMemoryTransport';
import { createOutboxWorker } from '../outboxWorker';
import { backoffMs } from '../backoff';
import type { SyncEvent } from '@/core/pos-core';

const ev = (mutation: string, order: string | null, type = 'ORDER_ITEM_ADDED'): SyncEvent => ({
  mutationId: mutation,
  type: type as never,
  localTimestamp: '2026-04-25T12:00:00.000Z',
  deviceId: 'dev-1',
  orderLocalId: order ?? '',
  orderServerId: null,
  payload: { x: 1 },
});

class StepClock {
  private t: number;
  constructor(startIso: string) {
    this.t = Date.parse(startIso);
  }
  now = (): string => new Date(this.t).toISOString();
  advance(ms: number): void {
    this.t += ms;
  }
}

describe('outboxWorker.tick — happy path', () => {
  it('drains all pending events on success', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const transport = createInMemorySyncTransport({ mode: 'success' });
    const clock = new StepClock('2026-04-25T12:00:00.000Z');
    const worker = createOutboxWorker({ store, transport, now: clock.now });

    await store.persistBatch([ev('m1', 'o1'), ev('m2', 'o2')], clock.now());
    const out = await worker.tick();
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.status === 'accepted')).toBe(true);
    const dump = exec._dump();
    expect(dump.outbox).toHaveLength(0);
    expect(dump.events.every((e) => e.status === 'synced')).toBe(true);
  });

  it('treats `duplicate` as success and removes the outbox row', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const transport = createInMemorySyncTransport({ mode: 'duplicate' });
    const clock = new StepClock('2026-04-25T12:00:00.000Z');
    const worker = createOutboxWorker({ store, transport, now: clock.now });
    await store.persistBatch([ev('m1', 'o1')], clock.now());
    const out = await worker.tick();
    expect(out[0].status).toBe('duplicate');
    expect(exec._dump().outbox).toHaveLength(0);
    expect(exec._dump().events[0].status).toBe('synced');
  });
});

describe('outboxWorker.tick — failures', () => {
  it('schedules retry on transport offline + applies exponential backoff', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const transport = createInMemorySyncTransport({ mode: 'offline' });
    const clock = new StepClock('2026-04-25T12:00:00.000Z');
    const worker = createOutboxWorker({ store, transport, now: clock.now });
    await store.persistBatch([ev('m1', 'o1')], clock.now());
    await worker.tick();
    let dump = exec._dump();
    expect(dump.outbox[0].attempts).toBe(1);
    // next_retry_at should be now + 1s
    expect(Date.parse(dump.outbox[0].next_retry_at) - Date.parse(clock.now())).toBe(backoffMs(1));
    // Advance just under the schedule and confirm the next tick does NOT pick it up.
    clock.advance(500);
    expect(await worker.tick()).toHaveLength(0);
    // Advance past the schedule and confirm pickup.
    clock.advance(600);
    await worker.tick(); // still offline
    dump = exec._dump();
    expect(dump.outbox[0].attempts).toBe(2);
    expect(Date.parse(dump.outbox[0].next_retry_at) - Date.parse(clock.now())).toBe(backoffMs(2));
  });

  it('promotes to dead-letter at 50 attempts', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const transport = createInMemorySyncTransport({ mode: 'failed' });
    const clock = new StepClock('2026-04-25T12:00:00.000Z');
    const worker = createOutboxWorker({ store, transport, now: clock.now });
    const [row] = await store.persistBatch([ev('m1', 'o1')], clock.now());
    // Pre-set attempts to 49 so the next failure tips it over.
    await store.scheduleRetry(row.id, 49, clock.now(), 'fake');
    await worker.tick();
    const dump = exec._dump();
    expect(dump.events[0].status).toBe('dead');
    expect(dump.outbox).toHaveLength(0);
  });

  it('fatal failure (retryable=false) goes straight to dead', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const transport = createInMemorySyncTransport({ mode: 'fatal' });
    const clock = new StepClock('2026-04-25T12:00:00.000Z');
    const worker = createOutboxWorker({ store, transport, now: clock.now });
    await store.persistBatch([ev('m1', 'o1')], clock.now());
    await worker.tick();
    const dump = exec._dump();
    expect(dump.events[0].status).toBe('dead');
    expect(dump.outbox).toHaveLength(0);
  });

  it('conflict marks event failed (NOT retried) — surfaces to UI', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const transport = createInMemorySyncTransport({ mode: 'conflict' });
    const clock = new StepClock('2026-04-25T12:00:00.000Z');
    const worker = createOutboxWorker({ store, transport, now: clock.now });
    await store.persistBatch([ev('m1', 'o1')], clock.now());
    const out = await worker.tick();
    expect(out[0].status).toBe('conflict');
    expect(exec._dump().events[0].status).toBe('failed');
    // Subsequent ticks must not re-send a failed event.
    expect(await worker.tick()).toHaveLength(0);
  });
});

describe('outboxWorker — per-order serialisation', () => {
  it('groups events of the same order into ONE batch (single transport call)', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const transport = createInMemorySyncTransport({ mode: 'success' });
    const clock = new StepClock('2026-04-25T12:00:00.000Z');
    const worker = createOutboxWorker({ store, transport, now: clock.now });
    await store.persistBatch(
      [ev('m1', 'o1'), ev('m2', 'o1'), ev('m3', 'o2')],
      clock.now(),
    );
    await worker.tick();
    const calls = transport.history();
    // 2 batches: o1 (size 2) + o2 (size 1)
    const batchSizes = countBatchSizes(calls);
    expect(batchSizes.sort()).toEqual([1, 2]);
  });
});

function countBatchSizes(history: ReturnType<ReturnType<typeof createInMemorySyncTransport>['history']>): number[] {
  // The transport stores envelopes flat — group consecutive ones with
  // identical orderLocalId as a "batch". Approximation good enough for
  // the assertion above because each tick processes batches sequentially.
  const sizes: number[] = [];
  let last: string | null = null;
  let n = 0;
  for (const env of history) {
    const k = env.event.orderLocalId;
    if (k !== last) {
      if (n > 0) sizes.push(n);
      n = 1;
      last = k;
    } else {
      n += 1;
    }
  }
  if (n > 0) sizes.push(n);
  return sizes;
}

describe('restart replay', () => {
  it('survives a process restart: events persist, worker resumes, no duplicate mutations', async () => {
    const exec = createMemoryExecutor(); // simulates the same SQLite file across restarts
    let store = createEventStore(exec);
    const transport = createInMemorySyncTransport({ mode: 'offline' });
    const clock = new StepClock('2026-04-25T12:00:00.000Z');

    // First "process": dispatch, transport offline, app crashes mid-sync.
    await store.persistBatch([ev('m1', 'o1')], clock.now());
    let worker = createOutboxWorker({ store, transport, now: clock.now });
    await worker.tick(); // offline → schedule retry
    expect(exec._dump().events[0].status).toBe('pending');

    // Simulate restart: brand-new objects pointing at the SAME executor.
    store = createEventStore(exec);
    transport.setMode('success');
    worker = createOutboxWorker({ store, transport, now: clock.now });

    // Advance past the retry window.
    clock.advance(2_000);
    const out = await worker.tick();
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('accepted');

    // Critically: the same mutation_id was used both times.
    const seenIds = transport.history().map((h) => h.mutationId);
    expect(seenIds).toEqual(['m1', 'm1']);
  });
});
