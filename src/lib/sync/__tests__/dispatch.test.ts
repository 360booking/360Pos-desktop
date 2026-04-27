import { describe, expect, it, vi } from 'vitest';
import { createMemoryExecutor } from '@/lib/db/memoryExecutor';
import { createEventStore } from '../eventStore';
import { configureDispatch, runAction, readLastPersistBatchError } from '../dispatch';
import { addItem, createOrder, type ActionCtx } from '@/core/pos-core';
import { ROMANIAN_DEFAULT_VAT_BP } from '@/core/pos-core';
import type { EventStore } from '../eventStore';

function ctx(): ActionCtx {
  let n = 0;
  return {
    clock: { nowIso: () => '2026-04-25T12:00:00.000Z' },
    ids: {
      newId: () => `id-${++n}`,
      newMutationId: () => `mut-${++n}`,
    },
    deviceId: 'dev-1',
    online: true,
  };
}

describe('dispatchPosAction (runAction)', () => {
  it('persists the events from a pos-core action', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    configureDispatch({ store, now: () => '2026-04-25T12:00:00.000Z' });
    const c = ctx();
    const created = await runAction(() =>
      createOrder({ tableId: 't1', vatConfig: { defaultRateBp: ROMANIAN_DEFAULT_VAT_BP } }, c),
    );
    expect(created.next.state).toBe('draft');
    expect(exec._dump().events).toHaveLength(1);

    const added = await runAction(() =>
      addItem(
        created.next,
        { productId: null, productName: 'Cola', quantity: 1, unitPriceCents: 900, categoryType: 'bar' },
        c,
      ),
    );
    expect(added.next.items).toHaveLength(1);
    expect(exec._dump().events).toHaveLength(2);
    expect(exec._dump().outbox).toHaveLength(2);
  });

  it('is no-op when an action returns no events', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    configureDispatch({ store, now: () => '2026-04-25T12:00:00.000Z' });
    const result = await runAction(() => ({ next: {}, events: [] } as never));
    expect(result).toBeDefined();
    expect(exec._dump().events).toHaveLength(0);
  });
});

describe('dispatch — Sprint 11.5 persistBatch error reporting', () => {
  function failingStore(message: string): EventStore {
    return {
      persistBatch: vi.fn(async () => {
        throw new Error(message);
      }),
      pendingDue: vi.fn(async () => []),
      markProcessing: vi.fn(),
      markSynced: vi.fn(),
      scheduleRetry: vi.fn(),
      markFailed: vi.fn(),
      markDead: vi.fn(),
      counts: vi.fn(async () => ({
        pending: 0, processing: 0, synced: 0, failed: 0, dead: 0, total: 0, outboxDepth: 0,
      })),
    };
  }

  it('runAction throws when persistBatch fails — UI can react', async () => {
    configureDispatch({ store: failingStore('disk full'), now: () => 't' });
    await expect(
      runAction(() => ({ next: {} as never, events: [{ mutationId: 'm', type: 'X' as never, localTimestamp: '', deviceId: '', orderLocalId: '', orderServerId: null, payload: {} }] })),
    ).rejects.toThrow('disk full');
  });

  it('readLastPersistBatchError captures + clears between failures and successes', async () => {
    configureDispatch({ store: failingStore('first'), now: () => 't' });
    await expect(
      runAction(() => ({ next: {} as never, events: [{ mutationId: 'm1', type: 'X' as never, localTimestamp: '', deviceId: '', orderLocalId: '', orderServerId: null, payload: {} }] })),
    ).rejects.toThrow();
    expect(readLastPersistBatchError()).toBe('first');

    const exec = createMemoryExecutor();
    configureDispatch({ store: createEventStore(exec), now: () => 't' });
    await runAction(() => ({ next: {} as never, events: [{ mutationId: 'm2', type: 'X' as never, localTimestamp: '', deviceId: '', orderLocalId: '', orderServerId: null, payload: {} }] }));
    expect(readLastPersistBatchError()).toBeNull();
  });

  it('persistBatch is NOT affected by logger failure (logger is RAM-only)', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    configureDispatch({ store, now: () => 't' });
    // No mock of the logger — dbg/dbgError are RAM-only since 11.5,
    // so they cannot throw on a DB error. The persist call must succeed.
    await runAction(() => ({ next: {} as never, events: [{ mutationId: 'm3', type: 'X' as never, localTimestamp: '', deviceId: '', orderLocalId: 'o', orderServerId: null, payload: {} }] }));
    expect(exec._dump().events).toHaveLength(1);
  });
});
