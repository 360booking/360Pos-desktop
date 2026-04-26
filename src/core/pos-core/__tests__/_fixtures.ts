/**
 * Deterministic clock + id generator for tests, plus a few helpers to
 * spin up an order quickly.
 */
import type { ActionCtx, Clock, IdGen } from '../actions';
import { createOrder, addItem } from '../actions';
import type { Order } from '../types';
import type { TenantVatConfig } from '../vat';
import { ROMANIAN_DEFAULT_VAT_BP } from '../vat';

export class FakeClock implements Clock {
  private t: number;
  constructor(startMs = Date.parse('2026-04-25T12:00:00Z')) {
    this.t = startMs;
  }
  nowIso(): string {
    const iso = new Date(this.t).toISOString();
    this.t += 1; // monotonic
    return iso;
  }
  reset(startMs: number): void {
    this.t = startMs;
  }
}

export class FakeIds implements IdGen {
  private n = 0;
  newId(): string {
    this.n += 1;
    return `id-${this.n.toString().padStart(4, '0')}`;
  }
  newMutationId(): string {
    this.n += 1;
    return `mut-${this.n.toString().padStart(4, '0')}`;
  }
}

export function makeCtx(overrides: Partial<ActionCtx> = {}): ActionCtx {
  return {
    clock: new FakeClock(),
    ids: new FakeIds(),
    deviceId: 'dev-test-1',
    online: true,
    ...overrides,
  };
}

export const DEFAULT_VAT: TenantVatConfig = {
  defaultRateBp: ROMANIAN_DEFAULT_VAT_BP, // 19%
  foodRateBp: 900,                          // 9%
  barRateBp: 1900,                          // 19%
};

export interface SeededOrder {
  ctx: ActionCtx;
  order: Order;
}

/**
 * Seed an order with N items at given (price, qty, categoryType).
 */
export function seedOrder(
  items: Array<{ unitCents: number; qty: number; cat: 'restaurant' | 'bar' | null }>,
  vat: TenantVatConfig = DEFAULT_VAT,
  ctxOverrides: Partial<ActionCtx> = {},
): SeededOrder {
  const ctx = makeCtx(ctxOverrides);
  let { next } = createOrder({ tableId: 't-1', vatConfig: vat }, ctx);
  for (const it of items) {
    const r = addItem(
      next,
      {
        productId: null,
        productName: 'Item',
        quantity: it.qty,
        unitPriceCents: it.unitCents,
        categoryType: it.cat,
      },
      ctx,
    );
    next = r.next;
  }
  return { ctx, order: next };
}
