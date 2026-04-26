/**
 * GET /api/pos/sync/pull client.
 *
 * Sprint 6 — incremental snapshot of open orders + their items + active
 * kitchen tickets. Cursor is an ISO timestamp echoed back unchanged.
 */
import { getApiClient } from './client';

export interface RemoteOrder {
  id: string;
  tableId: string | null;
  status: string;
  paymentStatus: string;
  isOpen: boolean;
  subtotal: number;
  discountTotal: number;
  tipTotal: number;
  total: number;
  currency: string;
  source: string;
  openedAt: string | null;
  closedAt: string | null;
  sentToKitchenAt: string | null;
  updatedAt: string | null;
}

export interface RemoteOrderItem {
  id: string;
  orderId: string;
  menuItemId: string | null;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  vatRateBp: number | null;
  status: string;
  kitchenTicketId: string | null;
  roundNumber: number;
  sentAt: string | null;
}

export interface RemoteKitchenTicket {
  id: string;
  orderId: string;
  station: string;
  status: 'pending' | 'preparing' | 'completed';
  createdAt: string | null;
  seenAt: string | null;
  completedAt: string | null;
  preparationSeconds: number | null;
}

export interface PullChangesResponse {
  events: unknown[];
  changes: {
    orders: RemoteOrder[];
    orderItems: RemoteOrderItem[];
    kitchenTickets: RemoteKitchenTicket[];
  };
  nextCursor: string;
  serverTime: string;
}

export async function fetchPullChanges(
  since: string | null,
): Promise<PullChangesResponse> {
  const r = await getApiClient().get<PullChangesResponse>('/api/pos/sync/pull', {
    params: since ? { since } : undefined,
  });
  return r.data;
}
