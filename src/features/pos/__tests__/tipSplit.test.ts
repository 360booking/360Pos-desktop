import { describe, expect, it } from 'vitest';

import type { OrderItem, RestaurantOrder } from '@/lib/api/restaurantOrders';
import { restaurantOrderToOrder } from '@/lib/api/restaurantOrderMapper';
import { computeTotals } from '@/core/pos-core';

import {
  NEW_CHECK,
  applyMoveResult,
  canMoveItem,
  canSetTip,
  checkLetter,
  defaultTarget,
  hasSeats,
  isCheckLocked,
  moveRequest,
  parseTipInput,
  tableChecks,
  visibleLines,
} from '../tipSplit';

function item(id: string, over: Partial<OrderItem> = {}): OrderItem {
  return {
    id,
    menuItemId: 'm-' + id,
    nameSnapshot: 'Produs ' + id,
    variantLabel: null,
    quantity: 1,
    unitPrice: 10,
    lineTotal: 10,
    modifiers: [],
    kitchenNotes: null,
    status: 'sent',
    kitchenTicketId: null,
    ...over,
  };
}

function order(id: string, over: Partial<RestaurantOrder> = {}): RestaurantOrder {
  return {
    id,
    tenantId: 't',
    restaurantId: 'r',
    source: 'pos',
    externalOrderId: null,
    tableId: 'T1',
    tableNumber: '5',
    waiterId: null,
    status: 'sent',
    paymentStatus: 'unpaid',
    customer: { name: null, phone: null, email: null, address: null },
    subtotal: 20,
    discountTotal: 0,
    taxTotal: 0,
    total: 20,
    currency: 'RON',
    notes: null,
    sentToKitchenAt: null,
    closedAt: null,
    createdAt: '2026-10-16T10:00:00Z',
    updatedAt: null,
    items: [item(id + '-1'), item(id + '-2')],
    payments: [],
    kitchenTickets: [],
    ...over,
  };
}

describe('parseTipInput', () => {
  it('accepts lei with comma or dot', () => {
    expect(parseTipInput('10')).toBe(1000);
    expect(parseTipInput('12,5')).toBe(1250);
    expect(parseTipInput(' 7.05 ')).toBe(705);
    expect(parseTipInput('0')).toBe(0);
  });
  it('rejects junk, negatives and too many decimals', () => {
    expect(parseTipInput('')).toBeNull();
    expect(parseTipInput('abc')).toBeNull();
    expect(parseTipInput('-5')).toBeNull();
    expect(parseTipInput('1.234')).toBeNull();
  });
});

describe('canSetTip', () => {
  const base = { serverId: 'o1', state: 'sent_to_kitchen', items: [{ voidedAt: null }] };
  it('needs a saved, open note with products', () => {
    expect(canSetTip(base)).toBe(true);
    expect(canSetTip(null)).toBe(false);
    expect(canSetTip({ ...base, serverId: null })).toBe(false);
    expect(canSetTip({ ...base, state: 'paid' })).toBe(false);
    expect(canSetTip({ ...base, state: 'cancelled' })).toBe(false);
    expect(canSetTip({ ...base, items: [{ voidedAt: '2026-10-16' }] })).toBe(false);
  });
});

describe('tip from the server', () => {
  it('maps tipTotal into the cart total (like the web POS)', () => {
    const o = restaurantOrderToOrder(order('o1', { subtotal: 20, tipTotal: 5, total: 25 }), 'dev');
    expect(o.tipCents).toBe(500);
    const t = computeTotals(o);
    expect(t.tipCents).toBe(500);
    expect(t.totalCents).toBe(2500);
  });
  it('older servers without tipTotal → no tip', () => {
    expect(restaurantOrderToOrder(order('o1'), 'dev').tipCents).toBe(0);
  });
});

describe('tableChecks', () => {
  it('keeps the open notes of the table, oldest first', () => {
    const list = [
      order('b', { createdAt: '2026-10-16T11:00:00Z' }),
      order('a', { createdAt: '2026-10-16T10:00:00Z' }),
      order('paid', { paymentStatus: 'paid' }),
      order('gone', { status: 'cancelled' }),
      order('other', { tableId: 'T2' }),
      order('delivered', { status: 'delivered' }),
    ];
    expect(tableChecks(list, 'T1').map((o) => o.id)).toEqual(['a', 'b']);
    expect(tableChecks(list, null)).toEqual([]);
  });
  it('letters A, B… then numbers', () => {
    expect(checkLetter(0)).toBe('A');
    expect(checkLetter(7)).toBe('H');
    expect(checkLetter(8)).toBe('9');
  });
  it('default target: last note when there are several, else a new one', () => {
    expect(defaultTarget([order('a')])).toBe(NEW_CHECK);
    expect(defaultTarget([order('a'), order('b')])).toBe('b');
  });
});

describe('moving products', () => {
  it('locks notes with payments, discount or a receipt', () => {
    expect(isCheckLocked(order('a'))).toBe(false);
    expect(isCheckLocked(order('a', { discountTotal: 2 }))).toBe(true);
    expect(isCheckLocked(order('a', { fiscalReceiptNumber: 'BF1' }))).toBe(true);
    expect(
      isCheckLocked(order('a', { payments: [{ id: 'p', method: 'cash', amount: 1, currency: 'RON', reference: null, receivedAt: null }] })),
    ).toBe(true);
  });
  it('moves only real lines, never into the same note', () => {
    const a = order('a');
    expect(canMoveItem(a, a.items[0], NEW_CHECK)).toBe(true);
    expect(canMoveItem(a, a.items[0], 'b')).toBe(true);
    expect(canMoveItem(a, a.items[0], 'a')).toBe(false);
    expect(canMoveItem(a, item('local-1'), 'b')).toBe(false);
    expect(canMoveItem(order('x', { discountTotal: 1 }), a.items[0], 'b')).toBe(false);
  });
  it('builds the same request as the web POS', () => {
    expect(moveRequest(NEW_CHECK)).toEqual({ newCheck: true });
    expect(moveRequest('b')).toEqual({ toOrderId: 'b' });
  });
  it('applies the server answer; an emptied (cancelled) note disappears', () => {
    const a = order('a', { createdAt: '2026-10-16T10:00:00Z' });
    const b = order('b', { createdAt: '2026-10-16T11:00:00Z' });
    const out = applyMoveResult([a, b], {
      from: { ...a, status: 'cancelled', items: [] },
      to: { ...b, items: [...b.items, ...a.items], total: 40 },
    });
    expect(out.map((o) => o.id)).toEqual(['b']);
    expect(out[0].total).toBe(40);

    const c = order('c', { createdAt: '2026-10-16T12:00:00Z' });
    const out2 = applyMoveResult([a], { from: { ...a, items: [a.items[0]] }, to: c });
    expect(out2.map((o) => o.id)).toEqual(['a', 'c']);
  });
  it('void lines are hidden; seats enable „Împarte pe locuri”', () => {
    const a = order('a', { items: [item('1', { status: 'void', seatNo: 2 }), item('2')] });
    expect(visibleLines(a).map((i) => i.id)).toEqual(['2']);
    expect(hasSeats(a)).toBe(false);
    expect(hasSeats(order('s', { items: [item('1', { seatNo: 1 }), item('2', { seatNo: 2 })] }))).toBe(true);
    expect(hasSeats(null)).toBe(false);
  });
});
