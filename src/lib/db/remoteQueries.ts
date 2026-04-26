/**
 * Read selectors over the remote read-model — Sprint 6.
 *
 * Returns shapes friendly to the React panes: per-table maps, kitchen
 * tickets grouped by station, etc.
 */
import type { SqlExecutor } from './executor';

export interface RemoteOrderRow {
  id: string;
  table_id: string | null;
  status: string;
  payment_status: string;
  is_open: number;
  subtotal_cents: number;
  discount_cents: number;
  tip_cents: number;
  total_cents: number;
  currency: string;
  source: string | null;
  opened_at: string | null;
  sent_to_kitchen_at: string | null;
  // Sprint 7
  owner_device_id: string | null;
  owner_expires_at: string | null;
  current_device_can_edit: number;
}

export interface RemoteOrderItemRow {
  id: string;
  order_id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  status: string;
  kitchen_ticket_id: string | null;
  sent_at: string | null;
}

export interface RemoteKitchenTicketRow {
  id: string;
  order_id: string;
  station: string;
  status: string;
  created_at: string | null;
  seen_at: string | null;
  preparation_seconds: number | null;
}

export interface RemoteSnapshot {
  orders: RemoteOrderRow[];
  items: RemoteOrderItemRow[];
  tickets: RemoteKitchenTicketRow[];
}

export async function readRemoteSnapshot(exec: SqlExecutor): Promise<RemoteSnapshot> {
  const [orders, items, tickets] = await Promise.all([
    exec.select<RemoteOrderRow>(
      `SELECT id, table_id, status, payment_status, is_open,
              subtotal_cents, discount_cents, tip_cents, total_cents,
              currency, source, opened_at, sent_to_kitchen_at,
              owner_device_id, owner_expires_at, current_device_can_edit
         FROM remote_orders
        WHERE is_open = 1
        ORDER BY opened_at ASC`,
    ),
    exec.select<RemoteOrderItemRow>(
      `SELECT id, order_id, name, quantity, unit_price_cents,
              line_total_cents, status, kitchen_ticket_id, sent_at
         FROM remote_order_items
        ORDER BY round_number ASC, sent_at ASC`,
    ),
    exec.select<RemoteKitchenTicketRow>(
      `SELECT id, order_id, station, status, created_at, seen_at,
              preparation_seconds
         FROM remote_kitchen_tickets
        WHERE status != 'completed'
        ORDER BY created_at ASC`,
    ),
  ]);
  return { orders, items, tickets };
}
