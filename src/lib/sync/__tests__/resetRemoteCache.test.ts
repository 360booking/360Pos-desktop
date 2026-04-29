import { describe, expect, it } from 'vitest';
import { resetRemoteCache } from '../resetRemoteCache';
import type { SqlExecutor } from '@/lib/db/executor';

function makeFake(seed: { orders: number; items: number; tickets: number; cursor: boolean }): {
  exec: SqlExecutor;
  state: { orders: number; items: number; tickets: number; cursor: boolean };
  log: string[];
} {
  const state = { ...seed };
  const log: string[] = [];
  const exec: SqlExecutor = {
    async select() {
      return [] as never;
    },
    async execute(sql) {
      const norm = sql.replace(/\s+/g, ' ').trim();
      log.push(norm);
      if (/^DELETE FROM remote_order_items$/i.test(norm)) {
        const n = state.items;
        state.items = 0;
        return { rowsAffected: n } as never;
      }
      if (/^DELETE FROM remote_orders$/i.test(norm)) {
        const n = state.orders;
        state.orders = 0;
        return { rowsAffected: n } as never;
      }
      if (/^DELETE FROM remote_kitchen_tickets$/i.test(norm)) {
        const n = state.tickets;
        state.tickets = 0;
        return { rowsAffected: n } as never;
      }
      if (/^DELETE FROM settings WHERE key = 'sync\.pull\.cursor'$/i.test(norm)) {
        const had = state.cursor;
        state.cursor = false;
        return { rowsAffected: had ? 1 : 0 } as never;
      }
      throw new Error('Unexpected SQL: ' + norm);
    },
    async transaction(fn) {
      return fn(this);
    },
  };
  return { exec, state, log };
}

describe('resetRemoteCache', () => {
  it('clears remote read-model + cursor and reports counts', async () => {
    const { exec, state } = makeFake({ orders: 9, items: 27, tickets: 3, cursor: true });
    const result = await resetRemoteCache(exec);
    expect(result).toEqual({
      ok: true,
      ordersDeleted: 9,
      itemsDeleted: 27,
      ticketsDeleted: 3,
      cursorCleared: true,
    });
    expect(state).toEqual({ orders: 0, items: 0, tickets: 0, cursor: false });
  });

  it('deletes items BEFORE orders so no FK violation regardless of pragma', async () => {
    const { exec, log } = makeFake({ orders: 1, items: 1, tickets: 0, cursor: false });
    await resetRemoteCache(exec);
    const itemsIdx = log.findIndex((s) => /DELETE FROM remote_order_items/i.test(s));
    const ordersIdx = log.findIndex((s) => /DELETE FROM remote_orders$/i.test(s));
    expect(itemsIdx).toBeGreaterThanOrEqual(0);
    expect(ordersIdx).toBeGreaterThanOrEqual(0);
    expect(itemsIdx).toBeLessThan(ordersIdx);
  });

  it('reports ok: false on transaction failure without throwing', async () => {
    const exec: SqlExecutor = {
      async select() { return [] as never; },
      async execute() { throw new Error('disk I/O error'); },
      async transaction(fn) { return fn(this); },
    };
    const result = await resetRemoteCache(exec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disk I/O error');
  });

  it('cursorCleared=false when no cursor row existed', async () => {
    const { exec } = makeFake({ orders: 0, items: 0, tickets: 0, cursor: false });
    const result = await resetRemoteCache(exec);
    expect(result.ok).toBe(true);
    expect(result.cursorCleared).toBe(false);
  });
});
