/**
 * SyncEvent envelope + 13 event types.
 *
 * Every action returns events alongside the next state. The sync engine
 * (Sprint 2) persists them append-only to `events` and ships them via
 * `sync_outbox`. The event payload is the *minimum* the backend needs to
 * reconstruct the change — not the full new order.
 */
import type {
  DeviceId,
  Iso,
  LocalId,
  MutationId,
  PaymentMethod,
  ServerId,
} from './types';

export type EventType =
  | 'ORDER_CREATED'
  | 'ORDER_ITEM_ADDED'
  | 'ORDER_ITEM_VOIDED'
  | 'ORDER_ITEM_QTY_UPDATED'
  | 'DISCOUNT_APPLIED'
  | 'TIP_ADDED'
  | 'SENT_TO_KITCHEN'
  | 'PAYMENT_REGISTERED'
  | 'CARD_PAYMENT_UNKNOWN'
  | 'FISCAL_ATTEMPT_CREATED'
  | 'FISCAL_RECEIPT_PRINTED'
  | 'FISCAL_RECEIPT_UNKNOWN'
  | 'ORDER_CLOSED'
  | 'ORDER_CANCELLED';

export interface SyncEvent<P = unknown> {
  mutationId: MutationId;
  type: EventType;
  localTimestamp: Iso;
  deviceId: DeviceId;
  orderLocalId: LocalId;
  orderServerId: ServerId | null;
  payload: P;
}

// ─── Concrete payloads (helpful for IDE autocomplete) ───────────────────────

export interface OrderCreatedPayload {
  tableId: LocalId | null;
  source: string;
  ownerDeviceId: DeviceId;
}

export interface OrderItemAddedPayload {
  /** Local UUID of the line — backend uses it to map mutations on this
   * item back to the server row it created in _handle_item_added. */
  localItemId: LocalId;
  itemMutationId: MutationId;
  productId: LocalId | null;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  vatRateBp: number;
  modifiers?: Record<string, unknown>;
}

export interface OrderItemVoidedPayload {
  /** Local UUID of the line being voided. The backend resolves the
   * server-side item id by looking up an earlier ORDER_ITEM_ADDED with
   * the same localItemId in pos_sync_events. */
  itemId: LocalId;
  reason: string;
}

export interface OrderItemQtyUpdatedPayload {
  /** Local UUID of the line whose quantity changed. */
  localItemId: LocalId;
  newQuantity: number;
  /** Pre-computed by pos-core so the backend can mirror the totals
   * without re-running the price formula. */
  lineTotalCents: number;
}

export interface DiscountAppliedPayload {
  amountCents: number;
  note: string | null;
}

export interface TipAddedPayload {
  amountCents: number;
}

export interface SentToKitchenPayload {
  ticketIds: LocalId[];
}

export interface PaymentRegisteredPayload {
  paymentMutationId: MutationId;
  method: PaymentMethod;
  amountCents: number;
  status: 'recorded' | 'approved' | 'declined' | 'cancelled';
  terminalAuthCode?: string;
  terminalRrn?: string;
}

export interface CardPaymentUnknownPayload {
  paymentMutationId: MutationId;
  amountCents: number;
  terminalTrace: string;
}

export interface FiscalAttemptCreatedPayload {
  fiscalAttemptId: LocalId;
  adapterId: string;
}

export interface FiscalReceiptPrintedPayload {
  fiscalAttemptId: LocalId;
  fiscalNumber: string;
  fiscalDate: Iso;
  recoverySource: 'device' | 'manual';
}

export interface FiscalReceiptUnknownPayload {
  fiscalAttemptId: LocalId;
  errorCode: string;
  errorMessage: string;
}

export interface OrderClosedPayload {
  closedAt: Iso;
}

export interface OrderCancelledPayload {
  reason: string;
}
