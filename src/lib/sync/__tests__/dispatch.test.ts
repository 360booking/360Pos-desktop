import { describe, expect, it } from 'vitest';
import { createMemoryExecutor } from '@/lib/db/memoryExecutor';
import { createEventStore } from '../eventStore';
import { configureDispatch, runAction } from '../dispatch';
import { addItem, createOrder, type ActionCtx } from '@/core/pos-core';
import { ROMANIAN_DEFAULT_VAT_BP } from '@/core/pos-core';

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
