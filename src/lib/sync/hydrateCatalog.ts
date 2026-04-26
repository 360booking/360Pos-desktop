/**
 * Hydrate the local SQLite catalogue from a /api/pos/bootstrap response.
 *
 * Sprint 4 / 1 — first launch, manual refresh and the 30-minute background
 * tick all funnel through this function. UPSERT semantics keep the
 * operation idempotent so we can replay the same payload safely.
 *
 * Non-disruption rules (see docs/offline-sync-strategy.md § Sprint 4):
 *  - We never delete products. Items missing from the new payload become
 *    `is_active=0` so any open order that already references them keeps
 *    showing the line, but the add-to-cart pane filters them out.
 *  - Categories and tables get the same soft-deactivation treatment
 *    (categories without products effectively disappear from the menu
 *    pane; tables do not have an active flag in Sprint 4 so missing
 *    rows are dropped — a tenant rarely removes a table).
 *  - Order line items are stored on `orders` / `order_items` (created
 *    locally) and are NOT touched by this function — their price/VAT
 *    snapshot is preserved by construction.
 */
import type { SqlExecutor } from '@/lib/db/executor';
import type { BootstrapResponse } from '@/lib/api/bootstrap';

export interface HydrateSummary {
  categories: number;
  products: number;
  tables: number;
  productsDeactivated: number;
  hydratedAt: string;
}

export async function hydrateCatalog(
  exec: SqlExecutor,
  bootstrap: BootstrapResponse,
): Promise<HydrateSummary> {
  const hydratedAt = bootstrap.serverTime || new Date().toISOString();
  return exec.transaction(async (tx) => {
    // ─── categories ────────────────────────────────────────────────────────
    for (const c of bootstrap.categories) {
      await tx.execute(
        `INSERT INTO categories (id, name, sort_order, station, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           sort_order = excluded.sort_order,
           station = excluded.station,
           updated_at = excluded.updated_at`,
        [c.id, c.name, c.sortOrder ?? 0, c.type ?? null, hydratedAt],
      );
    }

    // ─── products ──────────────────────────────────────────────────────────
    const incomingIds = new Set(bootstrap.products.map((p) => p.id));
    for (const p of bootstrap.products) {
      await tx.execute(
        `INSERT INTO products (id, sku, name, price_cents, vat_group, category_id, is_active, metadata_json, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           sku = excluded.sku,
           name = excluded.name,
           price_cents = excluded.price_cents,
           category_id = excluded.category_id,
           is_active = excluded.is_active,
           updated_at = excluded.updated_at`,
        [
          p.id,
          p.sku,
          p.name,
          p.priceCents,
          p.categoryId,
          p.isActive ? 1 : 0,
          hydratedAt,
        ],
      );
    }
    // Soft-deactivate any product NOT in the new payload. We do not
    // delete because an open order may still reference it.
    let productsDeactivated = 0;
    if (incomingIds.size > 0) {
      const placeholders = bootstrap.products.map(() => '?').join(',');
      const existing = await tx.select<{ id: string }>(
        `SELECT id FROM products WHERE is_active = 1 AND id NOT IN (${placeholders})`,
        bootstrap.products.map((p) => p.id),
      );
      for (const row of existing) {
        await tx.execute(
          `UPDATE products SET is_active = 0, updated_at = ? WHERE id = ?`,
          [hydratedAt, row.id],
        );
        productsDeactivated += 1;
      }
    }

    // ─── tables ────────────────────────────────────────────────────────────
    for (const t of bootstrap.tables) {
      await tx.execute(
        `INSERT INTO tables (id, table_number, capacity, qr_token, is_reservable, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           table_number = excluded.table_number,
           capacity = excluded.capacity,
           qr_token = excluded.qr_token,
           is_reservable = excluded.is_reservable,
           updated_at = excluded.updated_at`,
        [
          t.id,
          t.tableNumber,
          t.capacity,
          t.qrToken,
          t.isReservable ? 1 : 0,
          hydratedAt,
        ],
      );
    }

    // ─── settings: snapshot bootstrap metadata ─────────────────────────────
    const settings: Array<[string, unknown]> = [
      ['bootstrap.lastSuccessfulAt', hydratedAt],
      ['bootstrap.tenantId', bootstrap.tenant?.id ?? null],
      ['bootstrap.restaurantId', bootstrap.restaurant?.id ?? null],
      ['bootstrap.restaurantName', bootstrap.restaurant?.name ?? null],
      ['bootstrap.vatConfig', bootstrap.vatConfig],
      ['bootstrap.syncCursor', bootstrap.syncCursor],
    ];
    for (const [key, value] of settings) {
      await tx.execute(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
        [key, JSON.stringify(value ?? null), hydratedAt],
      );
    }

    return {
      categories: bootstrap.categories.length,
      products: bootstrap.products.length,
      tables: bootstrap.tables.length,
      productsDeactivated,
      hydratedAt,
    };
  });
}
