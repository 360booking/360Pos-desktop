import { describe, expect, it } from 'vitest';
import {
  allocateDiscount,
  changeDueCents,
  computeTotals,
  paidCents,
  remainingCents,
  subtotalCents,
  totalCents,
  vatCents,
} from '../calculator';
import { addItem, addTip, applyDiscount, registerCashPayment } from '../actions';
import { seedOrder, makeCtx, DEFAULT_VAT } from './_fixtures';

describe('subtotal / total / vat', () => {
  it('sums active items only (voided excluded)', () => {
    const { order } = seedOrder([
      { unitCents: 1000, qty: 2, cat: 'restaurant' }, // 2000
      { unitCents: 500, qty: 1, cat: 'bar' },          // 500
    ]);
    expect(subtotalCents(order)).toBe(2500);
    expect(totalCents(order)).toBe(2500); // no discount, no tip
  });

  it('mixed-rate VAT split is per-line', () => {
    const { order } = seedOrder([
      { unitCents: 1090, qty: 1, cat: 'restaurant' }, // 9% → vat 90, net 1000
      { unitCents: 1190, qty: 1, cat: 'bar' },         // 19% → vat 190, net 1000
    ]);
    expect(subtotalCents(order)).toBe(2280);
    expect(vatCents(order)).toBe(280); // 90 + 190
  });

  it('tip is in total but NOT in VAT base (deliberate parity delta)', () => {
    const { order, ctx } = seedOrder([
      { unitCents: 1190, qty: 1, cat: 'bar' }, // 1190 gross @ 19% → vat 190
    ]);
    const tipped = addTip(order, { amountCents: 500 }, ctx).next;
    expect(totalCents(tipped)).toBe(1690);
    expect(vatCents(tipped)).toBe(190); // unchanged by tip
  });
});

describe('discount allocation', () => {
  it('allocates a 100 cent discount across two equal lines', () => {
    const items = [
      { id: 'a', mutationId: 'a', productId: null, productName: 'A', quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000, vatRateBp: 1900, modifiers: {}, kitchenTicketId: null, sentAt: null, voidedAt: null, voidReason: null, createdAt: '' },
      { id: 'b', mutationId: 'b', productId: null, productName: 'B', quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000, vatRateBp: 1900, modifiers: {}, kitchenTicketId: null, sentAt: null, voidedAt: null, voidReason: null, createdAt: '' },
    ];
    const out = allocateDiscount(items as any, 2000, 100);
    expect(out.reduce((a, b) => a + b, 0)).toBe(1900);
    expect(out).toEqual([950, 950]);
  });
  it('handles uneven splits without drift', () => {
    const items = [
      { id: 'a', lineTotalCents: 333 },
      { id: 'b', lineTotalCents: 333 },
      { id: 'c', lineTotalCents: 334 },
    ] as any;
    const out = allocateDiscount(items, 1000, 100);
    expect(out.reduce((a, b) => a + b, 0)).toBe(900);
  });
  it('caps discount at subtotal (cannot go negative)', () => {
    const items = [{ id: 'a', lineTotalCents: 500 }] as any;
    const out = allocateDiscount(items, 500, 999);
    expect(out).toEqual([0]);
  });
});

describe('discount + tip workflow', () => {
  it('applies discount then tip; vat reduces with discount; tip not in vat', () => {
    const { order, ctx } = seedOrder([
      { unitCents: 1190, qty: 2, cat: 'bar' }, // 2380 gross, vat 380
    ]);
    const d = applyDiscount(order, { amountCents: 100, note: 'happy hour' }, ctx).next;
    expect(subtotalCents(d)).toBe(2380);
    expect(totalCents(d)).toBe(2280);
    // gross after discount = 2280; vat backed out from 2280 @ 19% should be smaller than 380
    expect(vatCents(d)).toBeLessThan(380);
    const tipped = addTip(d, { amountCents: 200 }, ctx).next;
    expect(totalCents(tipped)).toBe(2480);
    expect(vatCents(tipped)).toBe(vatCents(d)); // tip didn't move VAT
  });
});

describe('paid / remaining / change', () => {
  it('cash exact-match → remaining 0, change 0', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1500, qty: 1, cat: 'bar' }]);
    const after = registerCashPayment(order, { amountCents: 1500 }, ctx).next;
    expect(paidCents(after)).toBe(1500);
    expect(remainingCents(after)).toBe(0);
    expect(changeDueCents(after)).toBe(0);
  });
  it('cash over-tender → change due', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1500, qty: 1, cat: 'bar' }]);
    const after = registerCashPayment(
      order,
      { amountCents: 2000, acceptOverTender: true },
      ctx,
    ).next;
    expect(remainingCents(after)).toBe(0);
    expect(changeDueCents(after)).toBe(500);
  });
  it('partial → still owed', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1500, qty: 1, cat: 'bar' }]);
    const after = registerCashPayment(order, { amountCents: 1000 }, ctx).next;
    expect(remainingCents(after)).toBe(500);
  });
});

describe('computeTotals snapshot', () => {
  it('returns the full bundle in one call', () => {
    const { order } = seedOrder([{ unitCents: 1190, qty: 1, cat: 'bar' }]);
    const t = computeTotals(order);
    expect(t).toMatchObject({
      subtotalCents: 1190,
      discountCents: 0,
      tipCents: 0,
      vatCents: 190,
      totalCents: 1190,
      paidCents: 0,
      remainingCents: 1190,
      changeDueCents: 0,
    });
  });
});

describe('integer-only invariant', () => {
  it('all calculator outputs are integers', () => {
    const { order, ctx } = seedOrder([
      { unitCents: 1099, qty: 3, cat: 'restaurant' },
      { unitCents: 555, qty: 1, cat: 'bar' },
    ]);
    const d = applyDiscount(order, { amountCents: 117, note: null }, ctx).next;
    const tipped = addTip(d, { amountCents: 50 }, ctx).next;
    const t = computeTotals(tipped);
    for (const v of Object.values(t)) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe('voided items', () => {
  it('voided items do not contribute to totals', () => {
    const ctx = makeCtx();
    const { order } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }], DEFAULT_VAT);
    const r = addItem(
      order,
      { productId: null, productName: 'Extra', quantity: 1, unitPriceCents: 500, categoryType: 'bar' },
      ctx,
    );
    expect(subtotalCents(r.next)).toBe(1500);
    // Now void the second item.
    const second = r.next.items[1];
    const voided: any = {
      ...r.next,
      items: r.next.items.map((it) =>
        it.id === second.id ? { ...it, voidedAt: '2026-04-25T12:00:01Z' } : it,
      ),
    };
    expect(subtotalCents(voided)).toBe(1000);
  });
});
