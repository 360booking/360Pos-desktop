/**
 * Domain types — pure data, no methods.
 *
 * All money is integer cents. All timestamps are ISO-8601 UTC strings.
 * IDs are strings (UUID v4 generated client-side; servers acknowledge with
 * their own server_id, kept alongside the local id).
 */
import type { CategoryType, VatRateBp, TenantVatConfig } from '../vat';

export type Iso = string;
export type LocalId = string;
export type ServerId = string;
export type MutationId = string;
export type DeviceId = string;

// ─── Master data ────────────────────────────────────────────────────────────

export interface Category {
  id: LocalId;
  name: string;
  sortOrder: number;
  station: string | null;        // 'kitchen' | 'bar' | 'pizza' | custom
  type: CategoryType | null;     // drives VAT rate selection
  updatedAt: Iso;
}

export interface Product {
  id: LocalId;
  sku: string | null;
  name: string;
  /** Gross (VAT-inclusive) price in cents. */
  priceCents: number;
  categoryId: LocalId | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
  updatedAt: Iso;
}

export interface RestaurantTable {
  id: LocalId;
  tableNumber: string;
  capacity: number | null;
  qrToken: string | null;
  isReservable: boolean;
  updatedAt: Iso;
}

// ─── Order tree ─────────────────────────────────────────────────────────────

export type OrderState =
  | 'draft'
  | 'open'
  | 'sent_to_kitchen'
  | 'partially_paid'
  | 'paid'
  | 'fiscal_pending'
  | 'fiscally_printed'
  | 'closed'
  | 'cancelled';

export type PaymentMethod = 'cash' | 'card' | 'voucher' | 'online' | 'other';

export type PaymentStatus =
  | 'recorded'   // cash; immediately authoritative
  | 'approved'   // card terminal accepted
  | 'declined'
  | 'cancelled'
  | 'unknown';   // terminal timeout — manager must resolve

export type FiscalAttemptStatus =
  | 'pending'
  | 'printed'
  | 'failed'
  | 'unknown'
  | 'confirmed_failed';

export interface OrderItem {
  id: LocalId;
  mutationId: MutationId;
  productId: LocalId | null;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  /** Computed at insert; may be re-derived but never trusted from payload. */
  lineTotalCents: number;
  /** VAT rate snapshot at line time (basis points). May be 0 (exempt). */
  vatRateBp: VatRateBp;
  /** Free-form modifiers, kept here for round-tripping; pos-core does not interpret them. */
  modifiers: Record<string, unknown>;
  kitchenTicketId: LocalId | null;
  sentAt: Iso | null;
  voidedAt: Iso | null;
  voidReason: string | null;
  createdAt: Iso;
}

export interface Payment {
  id: LocalId;
  mutationId: MutationId;
  method: PaymentMethod;
  amountCents: number;
  status: PaymentStatus;
  terminalAuthCode: string | null;
  terminalRrn: string | null;
  terminalTrace: string | null;
  rawResponse: string | null;
  errorCode: string | null;
  createdAt: Iso;
}

export interface FiscalAttempt {
  id: LocalId;
  mutationId: MutationId;
  orderLocalId: LocalId;
  deviceId: DeviceId;
  adapterId: string;
  status: FiscalAttemptStatus;
  fiscalNumber: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Iso;
  finishedAt: Iso | null;
}

export interface FiscalReceipt {
  id: LocalId;
  mutationId: MutationId;
  fiscalAttemptId: LocalId;
  orderLocalId: LocalId;
  fiscalNumber: string;
  fiscalDate: Iso;
  deviceId: DeviceId;
  recoverySource: 'device' | 'manual';
  createdAt: Iso;
}

export type KitchenTicketStatus =
  | 'pending'
  | 'seen'
  | 'in_prep'
  | 'ready'
  | 'completed'
  | 'cancelled'
  | 'modified';

export interface KitchenTicket {
  id: LocalId;
  mutationId: MutationId;
  orderLocalId: LocalId;
  station: string;
  status: KitchenTicketStatus;
  /** When this ticket replaces a prior one (MODIFICARE). */
  parentTicketId: LocalId | null;
  printedAt: Iso | null;
  seenAt: Iso | null;
  inPrepAt: Iso | null;
  readyAt: Iso | null;
  completedAt: Iso | null;
  /** Subset of order items + per-item notes; pos-core does not interpret. */
  payload: Record<string, unknown>;
}

export type PrintJobStatus = 'pending' | 'printed' | 'failed' | 'unknown' | 'reprint';

export interface PrintJob {
  id: LocalId;
  mutationId: MutationId;
  station: string;
  template: 'kitchen_ticket' | 'bar_ticket' | 'cancel_ticket' | 'reprint';
  data: Record<string, unknown>;
  copies: number;
  status: PrintJobStatus;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Iso;
  finishedAt: Iso | null;
}

export interface PosDevice {
  id: DeviceId;
  hostname: string;
  appVersion: string;
  pairedAt: Iso;
}

// ─── Aggregate ──────────────────────────────────────────────────────────────

export interface Order {
  id: LocalId;
  serverId: ServerId | null;
  mutationId: MutationId;
  tableId: LocalId | null;
  state: OrderState;
  source: 'pos' | 'online' | 'qr' | 'home_delivery' | 'aggregator' | string;

  /** Device that owns offline edit rights for this order. */
  ownerDeviceId: DeviceId;

  items: OrderItem[];
  payments: Payment[];

  discountCents: number;
  discountNote: string | null;
  tipCents: number;

  /** Snapshot of computed totals; the calculator is the source of truth. */
  subtotalCents: number;
  vatCents: number;
  totalCents: number;

  fiscalAttempts: FiscalAttempt[];
  fiscalReceipt: FiscalReceipt | null;

  openedAt: Iso;
  closedAt: Iso | null;

  /** Tenant config snapshot used for VAT computation. */
  vatConfig: TenantVatConfig;

  /** Monotonic — backend bumps on each mutation. */
  version: number;
}
