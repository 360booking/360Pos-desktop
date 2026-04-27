/**
 * Sprint 11.8 — resume an existing remote order into pos-core's
 * `Order` shape so the cart can display it like a fresh draft.
 *
 * Mirrors the browser POS pattern: `orders` (server-side) is the
 * single source of truth, `activeOrderId` is just a pointer, and
 * tapping a table that already has an open order selects it instead
 * of creating a new one. On desktop we don't have a live `orders`
 * array — we have the local `remote_orders` cache populated by the
 * pull cycle. This helper bridges that cache back into the in-memory
 * `currentOrder` zustand slot the cart UI reads from.
 *
 * NOT a state-machine reload: the resumed order is a UI snapshot of
 * what the server thinks. New mutations (addItem, sendToKitchen,
 * pay) generated against it carry the SAME order id (which is also
 * the server id), so backend forwarders match the existing
 * RestaurantOrder by primary key without going through the local→
 * server resolution table.
 */
import type { SqlExecutor } from '@/lib/db/executor';
import {
  ROMANIAN_DEFAULT_VAT_BP,
  type FiscalAttempt,
  type FiscalAttemptStatus,
  type Order,
  type OrderItem,
  type OrderState,
} from '@/core/pos-core';

interface RemoteOrderJoin {
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
  closed_at: string | null;
  sent_to_kitchen_at: string | null;
  updated_at: string | null;
}

interface RemoteItemJoin {
  id: string;
  order_id: string;
  menu_item_id: string | null;
  name: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  vat_rate_bp: number | null;
  status: string;
  kitchen_ticket_id: string | null;
  round_number: number | null;
  sent_at: string | null;
}

interface FiscalAttemptRow {
  id: string;
  mutation_id: string;
  order_local_id: string;
  device_id: string;
  provider: string;
  status: string;
  fiscal_number: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

const FISCAL_STATUS_VALUES: ReadonlySet<FiscalAttemptStatus> = new Set([
  'pending',
  'printed',
  'failed',
  'unknown',
  'confirmed_failed',
]);

function coerceFiscalStatus(raw: string): FiscalAttemptStatus {
  return (FISCAL_STATUS_VALUES.has(raw as FiscalAttemptStatus)
    ? raw
    : 'unknown') as FiscalAttemptStatus;
}

/**
 * Pull persisted fiscal attempts for an order. Schema lives in
 * `src/sql/migrations/0006_fiscal_attempts.sql`; rows are written by the Rust
 * `fiscal_print_receipt` command (B9). Returning [] for un-paired/cold orders
 * is fine — pos-core treats missing attempts as "no fiscalization yet".
 */
export async function loadFiscalAttempts(
  exec: SqlExecutor,
  orderLocalId: string,
): Promise<FiscalAttempt[]> {
  const rows = await exec.select<FiscalAttemptRow>(
    `SELECT id, mutation_id, order_local_id, device_id, provider, status,
            fiscal_number, error_code, error_message, created_at, updated_at
       FROM fiscal_attempts
      WHERE order_local_id = ?
      ORDER BY created_at ASC`,
    [orderLocalId],
  );
  return rows.map((row) => {
    const status = coerceFiscalStatus(row.status);
    const finished = status !== 'pending';
    return {
      id: row.id,
      mutationId: row.mutation_id,
      orderLocalId: row.order_local_id,
      deviceId: row.device_id,
      adapterId: row.provider,
      status,
      fiscalNumber: row.fiscal_number ?? null,
      errorCode: row.error_code ?? null,
      errorMessage: row.error_message ?? null,
      startedAt: row.created_at,
      finishedAt: finished ? row.updated_at : null,
    } satisfies FiscalAttempt;
  });
}

/** Maps backend `status` (draft|sent|preparing|ready|served|paid|...)
 *  onto pos-core's `OrderState`. The cart's button-state machine
 *  (Trimite vs Trimite update vs Trimis) actually keys off
 *  per-item `sentAt` rather than `state`, so the mapping here only
 *  needs to be coarse-correct — open vs sent vs paid vs cancelled.
 */
function mapState(status: string, paymentStatus: string): OrderState {
  if (paymentStatus === 'paid') return 'paid';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'closed') return 'closed';
  if (status === 'draft') return 'draft';
  // sent / preparing / ready / served all behave like "sent to kitchen"
  // for the cart UI (locked send button, items show "Trimis").
  return 'sent_to_kitchen';
}

export async function loadOrderFromRemote(
  exec: SqlExecutor,
  orderId: string,
): Promise<Order | null> {
  const orderRows = await exec.select<RemoteOrderJoin>(
    `SELECT id, table_id, status, payment_status, is_open,
            subtotal_cents, discount_cents, tip_cents, total_cents,
            currency, source, opened_at, closed_at, sent_to_kitchen_at,
            updated_at
       FROM remote_orders WHERE id = ? LIMIT 1`,
    [orderId],
  );
  if (orderRows.length === 0) return null;
  const r = orderRows[0];

  const itemRows = await exec.select<RemoteItemJoin>(
    `SELECT id, order_id, menu_item_id, name, quantity, unit_price_cents,
            line_total_cents, vat_rate_bp, status, kitchen_ticket_id,
            round_number, sent_at
       FROM remote_order_items WHERE order_id = ?
       ORDER BY round_number ASC, sent_at ASC`,
    [orderId],
  );

  const fiscalAttempts = await loadFiscalAttempts(exec, r.id);

  const items: OrderItem[] = itemRows.map((row) => ({
    id: row.id,
    mutationId: row.id, // remote items don't carry a separate mutation_id
    productId: row.menu_item_id,
    productName: row.name,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    lineTotalCents: row.line_total_cents,
    vatRateBp: (row.vat_rate_bp ?? ROMANIAN_DEFAULT_VAT_BP) as number,
    modifiers: {},
    kitchenTicketId: row.kitchen_ticket_id,
    sentAt: row.sent_at,
    voidedAt: row.status === 'voided' ? (row.sent_at ?? new Date().toISOString()) : null,
    voidReason: row.status === 'voided' ? 'voided server-side' : null,
    createdAt: row.sent_at ?? new Date().toISOString(),
  }));

  const order: Order = {
    id: r.id,
    serverId: r.id,
    mutationId: r.id,
    tableId: r.table_id,
    state: mapState(r.status, r.payment_status),
    source: (r.source ?? 'pos') as Order['source'],
    ownerDeviceId: '',
    items,
    payments: [],
    discountCents: r.discount_cents ?? 0,
    discountNote: null,
    tipCents: r.tip_cents ?? 0,
    subtotalCents: r.subtotal_cents ?? 0,
    vatCents: Math.max(0, (r.total_cents ?? 0) - (r.subtotal_cents ?? 0)),
    totalCents: r.total_cents ?? 0,
    fiscalAttempts,
    fiscalReceipt: null,
    openedAt: r.opened_at ?? new Date().toISOString(),
    closedAt: r.closed_at,
    vatConfig: { defaultRateBp: ROMANIAN_DEFAULT_VAT_BP },
    version: 0,
  };
  return order;
}
