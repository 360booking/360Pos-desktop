import { describe, expect, it } from 'vitest';
import { readCatalog } from '../catalogQueries';
import type { SqlExecutor } from '../executor';

/** Minimal in-memory SqlExecutor that responds to the four SELECTs
 * readCatalog issues — we don't need a real SQLite for this test. */
function makeFakeExec(seed: {
  categories?: Array<Record<string, unknown>>;
  products?: Array<Record<string, unknown>>;
  tables?: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
}): SqlExecutor {
  return {
    async select(sql) {
      if (/FROM categories/.test(sql)) return (seed.categories ?? []) as never;
      if (/FROM products/.test(sql)) return (seed.products ?? []) as never;
      if (/FROM tables/.test(sql)) return (seed.tables ?? []) as never;
      if (/FROM settings/.test(sql)) {
        return Object.entries(seed.settings ?? {}).map(([key, value]) => ({
          key,
          value_json: JSON.stringify(value),
        })) as never;
      }
      throw new Error('Unexpected SELECT: ' + sql);
    },
    async execute() { return { rowsAffected: 0 } as never; },
    async transaction(fn) { return fn(this); },
  };
}

describe('readCatalog', () => {
  it('returns rows from each table + parses settings json', async () => {
    const exec = makeFakeExec({
      categories: [{ id: 'c-1', name: 'Mains', sort_order: 0, station: 'kitchen' }],
      products: [
        { id: 'p-1', sku: 'SKU1', name: 'Pizza', price_cents: 4500, category_id: 'c-1', is_active: 1 },
      ],
      tables: [{ id: 't-1', table_number: '1', capacity: 4, qr_token: 'a', is_reservable: 1 }],
      settings: {
        'bootstrap.lastSuccessfulAt': '2026-04-26T10:00:00Z',
        'bootstrap.restaurantName': 'Test Bistro',
      },
    });
    const out = await readCatalog(exec);
    expect(out.categories).toHaveLength(1);
    expect(out.products[0].name).toBe('Pizza');
    expect(out.tables[0].table_number).toBe('1');
    expect(out.lastSuccessfulAt).toBe('2026-04-26T10:00:00Z');
    expect(out.restaurantName).toBe('Test Bistro');
  });

  it('returns nulls for missing settings keys', async () => {
    const exec = makeFakeExec({});
    const out = await readCatalog(exec);
    expect(out.lastSuccessfulAt).toBeNull();
    expect(out.restaurantName).toBeNull();
    expect(out.categories).toEqual([]);
  });
});
