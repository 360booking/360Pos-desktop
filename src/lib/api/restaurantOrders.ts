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

function wrap(err: unknown): RestaurantOrderApiError {
  const ax = err as AxiosError<{ detail?: unknown; existing_order_id?: string }>;
  const status = ax.response?.status ?? null;
  const data = ax.response?.data ?? null;
  const detail = (data && typeof data === 'object' && 'detail' in data) ? (data as { detail?: unknown }).detail : data;
  const existing = (data && typeof data === 'object' && 'existing_order_id' in data)
    ? String((data as { existing_order_id?: string }).existing_order_id ?? '')
    : null;
  const msg = typeof detail === 'string' ? detail : ax.message;
  return new RestaurantOrderApiError(msg, status, detail, existing || null);
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

  recordPayment: async (orderId: string, input: PaymentInput): Promise<RestaurantOrder> => {
    try {
      const res = await getApiClient().post<RestaurantOrder>(
        `/api/restaurant/orders/${orderId}/payments`,
        input,
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
    // Fallback: scan recent drafts for the same table.
    const recent = await restaurantOrdersApi.list({ status: 'draft', source: 'pos', limit: 50 });
    const match = recent.find((o) => o.tableId === tableId);
    if (match) return match;
    throw err;
  }
}
