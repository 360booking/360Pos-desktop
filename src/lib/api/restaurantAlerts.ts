/**
 * Pending approval + waiter call adapters pentru POS desktop.
 *
 * Mirror exact al endpoint-urilor folosite de browser POS — desktop-ul
 * pollează aceleași rute la 8s și acționează direct (approve / reject /
 * ack / close). Backend-ul e source of truth, refresh-ul după acțiune
 * recheamă listele.
 */
import { getApiClient } from './client';

export type WaiterCallReason = 'assistance' | 'bill' | 'water' | 'order' | 'other';
export type WaiterCallStatus = 'open' | 'acknowledged' | 'closed';

export interface PendingApprovalItem {
  id: string;
  menuItemId: string;
  name: string;
  variantLabel: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  kitchenNotes: string | null;
}

export interface PendingApprovalOrder {
  orderId: string;
  orderNumber: string;
  source: string;
  tableId: string | null;
  tableName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  items: PendingApprovalItem[];
  total: number;
  currency: string;
  paymentStatus: string;
  posApprovalStatus: 'pending' | 'approved' | 'rejected' | 'not_required';
  createdAt: string | null;
  notes: string | null;
}

export interface WaiterCall {
  id: string;
  tableId: string | null;
  tableNumber: string | null;
  reason: WaiterCallReason;
  note: string | null;
  status: WaiterCallStatus;
  source: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  createdAt: string | null;
}

export const restaurantAlertsApi = {
  listPendingApproval: async (): Promise<PendingApprovalOrder[]> => {
    const res = await getApiClient().get<PendingApprovalOrder[]>(
      '/api/restaurant/orders/pending-approval',
    );
    return Array.isArray(res.data) ? res.data : [];
  },

  approveOrder: async (orderId: string): Promise<unknown> => {
    const res = await getApiClient().post(`/api/restaurant/orders/${orderId}/approve`);
    return res.data;
  },

  rejectOrder: async (orderId: string, reason?: string): Promise<unknown> => {
    const res = await getApiClient().post(
      `/api/restaurant/orders/${orderId}/reject`,
      reason ? { reason } : {},
    );
    return res.data;
  },

  listWaiterCalls: async (includeClosed = false): Promise<WaiterCall[]> => {
    const qs = includeClosed ? '?includeClosed=true' : '';
    const res = await getApiClient().get<WaiterCall[]>(`/api/restaurant/waiter-calls${qs}`);
    return Array.isArray(res.data) ? res.data : [];
  },

  ackWaiterCall: async (callId: string): Promise<WaiterCall> => {
    const res = await getApiClient().patch<WaiterCall>(
      `/api/restaurant/waiter-calls/${callId}/ack`,
    );
    return res.data;
  },

  closeWaiterCall: async (callId: string): Promise<WaiterCall> => {
    const res = await getApiClient().patch<WaiterCall>(
      `/api/restaurant/waiter-calls/${callId}/close`,
    );
    return res.data;
  },
};
