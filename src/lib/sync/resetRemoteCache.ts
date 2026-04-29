/**
 * Drop the local /sync/pull read-model so the next pull re-hydrates
 * from scratch. Sprint 11.10.
 *
 * Why this exists:
 *   /api/pos/sync/pull is incremental — it ships rows whose
 *   `updated_at` moved past the persisted cursor. If a row went from
 *   open → closed in a window where the desktop was offline / the app
 *   was closed (and `updated_at` then never moves again), the cached
 *   row stays `is_open=1` forever and TablesPane keeps drawing the
 *   table as occupied — even though the web admin (which reads the
 *   server live) shows it free.
 *
 * Goal: at every login the operator should see exactly what the
 * server says — no stale "open" tabs from a previous shift.
 *
 * Scope:
 *   - DELETE FROM remote_orders          (orders by table read-model)
 *   - DELETE FROM remote_order_items     (FK CASCADE, but we delete
 *                                         explicitly because pragma
 *                                         foreign_keys may be off on
 *                                         the local connection)
 *   - DELETE FROM remote_kitchen_tickets (active KDS tickets)
 *   - DELETE FROM settings WHERE key = 'sync.pull.cursor'
 *
 * What we do NOT touch:
 *   - `events` / `sync_outbox` — local mutations the operator made
 *     while offline. Wiping these would lose unsynced work.
 *   - `orders` / `order_items` — the local-write side (pos-core
 *     event-sourced state). The remote read-model is independent.
 *   - Catalog tables (`menu_items`, `categories`, `tables`) — those
 *     are managed by hydrateCatalog and don't carry stale per-shift
 *     state.
 */
import type { SqlExecutor } from '@/lib/db/executor';
import { dbg, dbgError } from '@/lib/debugLog';

export interface ResetRemoteCacheResult {
  ok: boolean;
  ordersDeleted: number;
  itemsDeleted: number;
  ticketsDeleted: number;
  cursorCleared: boolean;
  error?: string;
}

export async function resetRemoteCache(
  exec: SqlExecutor,
): Promise<ResetRemoteCacheResult> {
  try {
    return await exec.transaction(async (tx) => {
      const items = await tx.execute(`DELETE FROM remote_order_items`);
      const orders = await tx.execute(`DELETE FROM remote_orders`);
      const tickets = await tx.execute(`DELETE FROM remote_kitchen_tickets`);
      const cursor = await tx.execute(
        `DELETE FROM settings WHERE key = 'sync.pull.cursor'`,
      );
      const result: ResetRemoteCacheResult = {
        ok: true,
        ordersDeleted: orders.rowsAffected ?? 0,
        itemsDeleted: items.rowsAffected ?? 0,
        ticketsDeleted: tickets.rowsAffected ?? 0,
        cursorCleared: (cursor.rowsAffected ?? 0) > 0,
      };
      dbg('pull', 'resetRemoteCache ◀', result);
      return result;
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    dbgError('pull', 'resetRemoteCache ✖', { message });
    return {
      ok: false,
      ordersDeleted: 0,
      itemsDeleted: 0,
      ticketsDeleted: 0,
      cursorCleared: false,
      error: message,
    };
  }
}
