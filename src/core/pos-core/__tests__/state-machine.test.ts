import { describe, expect, it } from 'vitest';
import {
  assertCanTransition,
  assertCardPaymentAllowed,
  assertNoUnknownAttempt,
  assertNotCancelled,
  assertNotFiscalised,
  assertOwnedLocally,
  canTransition,
  FiscalUnknownNoRetryError,
  IllegalTransitionError,
  OfflineCardPaymentError,
  OrderCancelledError,
  OrderFiscalisedError,
  OrderNotOwnedError,
} from '../state-machine';
import type { Order } from '../types';

const baseOrder = (over: Partial<Order> = {}): Order => ({
  id: 'o1',
  serverId: null,
  mutationId: 'mut',
  tableId: null,
  state: 'open',
  source: 'pos',
  ownerDeviceId: 'dev-A',
  items: [],
  payments: [],
  discountCents: 0,
  discountNote: null,
  tipCents: 0,
  subtotalCents: 0,
  vatCents: 0,
  totalCents: 0,
  fiscalAttempts: [],
  fiscalReceipt: null,
  openedAt: '2026-04-25T12:00:00Z',
  closedAt: null,
  vatConfig: { defaultRateBp: 1900 },
  version: 0,
  ...over,
});

describe('canTransition', () => {
  it('allows expected transitions', () => {
    expect(canTransition('draft', 'open')).toBe(true);
    expect(canTransition('open', 'sent_to_kitchen')).toBe(true);
    expect(canTransition('paid', 'fiscal_pending')).toBe(true);
    expect(canTransition('fiscally_printed', 'closed')).toBe(true);
    expect(canTransition('fiscal_pending', 'fiscal_pending')).toBe(true); // self-loop on unknown
  });
  it('blocks illegal transitions', () => {
    expect(canTransition('cancelled', 'open')).toBe(false);
    expect(canTransition('closed', 'open')).toBe(false);
    expect(canTransition('draft', 'paid')).toBe(false);
    expect(canTransition('fiscally_printed', 'open')).toBe(false);
  });
  it('throws via assertCanTransition', () => {
    expect(() => assertCanTransition('cancelled', 'open')).toThrow(IllegalTransitionError);
  });
});

describe('assertNotCancelled', () => {
  it('throws on cancelled', () => {
    expect(() => assertNotCancelled(baseOrder({ state: 'cancelled' }))).toThrow(
      OrderCancelledError,
    );
  });
  it('passes on open', () => {
    expect(() => assertNotCancelled(baseOrder({ state: 'open' }))).not.toThrow();
  });
});

describe('assertNotFiscalised', () => {
  it('throws when a printed attempt exists', () => {
    expect(() =>
      assertNotFiscalised(
        baseOrder({
          fiscalAttempts: [
            {
              id: 'a',
              mutationId: 'm',
              orderLocalId: 'o1',
              deviceId: 'dev-A',
              adapterId: 'sim',
              status: 'printed',
              fiscalNumber: 'SIM-1',
              errorCode: null,
              errorMessage: null,
              startedAt: '',
              finishedAt: '',
            },
          ],
        }),
      ),
    ).toThrow(OrderFiscalisedError);
  });
  it('throws when a fiscal_receipt is attached', () => {
    expect(() =>
      assertNotFiscalised(
        baseOrder({
          fiscalReceipt: {
            id: 'r',
            mutationId: 'm',
            fiscalAttemptId: 'a',
            orderLocalId: 'o1',
            fiscalNumber: 'F-1',
            fiscalDate: '',
            deviceId: 'dev-A',
            recoverySource: 'device',
            createdAt: '',
          },
        }),
      ),
    ).toThrow(OrderFiscalisedError);
  });
  it('passes when no successful attempt exists', () => {
    expect(() =>
      assertNotFiscalised(
        baseOrder({
          fiscalAttempts: [
            {
              id: 'a',
              mutationId: 'm',
              orderLocalId: 'o1',
              deviceId: 'dev-A',
              adapterId: 'sim',
              status: 'unknown',
              fiscalNumber: null,
              errorCode: 'TIMEOUT',
              errorMessage: 'x',
              startedAt: '',
              finishedAt: '',
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

describe('assertOwnedLocally', () => {
  it('blocks edits offline by another device', () => {
    expect(() => assertOwnedLocally(baseOrder({ ownerDeviceId: 'dev-B' }), 'dev-A', false)).toThrow(
      OrderNotOwnedError,
    );
  });
  it('allows edits online by another device (server arbitrates)', () => {
    expect(() => assertOwnedLocally(baseOrder({ ownerDeviceId: 'dev-B' }), 'dev-A', true)).not.toThrow();
  });
  it('allows edits offline by owner', () => {
    expect(() => assertOwnedLocally(baseOrder({ ownerDeviceId: 'dev-A' }), 'dev-A', false)).not.toThrow();
  });
});

describe('assertNoUnknownAttempt', () => {
  it('throws when an attempt is unknown', () => {
    expect(() =>
      assertNoUnknownAttempt(
        baseOrder({
          fiscalAttempts: [
            {
              id: 'a',
              mutationId: 'm',
              orderLocalId: 'o1',
              deviceId: 'dev-A',
              adapterId: 'sim',
              status: 'unknown',
              fiscalNumber: null,
              errorCode: 'TIMEOUT',
              errorMessage: '',
              startedAt: '',
              finishedAt: '',
            },
          ],
        }),
      ),
    ).toThrow(FiscalUnknownNoRetryError);
  });
});

describe('assertCardPaymentAllowed', () => {
  it('blocks offline', () => {
    expect(() => assertCardPaymentAllowed(false)).toThrow(OfflineCardPaymentError);
  });
  it('allows online', () => {
    expect(() => assertCardPaymentAllowed(true)).not.toThrow();
  });
});
