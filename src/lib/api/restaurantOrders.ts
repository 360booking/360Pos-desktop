/**
 * Restaurant orders REST adapter — POS desktop.
 *
 * Mirrors the same /api/restaurant/orders/* endpoints the browser POS
 * uses (frontend/src/lib/api/restaurant_orders.ts). When the desktop is
 * online we call these directly so behaviour matches the web UI byte-for
 * byte; when offline we fall back to the local event-sourced outbox.
 *
 * Server is the source of truth: every successful call returns the full
 * RestaurantOrder and the caller is expected to replace local state with
 * that snapshot rather than reconciling a delta.
 */
import type { AxiosError } from 'axios';

import { getApiClient } from './client';

export type OrderSource = 'pos' | 'qr' | 'online' | 'home_delivery' | 'glovo' | 'bolt_food' | 'tazz' | 'other';
export type OrderStatus = 'draft' | 'sent' | 'preparing' | 'ready' | 'served' | 'delivered' | 'cancelled' | 'refunded';
export type OrderPaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded';
export type PaymentMethod =
  | 'cash'
  | 'card'
  | 'card_pos_manual'
  | 'stripe'
  | 'stripe_online'
  | 'glovo'
  | 'tazz'
  | 'bolt_food'
  | 'voucher'
  | 'other';

export interface OrderItemModifier {
  name: string;
  delta_price?: number;
}

export interface OrderItem {
  id: string;
  menuItemId: string;
  nameSnapshot: string;
  variantLabel: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  modifiers: OrderItemModifier[];
  kitchenNotes: string | null;
  status: string;
  kitchenTicketId: string | null;
}

export interface OrderPayment {
  id: string;
  method: PaymentMethod;
  amount: number;
  currency: string;
  reference: string | null;
  receivedAt: string | null;
}

export interface KitchenTicket {
  id: string;
  station: string;
  printedAt: string | null;
  seenAt: string | null;
  completedAt: string | null;
}

export interface RestaurantOrder {
  id: string;
  tenantId: string;
  restaurantId: string;
  source: OrderSource;
  externalOrderId: string | null;
  tableId: string | null;
  tableNumber: string | null;
  waiterId: string | null;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  customer: {
    name: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
  };
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  currency: string;
  notes: string | null;
  sentToKitchenAt: string | null;
  closedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  items: OrderItem[];
  payments: OrderPayment[];
  kitchenTickets: KitchenTicket[];
  fiscalReceiptNumber?: string | null;
  fiscalIssuedAt?: string | null;
}

export interface CreateOrderInput {
  source?: OrderSource;
  tableId?: string | null;
  notes?: string;
}

export interface AddItemInput {
  menuItemId: string;
  quantity?: number;
  variantLabel?: string;
  modifiers?: OrderItemModifier[];
  kitchenNotes?: string;
}

export interface PaymentInput {
  method: PaymentMethod;
  amount: number;
  reference?: string;
  customerCif?: string;
  // Faza 2 — fiscal pass-through used by the cash-offline sync worker.
  // When the desktop emitted the bon fiscal locally (DP-25X), it attaches
  // the receipt number + source so the backend skips its own issuance.
  fiscalReceiptNumber?: string;
  fiscalizationSource?: 'cloud' | 'device_offline';
}

export interface PaymentRequestOptions {
  /** Sent as the `Idempotency-Key` HTTP header. The server stores the
   *  response under this key so a retry returns the original outcome
   *  without creating a duplicate payment. */
  idempotencyKey?: string;
}

/** Custom error type that preserves the HTTP status so callers can branch
 *  on 409 (conflict / table already has a draft), 404, etc. without having
 *  to reach into AxiosError internals. */
export class RestaurantOrderApiError extends Error {
  readonly status: number | null;
  readonly detail: unknown;
  readonly existingOrderId: string | null;
  constructor(message: string, status: number | null, detail: unknown, existingOrderId: string | null = null) {
    super(message);
    this.name = 'RestaurantOrderApiError';
    this.status = status;
    this.detail = detail;
    this.existingOrderId = existingOrderId;
  }
}

/** Thrown when a mutation targets an order that the server says is no
 *  longer mutable (cancelled / closed / paid / not found). Caller should
 *  clear the cart and prompt the operator to re-pick the table. */
export class OrderClosedError extends Error {
  readonly orderId: string | null;
  readonly reason: 'cancelled' | 'not_found' | 'closed';
  constructor(message: string, orderId: string | null, reason: 'cancelled' | 'not_found' | 'closed') {
    super(message);
    this.name = 'OrderClosedError';
    this.orderId = orderId;
    this.reason = reason;
  }
}

/** Thrown when a cart mutation is attempted while the desktop is offline
 *  (or the REST call hit a transport failure). Faza 2 — POS desktop is
 *  online-first; we never write speculative mutations into local SQLite
 *  for new-order/add-item/send-to-kitchen/etc. UI catches this and shows
 *  a friendly "offline" toast while keeping cached orders read-only. */
export class OfflineMutationError extends Error {
  readonly action: string;
  constructor(action: string, message?: string) {
    super(
      message ??
        'Comenzile sunt read-only cât timp ești offline. Așteaptă revenirea conexiunii.',
    );
    this.name = 'OfflineMutationError';
    this.action = action;
  }
}

/** Map a backend mutation error onto OrderClosedError when the message
 *  indicates the order is no longer mutable. The backend returns 400
 *  with a Romanian detail string ("Comandă anulată — ...") for cancelled
 *  orders and 404 when the order id doesn't exist. Both mean the same
 *  thing for the cart: drop it. */
export function classifyOrderMutationError(
  err: RestaurantOrderApiError,
  orderId: string | null,
): OrderClosedError | null {
  const msg = (err.message || '').toLowerCase();
  if (err.status === 404 && msg.includes('comanda')) {
    return new OrderClosedError(
      'Comanda nu mai există pe server.',
      orderId,
      'not_found',
    );
  }
  if (err.status === 400 && (msg.includes('anulat') || msg.includes('cancelled'))) {
    return new OrderClosedError(
      'Comanda a fost anulată pe alt dispozitiv.',
      orderId,
      'cancelled',
    );
  }
  return null;
}

function wrap(err: unknown): RestaurantOrderApiError {
  const ax = err as AxiosError<{ detail?: unknown; existing_order_id?: string; existingOrderId?: string }>;
  const status = ax.response?.status ?? null;
  const data = ax.response?.data ?? null;
  const detail = (data && typeof data === 'object' && 'detail' in data) ? (data as { detail?: unknown }).detail : data;
  // Backend's table_has_active_order 409 ships the conflicting order id as
  // `detail.existingOrderId` (camelCase, nested). Older / other endpoints
  // ship `existing_order_id` at the root. Accept both shapes — without
  // this, the desktop falls through to the draft-only fallback list and
  // misses any sent/ready order on the same table.
  const candidates: Array<unknown> = [];
  const pushIf = (obj: unknown, ...keys: string[]) => {
    if (obj && typeof obj === 'object') {
      for (const k of keys) {
        const v = (obj as Record<string, unknown>)[k];
        if (typeof v === 'string' && v) candidates.push(v);
      }
    }
  };
  pushIf(data, 'existing_order_id', 'existingOrderId');
  pushIf(detail, 'existing_order_id', 'existingOrderId');
  const existing = (candidates[0] as string | undefined) ?? null;
  // Surface a useful message: prefer the structured detail.message when
  // present (backend ships {code, message, existingOrderId}) over a raw
  // JSON-stringified detail object that would render as "[object Object]".
  let msg: string;
  if (typeof detail === 'string') {
    msg = detail;
  } else if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') {
    msg = (detail as { message: string }).message;
  } else {
    msg = ax.message;
  }
  return new RestaurantOrderApiError(msg, status, detail, existing);
}

export const restaurantOrdersApi = {
  list: async (params?: { status?: OrderStatus; source?: OrderSource; limit?: number }): Promise<RestaurantOrder[]> => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.source) qs.set('source', params.source);
    if (params?.limit) qs.set('limit', String(params.limit));
    try {
      const res = await getApiClient().get<RestaurantOrder[]>(
        `/api/restaurant/orders${qs.toString() ? `?${qs}` : ''}`,
      );
      return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
      throw wrap(err);
    }
  },

  get: async (orderId: string): Promise<RestaurantOrder> => {
    try {
      const res = await getApiClient().get<RestaurantOrder>(`/api/restaurant/orders/${orderId}`);
      return res.data;
    } catch (err) {
      throw wrap(err);
    }
  },

  create: async (input: CreateOrderInput = {}): Promise<RestaurantOrder> => {
    try {
      const res = await getApiClient().post<RestaurantOrder>('/api/restaurant/orders', input);
      return res.data;
    } catch (err) {
      throw wrap(err);
    }
  },

  addItem: async (orderId: string, input: AddItemInput): Promise<RestaurantOrder> => {
    try {
      const res = await getApiClient().post<RestaurantOrder>(
        `/api/restaurant/orders/${orderId}/items`,
        input,
      );
      return res.data;
    } catch (err) {
      throw wrap(err);
    }
  },

  updateItem: async (orderId: string, itemId: string, input: Partial<AddItemInput>): Promise<RestaurantOrder> => {
    try {
      const res = await getApiClient().patch<RestaurantOrder>(
        `/api/restaurant/orders/${orderId}/items/${itemId}`,
        input,
      );
      return res.data;
    } catch (err) {
      throw wrap(err);
    }
  },

  removeItem: async (orderId: string, itemId: string): Promise<RestaurantOrder> => {
    try {
      const res = await getApiClient().delete<RestaurantOrder>(
        `/api/restaurant/orders/${orderId}/items/${itemId}`,
      );
      return res.data;
    } catch (err) {
      throw wrap(err);
    }
  },

  sendToKitchen: async (orderId: string): Promise<RestaurantOrder> => {
    try {
      const res = await getApiClient().post<RestaurantOrder>(
        `/api/restaurant/orders/${orderId}/send`,
      );
      return res.data;
    } catch (err) {
      throw wrap(err);
    }
  },

  recordPayment: async (
    orderId: string,
    input: PaymentInput,
    opts: PaymentRequestOptions = {},
  ): Promise<RestaurantOrder> => {
    try {
      const headers: Record<string, string> = {};
      if (opts.idempotencyKey) {
        headers['Idempotency-Key'] = opts.idempotencyKey;
      }
      const res = await getApiClient().post<RestaurantOrder>(
        `/api/restaurant/orders/${orderId}/payments`,
        input,
        { headers },
      );
      return res.data;
    } catch (err) {
      throw wrap(err);
    }
  },

  cancel: async (orderId: string, reason?: string): Promise<RestaurantOrder> => {
    try {
      const res = await getApiClient().post<RestaurantOrder>(
        `/api/restaurant/orders/${orderId}/cancel`,
        { reason },
      );
      return res.data;
    } catch (err) {
      throw wrap(err);
    }
  },
};

/** Resilient open-table flow that mirrors what the browser does:
 *  POST /api/restaurant/orders → either returns the new draft or 409
 *  with `existing_order_id`. On 409 we GET the existing order so the
 *  caller always ends up with the canonical RestaurantOrder.
 *
 *  NB: backend currently raises HTTPException(409, detail=…) and may
 *  not always include `existing_order_id`. When missing, we fall back
 *  to listing draft orders and picking the one that matches `tableId`.
 */
export async function openTableViaRest(tableId: string): Promise<RestaurantOrder> {
  try {
    return await restaurantOrdersApi.create({ source: 'pos', tableId });
  } catch (err) {
    if (!(err instanceof RestaurantOrderApiError) || err.status !== 409) throw err;
    if (err.existingOrderId) {
      return restaurantOrdersApi.get(err.existingOrderId);
    }
    // Fallback: the backend's 409 should always carry existingOrderId,
    // but tolerate older / partial payloads by scanning OPEN orders on
    // this table — not just drafts. A waiter on another device may have
    // already sent the order to the kitchen (status=sent/ready); we
    // still want to resume it instead of bouncing the table tap.
    const recent = await restaurantOrdersApi.list({ source: 'pos', limit: 100 });
    const match = recent.find(
      (o) => o.tableId === tableId && o.status !== 'cancelled' && o.status !== 'refunded',
    );
    if (match) return match;
    throw err;
  }
}
