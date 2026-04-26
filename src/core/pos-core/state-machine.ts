/**
 * Order state machine + transition guards.
 *
 * Transitions are *not* free-form — every action in actions.ts must call
 * `assertCanTransition()` (or one of the higher-level guards) before
 * mutating state. Guards throw typed errors so the UI can pattern-match
 * and show the right Romanian message.
 */
import type { Order, OrderState, FiscalAttempt } from './types';

// ─── Typed errors ───────────────────────────────────────────────────────────

export class PosCoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PosCoreError';
  }
}
export class IllegalTransitionError extends PosCoreError {
  constructor(from: OrderState, to: OrderState) {
    super(`Illegal transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}
export class OrderCancelledError extends PosCoreError {
  constructor() {
    super('Comandă anulată — operația nu este permisă.');
    this.name = 'OrderCancelledError';
  }
}
export class OrderFiscalisedError extends PosCoreError {
  constructor() {
    super('Bon fiscal emis — items și discount nu mai pot fi modificate.');
    this.name = 'OrderFiscalisedError';
  }
}
export class OrderNotPaidError extends PosCoreError {
  constructor(remainingCents: number) {
    super(`Comanda nu este plătită integral — rămas ${remainingCents} cenți.`);
    this.name = 'OrderNotPaidError';
  }
}
export class OfflineCardPaymentError extends PosCoreError {
  constructor() {
    super('Plata cu cardul nu este permisă offline.');
    this.name = 'OfflineCardPaymentError';
  }
}
export class FiscalUnknownNoRetryError extends PosCoreError {
  constructor(attemptId: string) {
    super(
      `Există o încercare fiscală cu status "unknown" (${attemptId}). ` +
        'Recovery manual necesar — nu se face retry automat.',
    );
    this.name = 'FiscalUnknownNoRetryError';
  }
}
export class OrderNotOwnedError extends PosCoreError {
  constructor(localDeviceId: string, ownerDeviceId: string) {
    super(
      `Comanda este deținută de device ${ownerDeviceId}, nu de ${localDeviceId}. ` +
        'Editare offline interzisă fără ownership.',
    );
    this.name = 'OrderNotOwnedError';
  }
}
export class PaymentExceedsRemainingError extends PosCoreError {
  constructor(amountCents: number, remainingCents: number) {
    super(
      `Suma plătită ${amountCents} depășește restul de plată ${remainingCents}.`,
    );
    this.name = 'PaymentExceedsRemainingError';
  }
}
export class EmptyOrderError extends PosCoreError {
  constructor() {
    super('Comanda nu are produse — operația nu este permisă.');
    this.name = 'EmptyOrderError';
  }
}

// ─── Allowed transitions ────────────────────────────────────────────────────

const TRANSITIONS: Record<OrderState, OrderState[]> = {
  draft: ['open', 'cancelled'],
  open: ['sent_to_kitchen', 'partially_paid', 'paid', 'cancelled'],
  sent_to_kitchen: ['partially_paid', 'paid', 'cancelled', 'sent_to_kitchen'],
  partially_paid: ['paid', 'partially_paid'],
  paid: ['fiscal_pending', 'closed'],
  fiscal_pending: ['fiscally_printed', 'fiscal_pending'], // stays here on unknown until manager resolves
  fiscally_printed: ['closed'],
  closed: [],
  cancelled: [],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertCanTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

// ─── High-level guards ──────────────────────────────────────────────────────

export function assertNotCancelled(order: Order): void {
  if (order.state === 'cancelled') throw new OrderCancelledError();
}

/**
 * Items + discount are frozen once any successful fiscal attempt exists.
 * Prevents the classic "edit after the fiscal printer printed" bug.
 */
export function assertNotFiscalised(order: Order): void {
  const hasReceipt =
    order.fiscalReceipt != null ||
    order.fiscalAttempts.some((a) => a.status === 'printed');
  if (hasReceipt) throw new OrderFiscalisedError();
}

export function assertOwnedLocally(
  order: Order,
  localDeviceId: string,
  online: boolean,
): void {
  if (online) return; // server-side ownership check takes over when online
  if (order.ownerDeviceId !== localDeviceId) {
    throw new OrderNotOwnedError(localDeviceId, order.ownerDeviceId);
  }
}

/**
 * No automatic retry on fiscal `unknown`. The operator must explicitly resolve
 * (manager flow) before a NEW fiscal attempt can be created.
 */
export function assertNoUnknownAttempt(order: Order): void {
  const stuck: FiscalAttempt | undefined = order.fiscalAttempts.find(
    (a) => a.status === 'unknown',
  );
  if (stuck) throw new FiscalUnknownNoRetryError(stuck.id);
}

export function assertCardPaymentAllowed(online: boolean): void {
  if (!online) throw new OfflineCardPaymentError();
}

export function assertHasItems(order: Order): void {
  const active = order.items.filter((it) => it.voidedAt == null);
  if (active.length === 0) throw new EmptyOrderError();
}
