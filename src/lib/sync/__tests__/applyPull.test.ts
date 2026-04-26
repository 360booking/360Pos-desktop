import { describe, expect, it } from 'vitest';
import { applyPullChanges, readPullCursor } from '../applyPull';
import type { SqlExecutor } from '@/lib/db/executor';
import type { PullChangesResponse } from '@/lib/api/pull';

/** In-memory executor that pretends to be the SQLite the pull merges
 * into. We track INSERT / UPDATE / DELETE on the four tables this code
 * touches plus the settings UPSERT. */
function makeFake(): {
  exec: SqlExecutor;
  rows: { orders: Map<string, unknown>; items: Map<string, unknown>; tickets: Map<string, unknown>; settings: Map<string, unknown> };
} {
  const rows = {
    orders: new Map<string, Record<string, unknown>>(),
    items: new Map<string, Record<string, unknown>>(),
    tickets: new Map<string, Record<string, unknown>>(),
    settings: new Map<string, Record<string, unknown>>(),
  };

  const exec: SqlExecutor = {
    async select(sql) {
      if (/FROM settings WHERE key = 'sync.pull.cursor'/.test(sql)) {
        const row = rows.settings.get('sync.pull.cursor');
        return (row ? [row] : []) as never;
      }
      return [] as never;
    },
    async execute(sql, params = []) {
      const args = params as unknown[];
      const norm = sql.replace(/\s+/g, ' ').trim();
      // remote_orders DELETE / UPSERT
      if (/^DELETE FROM remote_orders WHERE id =/i.test(norm)) {
        rows.orders.delete(String(args[0]));
      } else if (/^INSERT INTO remote_orders/i.test(norm)) {
        const [id, table_id, status, payment_status, is_open, sub, disc, tip, total, currency, source, opened, closed, sent, updated] = args;
        rows.orders.set(String(id), {
          id, table_id, status, payment_status, is_open,
          subtotal_cents: sub, discount_cents: disc, tip_cents: tip, total_cents: total,
          currency, source, opened_at: opened, closed_at: closed, sent_to_kitchen_at: sent, updated_at: updated,
        });
      } else if (/^DELETE FROM remote_order_items WHERE order_id =/i.test(norm)) {
        const orderId = String(args[0]);
        for (const [id, row] of rows.items) {
          if ((row as { order_id: string }).order_id === orderId) rows.items.delete(id);
        }
      } else if (/^INSERT INTO remote_order_items/i.test(norm)) {
        const [id, order_id, menu_item_id, name, qty, unit, line, vat_bp, status, ticket_id, round_n, sent_at] = args;
        rows.items.set(String(id), {
          id, order_id, menu_item_id, name, quantity: qty,
          unit_price_cents: unit, line_total_cents: line, vat_rate_bp: vat_bp,
          status, kitchen_ticket_id: ticket_id, round_number: round_n, sent_at,
        });
      } else if (/^DELETE FROM remote_kitchen_tickets$/i.test(norm)) {
        rows.tickets.clear();
      } else if (/^INSERT INTO remote_kitchen_tickets/i.test(norm)) {
        const [id, order_id, station, status, created, seen, completed, prep] = args;
        rows.tickets.set(String(id), {
          id, order_id, station, status,
          created_at: created, seen_at: seen, completed_at: completed, preparation_seconds: prep,
        });
      } else if (/^INSERT INTO settings/i.test(norm)) {
        // applyPull hard-codes the key in SQL; only value_json is bound.
        const [value_json] = args;
        rows.settings.set('sync.pull.cursor', { key: 'sync.pull.cursor', value_json });
      } else {
        throw new Error('Unexpected SQL: ' + norm);
      }
      return { rowsAffected: 1 } as never;
    },
    async transaction(fn) { return fn(this); },
  };
  return { exec, rows };
}

const PULL: PullChangesResponse = {
  events: [],
  serverTime: '2026-04-26T08:00:00Z',
  nextCursor: '2026-04-26T08:00:00Z',
  changes: {
    orders: [
      {
        id: 'o-1', tableId: 't-1', status: 'sent', paymentStatus: 'unpaid',
        isOpen: true, subtotal: 50.0, discountTotal: 0.0, tipTotal: 0.0, total: 50.0,
        currency: 'RON', source: 'pos',
        openedAt: '2026-04-26T07:55:00Z', closedAt: null,
        sentToKitchenAt: '2026-04-26T07:58:00Z', updatedAt: '2026-04-26T07:59:00Z',
      },
    ],
    orderItems: [
      {
        id: 'i-1', orderId: 'o-1', menuItemId: 'mi-1', name: 'Pizza',
        quantity: 1, unitPriceCents: 5000, lineTotalCents: 5000,
        vatRateBp: 1900, status: 'pending', kitchenTicketId: 'kt-1',
        roundNumber: 1, sentAt: '2026-04-26T07:58:00Z',
      },
    ],
    kitchenTickets: [
      {
        id: 'kt-1', orderId: 'o-1', station: 'kitchen', status: 'pending',
        createdAt: '2026-04-26T07:58:00Z', seenAt: null, completedAt: null,
        preparationSeconds: null,
      },
    ],
  },
};

describe('applyPullChanges', () => {
  it('UPSERTs orders, items, and tickets + writes the cursor', async () => {
    const { exec, rows } = makeFake();
    const out = await applyPullChanges(exec, PULL);
    expect(out).toMatchObject({
      ordersUpserted: 1, ordersDropped: 0, itemsReplaced: 1, ticketsReplaced: 1,
      cursor: '2026-04-26T08:00:00Z',
    });
    expect(rows.orders.size).toBe(1);
    expect(rows.items.size).toBe(1);
    expect(rows.tickets.size).toBe(1);
    const cursor = await readPullCursor(exec);
    expect(cursor).toBe('2026-04-26T08:00:00Z');
  });

  it('drops an order whose isOpen flips to false', async () => {
    const { exec, rows } = makeFake();
    await applyPullChanges(exec, PULL);
    expect(rows.orders.size).toBe(1);
    const closingPull: PullChangesResponse = {
      ...PULL,
      nextCursor: '2026-04-26T08:05:00Z',
      changes: {
        ...PULL.changes,
        orders: [{ ...PULL.changes.orders[0], isOpen: false, closedAt: '2026-04-26T08:04:00Z' }],
        orderItems: [],
        kitchenTickets: [],
      },
    };
    const out = await applyPullChanges(exec, closingPull);
    expect(out.ordersDropped).toBe(1);
    expect(rows.orders.size).toBe(0);
  });

  it('full-replaces tickets on every pull (active set)', async () => {
    const { exec, rows } = makeFake();
    await applyPullChanges(exec, PULL);
    const newer: PullChangesResponse = {
      ...PULL,
      nextCursor: '2026-04-26T08:10:00Z',
      changes: {
        ...PULL.changes,
        kitchenTickets: [
          {
            id: 'kt-2', orderId: 'o-1', station: 'bar', status: 'preparing',
            createdAt: '2026-04-26T08:09:00Z', seenAt: '2026-04-26T08:09:30Z',
            completedAt: null, preparationSeconds: null,
          },
        ],
      },
    };
    await applyPullChanges(exec, newer);
    // kt-1 disappears, kt-2 lands.
    expect(rows.tickets.has('kt-1')).toBe(false);
    expect(rows.tickets.has('kt-2')).toBe(true);
  });
});
