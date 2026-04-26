import { describe, expect, it } from 'vitest';
import {
  addItem,
  applyDiscount,
  cancelOrder,
  closeOrder,
  createFiscalAttempt,
  createOrder,
  markFiscalPrinted,
  markFiscalUnknown,
  registerCardPaymentResult,
  registerCashPayment,
  sendToKitchen,
  voidItem,
} from '../actions';
import {
  EmptyOrderError,
  FiscalUnknownNoRetryError,
  IllegalTransitionError,
  OfflineCardPaymentError,
  OrderCancelledError,
  OrderFiscalisedError,
  OrderNotOwnedError,
  OrderNotPaidError,
  PaymentExceedsRemainingError,
} from '../state-machine';
import { DEFAULT_VAT, makeCtx, seedOrder } from './_fixtures';

describe('createOrder', () => {
  it('starts in draft and emits ORDER_CREATED', () => {
    const ctx = makeCtx();
    const r = createOrder({ tableId: 't1', vatConfig: DEFAULT_VAT }, ctx);
    expect(r.next.state).toBe('draft');
    expect(r.next.ownerDeviceId).toBe('dev-test-1');
    expect(r.events).toHaveLength(1);
    expect(r.events[0].type).toBe('ORDER_CREATED');
    expect(r.events[0].deviceId).toBe('dev-test-1');
  });
});

describe('addItem', () => {
  it('moves draft → open and computes line total', () => {
    const ctx = makeCtx();
    const o = createOrder({ tableId: null, vatConfig: DEFAULT_VAT }, ctx).next;
    const r = addItem(
      o,
      { productId: null, productName: 'Cola', quantity: 2, unitPriceCents: 900, categoryType: 'bar' },
      ctx,
    );
    expect(r.next.state).toBe('open');
    expect(r.next.items).toHaveLength(1);
    expect(r.next.items[0].lineTotalCents).toBe(1800);
    expect(r.next.items[0].vatRateBp).toBe(1900); // bar override
    expect(r.events[0].type).toBe('ORDER_ITEM_ADDED');
  });
  it('snapshots category-driven VAT rate', () => {
    const ctx = makeCtx();
    const o = createOrder({ tableId: null, vatConfig: DEFAULT_VAT }, ctx).next;
    const r = addItem(
      o,
      { productId: null, productName: 'Salad', quantity: 1, unitPriceCents: 1090, categoryType: 'restaurant' },
      ctx,
    );
    expect(r.next.items[0].vatRateBp).toBe(900);
  });
  it('blocks edits without local ownership offline', () => {
    const { order } = seedOrder([], DEFAULT_VAT, { deviceId: 'dev-A', online: false });
    const ctxBad = makeCtx({ deviceId: 'dev-B', online: false });
    expect(() =>
      addItem(
        order,
        { productId: null, productName: 'X', quantity: 1, unitPriceCents: 100, categoryType: null },
        ctxBad,
      ),
    ).toThrow(OrderNotOwnedError);
  });
  it('blocks edits after fiscalisation', () => {
    const { order } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const fiscalised: any = {
      ...order,
      fiscalAttempts: [
        {
          id: 'a',
          mutationId: 'm',
          orderLocalId: order.id,
          deviceId: 'dev-test-1',
          adapterId: 'sim',
          status: 'printed',
          fiscalNumber: 'F1',
          errorCode: null,
          errorMessage: null,
          startedAt: '',
          finishedAt: '',
        },
      ],
    };
    expect(() =>
      addItem(
        fiscalised,
        { productId: null, productName: 'X', quantity: 1, unitPriceCents: 100, categoryType: null },
        makeCtx(),
      ),
    ).toThrow(OrderFiscalisedError);
  });
  it('blocks edits on cancelled', () => {
    const { order } = seedOrder([]);
    const cancelled: any = { ...order, state: 'cancelled' };
    expect(() =>
      addItem(
        cancelled,
        { productId: null, productName: 'X', quantity: 1, unitPriceCents: 100, categoryType: null },
        makeCtx(),
      ),
    ).toThrow(OrderCancelledError);
  });
});

describe('voidItem', () => {
  it('marks item voided; subtotals drop', () => {
    const { order, ctx } = seedOrder([
      { unitCents: 1000, qty: 1, cat: 'bar' },
      { unitCents: 500, qty: 1, cat: 'bar' },
    ]);
    const target = order.items[0];
    const r = voidItem(order, { itemId: target.id, reason: 'wrong order' }, ctx);
    expect(r.next.items.find((it) => it.id === target.id)?.voidedAt).toBeTruthy();
    expect(r.next.subtotalCents).toBe(500);
    expect(r.events[0].type).toBe('ORDER_ITEM_VOIDED');
  });
  it('refuses double-void', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const id = order.items[0].id;
    const once = voidItem(order, { itemId: id, reason: 'r1' }, ctx).next;
    expect(() => voidItem(once, { itemId: id, reason: 'r2' }, ctx)).toThrow();
  });
});

describe('applyDiscount + addTip', () => {
  it('updates totals and emits events', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const d = applyDiscount(order, { amountCents: 200, note: 'happy hour' }, ctx);
    expect(d.next.discountCents).toBe(200);
    expect(d.next.totalCents).toBe(800);
    expect(d.events[0].type).toBe('DISCOUNT_APPLIED');
  });
});

describe('sendToKitchen', () => {
  it('groups items by station and emits one ticket per station', () => {
    const { order, ctx } = seedOrder([
      { unitCents: 1000, qty: 1, cat: 'restaurant' },
      { unitCents: 500, qty: 1, cat: 'bar' },
    ]);
    const [foodId, drinkId] = order.items.map((it) => it.id);
    const r = sendToKitchen(
      order,
      { stationByItemId: { [foodId]: 'kitchen', [drinkId]: 'bar' } },
      ctx,
    );
    expect(r.next.state).toBe('sent_to_kitchen');
    expect(r.tickets).toHaveLength(2);
    expect(new Set(r.tickets.map((t) => t.station))).toEqual(new Set(['kitchen', 'bar']));
    expect(r.events[0].type).toBe('SENT_TO_KITCHEN');
  });
  it('refuses when no items', () => {
    const ctx = makeCtx();
    const o = createOrder({ tableId: null, vatConfig: DEFAULT_VAT }, ctx).next;
    expect(() => sendToKitchen(o, {}, ctx)).toThrow(EmptyOrderError);
  });
  it('no-op when nothing new to send', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const sent = sendToKitchen(order, {}, ctx).next;
    const again = sendToKitchen(sent, {}, ctx);
    expect(again.tickets).toHaveLength(0);
    expect(again.events).toHaveLength(0);
  });
});

describe('cash payment + state advancement', () => {
  it('partial → partially_paid; full → paid', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const sent = sendToKitchen(order, {}, ctx).next;
    const partial = registerCashPayment(sent, { amountCents: 400 }, ctx).next;
    expect(partial.state).toBe('partially_paid');
    const full = registerCashPayment(partial, { amountCents: 600 }, ctx).next;
    expect(full.state).toBe('paid');
  });
  it('refuses overpay without acceptOverTender', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    expect(() => registerCashPayment(order, { amountCents: 5000 }, ctx)).toThrow(
      PaymentExceedsRemainingError,
    );
  });
});

describe('card payment', () => {
  it('blocks offline', () => {
    const { order } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const ctx = makeCtx({ online: false });
    expect(() =>
      registerCardPaymentResult(
        order,
        { amountCents: 1000, status: 'approved' },
        ctx,
      ),
    ).toThrow(OfflineCardPaymentError);
  });
  it('approved → paid; declined does NOT advance state', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const sent = sendToKitchen(order, {}, ctx).next;
    const decl = registerCardPaymentResult(
      sent,
      { amountCents: 1000, status: 'declined' },
      ctx,
    ).next;
    expect(decl.state).toBe('sent_to_kitchen');
    const ok = registerCardPaymentResult(
      decl,
      { amountCents: 1000, status: 'approved', terminalAuthCode: 'A1', terminalRrn: 'R1' },
      ctx,
    );
    expect(ok.next.state).toBe('paid');
    expect(ok.events[0].type).toBe('PAYMENT_REGISTERED');
  });
  it('unknown status does NOT pay nor advance, and emits CARD_PAYMENT_UNKNOWN', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const sent = sendToKitchen(order, {}, ctx).next;
    const unk = registerCardPaymentResult(
      sent,
      { amountCents: 1000, status: 'unknown', terminalTrace: 'NAK' },
      ctx,
    );
    expect(unk.next.state).toBe('sent_to_kitchen');
    expect(unk.events[0].type).toBe('CARD_PAYMENT_UNKNOWN');
    // remaining unchanged
    expect(unk.next.payments[0].status).toBe('unknown');
  });
});

describe('fiscal flow', () => {
  it('createFiscalAttempt only after paid', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    expect(() => createFiscalAttempt(order, { adapterId: 'sim' }, ctx)).toThrow(
      OrderNotPaidError,
    );
    const paid = registerCashPayment(order, { amountCents: 1000 }, ctx).next;
    const r = createFiscalAttempt(paid, { adapterId: 'sim' }, ctx);
    expect(r.next.state).toBe('fiscal_pending');
    expect(r.attempt.status).toBe('pending');
    expect(r.events[0].type).toBe('FISCAL_ATTEMPT_CREATED');
  });
  it('printed → fiscally_printed and attaches receipt', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const paid = registerCashPayment(order, { amountCents: 1000 }, ctx).next;
    const att = createFiscalAttempt(paid, { adapterId: 'sim' }, ctx);
    const r = markFiscalPrinted(
      att.next,
      { attemptId: att.attempt.id, fiscalNumber: 'F-42', fiscalDate: '2026-04-25T12:00:00Z' },
      ctx,
    );
    expect(r.next.state).toBe('fiscally_printed');
    expect(r.next.fiscalReceipt?.fiscalNumber).toBe('F-42');
  });
  it('unknown stays in fiscal_pending and blocks new attempts', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const paid = registerCashPayment(order, { amountCents: 1000 }, ctx).next;
    const att = createFiscalAttempt(paid, { adapterId: 'sim' }, ctx);
    const unk = markFiscalUnknown(
      att.next,
      { attemptId: att.attempt.id, errorCode: 'TIMEOUT', errorMessage: 'NAK' },
      ctx,
    );
    expect(unk.next.state).toBe('fiscal_pending');
    expect(() => createFiscalAttempt(unk.next, { adapterId: 'sim' }, ctx)).toThrow(
      FiscalUnknownNoRetryError,
    );
  });
  it('refuses fiscal when card payment is unknown', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const sent = sendToKitchen(order, {}, ctx).next;
    const withCash = registerCashPayment(sent, { amountCents: 500 }, ctx).next;
    const withUnk = registerCardPaymentResult(
      withCash,
      { amountCents: 500, status: 'unknown', terminalTrace: 'x' },
      ctx,
    ).next;
    // Even if remaining shows 0 because paid has only the cash 500, totalCents
    // is 1000 → not paid. We can still verify that an order with an unknown
    // card payment that IS otherwise paid would be blocked.
    const fullCash = registerCashPayment(withUnk, { amountCents: 500 }, ctx).next;
    expect(() => createFiscalAttempt(fullCash, { adapterId: 'sim' }, ctx)).toThrow();
  });
});

describe('close + cancel', () => {
  it('closes a fiscally_printed order', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const paid = registerCashPayment(order, { amountCents: 1000 }, ctx).next;
    const att = createFiscalAttempt(paid, { adapterId: 'sim' }, ctx);
    const printed = markFiscalPrinted(
      att.next,
      { attemptId: att.attempt.id, fiscalNumber: 'F1', fiscalDate: '2026-04-25T12:00:00Z' },
      ctx,
    ).next;
    const r = closeOrder(printed, ctx);
    expect(r.next.state).toBe('closed');
    expect(r.events[0].type).toBe('ORDER_CLOSED');
  });
  it('refuses closing unpaid', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    expect(() => closeOrder(order, ctx)).toThrow(OrderNotPaidError);
  });
  it('cancels an open order', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const r = cancelOrder(order, { reason: 'changed mind' }, ctx);
    expect(r.next.state).toBe('cancelled');
    expect(r.events[0].type).toBe('ORDER_CANCELLED');
  });
  it('refuses cancel after fiscalisation', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const paid = registerCashPayment(order, { amountCents: 1000 }, ctx).next;
    const att = createFiscalAttempt(paid, { adapterId: 'sim' }, ctx);
    const printed = markFiscalPrinted(
      att.next,
      { attemptId: att.attempt.id, fiscalNumber: 'F1', fiscalDate: '' },
      ctx,
    ).next;
    expect(() => cancelOrder(printed, { reason: 'x' }, ctx)).toThrow(OrderFiscalisedError);
  });
  it('refuses illegal transition', () => {
    const { order, ctx } = seedOrder([]);
    const cancelled: any = { ...order, state: 'cancelled' };
    expect(() => cancelOrder(cancelled, { reason: 'x' }, ctx)).toThrow(IllegalTransitionError);
  });
});

describe('event envelope contract', () => {
  it('every event carries mutationId, deviceId, orderLocalId, timestamp', () => {
    const { order, ctx } = seedOrder([{ unitCents: 1000, qty: 1, cat: 'bar' }]);
    const r = applyDiscount(order, { amountCents: 100, note: null }, ctx);
    const e = r.events[0];
    expect(e.mutationId).toMatch(/^mut-/);
    expect(e.deviceId).toBe('dev-test-1');
    expect(e.orderLocalId).toBe(order.id);
    expect(e.localTimestamp).toMatch(/^2026-/);
  });
});
