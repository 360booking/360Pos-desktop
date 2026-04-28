/**
 * RestaurantOrder (REST) ↔ pos-core Order mapper.
 *
 * Faza 1: when the desktop is online we hit the same /api/restaurant
 * endpoints as the browser POS. Server is the source of truth, so after
 * any successful REST call we replace the local Zustand `currentOrder`
 * with a fresh snapshot derived here. Fields the local pos-core cares
 * about that the REST shape doesn't carry (mutationId, vatConfig,
 * sync metadata) are filled with safe defaults — no event is emitted on
 * this path because the server already persisted the change.
 */
import { ROMANIAN_DEFAULT_VAT_BP, type Order, type OrderItem } from '@/core/pos-core';
import type {
  OrderStatus as RestStatus,
  RestaurantOrder,
  OrderItem as RestOrderItem,
} from './restaurantOrders';

function cents(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.round(value * 100);
}

function vatRateToBp(rate: number | null | undefined): number {
  if (rate == null || Number.isNaN(rate)) return ROMANIAN_DEFAULT_VAT_BP;
  // RestaurantOrderItem.vatRate is decimal (0.19 → 19% → 1900 bp).
  return Math.round(rate * 10000);
}

function mapStatus(status: RestStatus, paymentStatus: string): Order['state'] {
  if (status === 'cancelled' || status === 'refunded') return 'cancelled';
  if (paymentStatus === 'paid') return 'paid';
  if (status === 'sent' || status === 'preparing' || status === 'ready' || status === 'served' || status === 'delivered') {
    return 'sent_to_kitchen';
  }
  return 'draft';
}

function mapItem(it: RestOrderItem): OrderItem {
  return {
    id: it.id,
    mutationId: it.id, // server-assigned id reused as mutationId placeholder
    productId: it.menuItemId,
    productName: it.nameSnapshot,
    quantity: it.quantity,
    unitPriceCents: cents(it.unitPrice),
    lineTotalCents: cents(it.lineTotal),
    vatRateBp: ROMANIAN_DEFAULT_VAT_BP,
    modifiers: {},
    kitchenTicketId: it.kitchenTicketId,
    sentAt: it.kitchenTicketId ? null : null,
    voidedAt: it.status === 'void' ? new Date().toISOString() : null,
    voidReason: it.status === 'void' ? 'voided' : null,
    createdAt: new Date().toISOString(),
  };
}

/** Replace the local `currentOrder` with a snapshot derived from the
 *  RestaurantOrder returned by the backend. Caller passes `deviceId`
 *  so the local lock state stays consistent. */
export function restaurantOrderToOrder(remote: RestaurantOrder, deviceId: string): Order {
  return {
    id: remote.id,
    serverId: remote.id,
    mutationId: remote.id,
    tableId: remote.tableId,
    state: mapStatus(remote.status, remote.paymentStatus),
    source: remote.source,
    ownerDeviceId: deviceId,
    items: remote.items.filter((it) => it.status !== 'void').map(mapItem),
    payments: [],
    discountCents: cents(remote.discountTotal),
    discountNote: null,
    tipCents: 0,
    subtotalCents: cents(remote.subtotal),
    vatCents: cents(remote.taxTotal),
    totalCents: cents(remote.total),
    fiscalAttempts: [],
    fiscalReceipt: remote.fiscalReceiptNumber
      ? {
          id: remote.id + ':receipt',
          mutationId: remote.id + ':receipt',
          fiscalAttemptId: remote.id + ':attempt',
          orderLocalId: remote.id,
          fiscalNumber: remote.fiscalReceiptNumber,
          fiscalDate: remote.fiscalIssuedAt ?? remote.updatedAt ?? new Date().toISOString(),
          deviceId,
          recoverySource: 'manual',
          createdAt: remote.fiscalIssuedAt ?? new Date().toISOString(),
        }
      : null,
    openedAt: remote.createdAt ?? new Date().toISOString(),
    closedAt: remote.closedAt,
    vatConfig: { defaultRateBp: vatRateToBp(null) },
    version: 1,
  };
}
