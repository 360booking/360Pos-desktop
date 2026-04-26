import { describe, expect, it } from 'vitest';
import { hydrateCatalog } from '../hydrateCatalog';
import type { SqlExecutor } from '@/lib/db/executor';
import type { BootstrapResponse } from '@/lib/api/bootstrap';

/** Minimal in-memory SqlExecutor — only the SQL hydrateCatalog actually
 * sends. Stores rows by table + id so we can assert UPSERT semantics. */
function makeFake(): { exec: SqlExecutor; tables: Record<string, Map<string, Record<string, unknown>>>; calls: string[] } {
  const tables: Record<string, Map<string, Record<string, unknown>>> = {
    categories: new Map(),
    products: new Map(),
    tables: new Map(),
    settings: new Map(),
  };
  const calls: string[] = [];

  const upsert = (table: string, id: string, row: Record<string, unknown>) => {
    const cur = tables[table].get(id) ?? {};
    tables[table].set(id, { ...cur, ...row });
  };

  const exec: SqlExecutor = {
    async select(sql, params = []) {
      calls.push(`SELECT ${sql}`);
      // Only one SELECT shape is sent — soft-deactivation lookup.
      if (/SELECT id FROM products WHERE is_active = 1 AND id NOT IN/.test(sql)) {
        const incoming = new Set(params as string[]);
        return Array.from(tables.products.values())
          .filter((r) => r.is_active === 1 && !incoming.has(String(r.id)))
          .map((r) => ({ id: String(r.id) })) as never;
      }
      return [] as never;
    },
    async execute(sql, params = []) {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      const args = params as unknown[];

      if (/^INSERT INTO categories/.test(sql)) {
        const [id, name, sort_order, station, updated_at] = args;
        upsert('categories', String(id), { id, name, sort_order, station, updated_at });
      } else if (/^INSERT INTO products/.test(sql)) {
        const [id, sku, name, price_cents, category_id, is_active, , updated_at] = args;
        upsert('products', String(id), {
          id, sku, name, price_cents, category_id, is_active, updated_at,
        });
      } else if (/^UPDATE products SET is_active = 0/.test(sql)) {
        const [updated_at, id] = args;
        upsert('products', String(id), { is_active: 0, updated_at });
      } else if (/^INSERT INTO tables/.test(sql)) {
        const [id, table_number, capacity, qr_token, is_reservable, updated_at] = args;
        upsert('tables', String(id), {
          id, table_number, capacity, qr_token, is_reservable, updated_at,
        });
      } else if (/^INSERT INTO settings/.test(sql)) {
        const [key, value_json, updated_at] = args;
        upsert('settings', String(key), { key, value_json, updated_at });
      } else {
        throw new Error('Unexpected SQL: ' + sql);
      }
      return { rowsAffected: 1, lastInsertId: undefined };
    },
    async transaction(fn) {
      // No nesting in tests — just run the closure.
      return fn(exec);
    },
  };
  return { exec, tables, calls };
}

const baseBootstrap: BootstrapResponse = {
  serverTime: '2026-04-26T10:00:00Z',
  tenant: { id: 't-1' },
  restaurant: { id: 'r-1', name: 'Test' },
  vatConfig: { defaultRate: 0.19, foodRate: null, barRate: null },
  categories: [
    { id: 'c-1', name: 'Mains', type: 'kitchen', sortOrder: 0 },
    { id: 'c-2', name: 'Drinks', type: 'bar', sortOrder: 1 },
  ],
  products: [
    { id: 'p-1', sku: 'SKU1', name: 'Pizza', priceCents: 4500, categoryId: 'c-1', isActive: true },
    { id: 'p-2', sku: null, name: 'Cola', priceCents: 800, categoryId: 'c-2', isActive: true },
  ],
  tables: [
    { id: 't-1', tableNumber: '1', capacity: 4, qrToken: 'abc', isReservable: true },
  ],
  users: [],
  settings: {},
  syncCursor: { orders: 0 },
};

describe('hydrateCatalog', () => {
  it('inserts categories, products, tables and settings on a fresh DB', async () => {
    const { exec, tables } = makeFake();
    const out = await hydrateCatalog(exec, baseBootstrap);
    expect(out).toMatchObject({
      categories: 2, products: 2, tables: 1, productsDeactivated: 0,
      hydratedAt: '2026-04-26T10:00:00Z',
    });
    expect(tables.categories.size).toBe(2);
    expect(tables.products.size).toBe(2);
    expect(tables.tables.size).toBe(1);
    expect(tables.products.get('p-1')!.is_active).toBe(1);
    // Bootstrap metadata snapshotted as settings rows.
    expect(JSON.parse(String(tables.settings.get('bootstrap.lastSuccessfulAt')!.value_json))).toBe('2026-04-26T10:00:00Z');
    expect(JSON.parse(String(tables.settings.get('bootstrap.vatConfig')!.value_json)))
      .toEqual({ defaultRate: 0.19, foodRate: null, barRate: null });
  });

  it('UPSERT keeps the same row id on a second hydrate with updated price', async () => {
    const { exec, tables } = makeFake();
    await hydrateCatalog(exec, baseBootstrap);
    const updated: BootstrapResponse = {
      ...baseBootstrap,
      serverTime: '2026-04-26T10:30:00Z',
      products: [
        { id: 'p-1', sku: 'SKU1', name: 'Pizza Margherita', priceCents: 5000, categoryId: 'c-1', isActive: true },
        { id: 'p-2', sku: null, name: 'Cola', priceCents: 800, categoryId: 'c-2', isActive: true },
      ],
    };
    await hydrateCatalog(exec, updated);
    expect(tables.products.size).toBe(2); // no new rows
    expect(tables.products.get('p-1')!.name).toBe('Pizza Margherita');
    expect(tables.products.get('p-1')!.price_cents).toBe(5000);
  });

  it('soft-deactivates products that disappear from the next bootstrap', async () => {
    const { exec, tables } = makeFake();
    await hydrateCatalog(exec, baseBootstrap);
    const trimmed: BootstrapResponse = {
      ...baseBootstrap,
      serverTime: '2026-04-26T11:00:00Z',
      products: [
        { id: 'p-1', sku: 'SKU1', name: 'Pizza', priceCents: 4500, categoryId: 'c-1', isActive: true },
      ],
    };
    const out = await hydrateCatalog(exec, trimmed);
    expect(out.productsDeactivated).toBe(1);
    expect(tables.products.get('p-1')!.is_active).toBe(1);
    expect(tables.products.get('p-2')!.is_active).toBe(0); // not deleted, just inactive
  });

  it('marks an explicitly inactive product as is_active=0 without deleting', async () => {
    const { exec, tables } = makeFake();
    const inactive: BootstrapResponse = {
      ...baseBootstrap,
      products: [
        { id: 'p-1', sku: 'SKU1', name: 'Pizza', priceCents: 4500, categoryId: 'c-1', isActive: false },
      ],
    };
    await hydrateCatalog(exec, inactive);
    expect(tables.products.get('p-1')!.is_active).toBe(0);
  });
});
