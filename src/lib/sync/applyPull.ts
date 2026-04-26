/**
 * Merge a /api/pos/sync/pull response into the local SQLite read model.
 * Sprint 6 / 2.
 *
 * Behaviour:
 *  - UPSERT every order returned. If `isOpen` flips to false, we delete
 *    the row (and its items via FK CASCADE) so TablesPane stops showing
 *    the closed tab. Closed orders that never landed in the cache stay
 *    absent — no work needed.
 *  - For each order returned, replace its full set of items: the backend
 *    re-ships every line whenever the parent order's updated_at moves,
 *    so a per-order delete+insert is correct.
 *  - Kitchen tickets are full-replaced on every pull (the backend ships
 *    every active ticket; anything missing has been completed).
 *
 * The merge runs inside a single SQLite transaction so a failure can't
 * leave the cache in a half-consistent state. We never touch the local
 * `events` / `sync_outbox` tables here — the outbox is the desktop's own
 * source of truth and a remote pull cannot stomp on a pending mutation.
 */
import type { SqlExecutor } from '@/lib/db/executor';
import type { PullChangesResponse } from '@/lib/api/pull';

export interface ApplyPullResult {
  ordersUpserted: number;
  ordersDropped: number;
  itemsReplaced: number;
  ticketsReplaced: number;
  cursor: string;
}

export async function applyPullChanges(
  exec: SqlExecutor,
  pull: PullChangesResponse,
): Promise<ApplyPullResult> {
  const { changes, nextCursor } = pull;

  return exec.transaction(async (tx) => {
    let ordersUpserted = 0;
    let ordersDropped = 0;
    let itemsReplaced = 0;

    for (const o of changes.orders) {
      if (!o.isOpen) {
        // Closed order — drop from cache. CASCADE removes items.
        await tx.execute(`DELETE FROM remote_orders WHERE id = ?`, [o.id]);
        ordersDropped += 1;
        continue;
      }
      await tx.execute(
        `INSERT INTO remote_orders (id, table_id, status, payment_status, is_open,
           subtotal_cents, discount_cents, tip_cents, total_cents, currency, source,
           opened_at, closed_at, sent_to_kitchen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           table_id = excluded.table_id,
           status = excluded.status,
           payment_status = excluded.payment_status,
           is_open = excluded.is_open,
           subtotal_cents = excluded.subtotal_cents,
           discount_cents = excluded.discount_cents,
           tip_cents = excluded.tip_cents,
           total_cents = excluded.total_cents,
           currency = excluded.currency,
           source = excluded.source,
           opened_at = excluded.opened_at,
           closed_at = excluded.closed_at,
           sent_to_kitchen_at = excluded.sent_to_kitchen_at,
           updated_at = excluded.updated_at,
           fetched_at = datetime('now')`,
        [
          o.id,
          o.tableId,
          o.status,
          o.paymentStatus,
          o.isOpen ? 1 : 0,
          Math.round((o.subtotal ?? 0) * 100),
          Math.round((o.discountTotal ?? 0) * 100),
          Math.round((o.tipTotal ?? 0) * 100),
          Math.round((o.total ?? 0) * 100),
          o.currency,
          o.source,
          o.openedAt,
          o.closedAt,
          o.sentToKitchenAt,
          o.updatedAt ?? new Date().toISOString(),
        ],
      );
      ordersUpserted += 1;

      // Per-order full re-list: clear and reinsert.
      await tx.execute(`DELETE FROM remote_order_items WHERE order_id = ?`, [o.id]);
      const linesForOrder = changes.orderItems.filter((it) => it.orderId === o.id);
      for (const it of linesForOrder) {
        await tx.execute(
          `INSERT INTO remote_order_items (id, order_id, menu_item_id, name,
             quantity, unit_price_cents, line_total_cents, vat_rate_bp, status,
             kitchen_ticket_id, round_number, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            it.id,
            it.orderId,
            it.menuItemId,
            it.name,
            it.quantity,
            it.unitPriceCents,
            it.lineTotalCents,
            it.vatRateBp,
            it.status,
            it.kitchenTicketId,
            it.roundNumber,
            it.sentAt,
          ],
        );
        itemsReplaced += 1;
      }
    }

    // Kitchen tickets: full replace. Backend only ships active tickets,
    // so anything not in this batch is completed and should disappear.
    await tx.execute(`DELETE FROM remote_kitchen_tickets`);
    let ticketsReplaced = 0;
    for (const t of changes.kitchenTickets) {
      await tx.execute(
        `INSERT INTO remote_kitchen_tickets (id, order_id, station, status,
           created_at, seen_at, completed_at, preparation_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.id,
          t.orderId,
          t.station,
          t.status,
          t.createdAt,
          t.seenAt,
          t.completedAt,
          t.preparationSeconds,
        ],
      );
      ticketsReplaced += 1;
    }

    // Persist cursor for the next pull.
    await tx.execute(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES ('sync.pull.cursor', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = datetime('now')`,
      [JSON.stringify(nextCursor)],
    );

    return {
      ordersUpserted,
      ordersDropped,
      itemsReplaced,
      ticketsReplaced,
      cursor: nextCursor,
    };
  });
}

export async function readPullCursor(exec: SqlExecutor): Promise<string | null> {
  const rows = await exec.select<{ value_json: string }>(
    `SELECT value_json FROM settings WHERE key = 'sync.pull.cursor'`,
  );
  if (rows.length === 0) return null;
  try {
    const parsed = JSON.parse(rows[0].value_json);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
