/**
 * Read queries for the local catalogue tables — Sprint 4 / 2.
 *
 * These wrap the raw SQL the `MenuPane` / `TablesPane` need so the React
 * layer never authors SQL inline. Writes go through hydrateCatalog —
 * everything in here is read-only.
 */
import type { SqlExecutor } from './executor';

export interface CategoryRow {
  id: string;
  name: string;
  sort_order: number;
  station: string | null;
}

export interface ProductRow {
  id: string;
  sku: string | null;
  name: string;
  price_cents: number;
  category_id: string | null;
  is_active: number;
}

export interface TableRow {
  id: string;
  table_number: string;
  capacity: number | null;
  qr_token: string | null;
  is_reservable: number;
}

export interface CatalogSnapshot {
  categories: CategoryRow[];
  products: ProductRow[];
  tables: TableRow[];
  lastSuccessfulAt: string | null;
  restaurantName: string | null;
}

export async function readCatalog(exec: SqlExecutor): Promise<CatalogSnapshot> {
  const [categories, products, tables, settings] = await Promise.all([
    exec.select<CategoryRow>(
      `SELECT id, name, sort_order, station FROM categories ORDER BY sort_order ASC, name ASC`,
    ),
    exec.select<ProductRow>(
      `SELECT id, sku, name, price_cents, category_id, is_active
         FROM products
        WHERE is_active = 1
        ORDER BY name ASC`,
    ),
    exec.select<TableRow>(
      `SELECT id, table_number, capacity, qr_token, is_reservable
         FROM tables
        ORDER BY CAST(table_number AS INTEGER) ASC, table_number ASC`,
    ),
    exec.select<{ key: string; value_json: string }>(
      `SELECT key, value_json FROM settings
        WHERE key IN ('bootstrap.lastSuccessfulAt', 'bootstrap.restaurantName')`,
    ),
  ]);

  const map = new Map(settings.map((r) => [r.key, r.value_json]));
  const parse = (key: string): unknown => {
    const raw = map.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  return {
    categories,
    products,
    tables,
    lastSuccessfulAt: (parse('bootstrap.lastSuccessfulAt') as string) ?? null,
    restaurantName: (parse('bootstrap.restaurantName') as string) ?? null,
  };
}
