-- =============================================================
-- 360booking POS desktop — migration 0003 (Sprint 6)
--
-- Read-model cache for /api/pos/sync/pull. We KEEP these tables
-- distinct from `orders` / `order_items` (the local-write side)
-- because:
--
--   - `orders` is fed by pos-core events on this device.
--   - `remote_orders` is a snapshot of what every device + the
--     web POS has currently open, used by TablesPane to draw
--     status pills.
--
-- Mixing them would require a "owner is me?" flag on every row;
-- splitting keeps the local-write code untouched and the remote
-- merge a pure UPSERT.
-- =============================================================

CREATE TABLE IF NOT EXISTS remote_orders (
  id                  TEXT PRIMARY KEY,
  table_id            TEXT,
  status              TEXT NOT NULL,
  payment_status      TEXT NOT NULL,
  is_open             INTEGER NOT NULL DEFAULT 1,
  subtotal_cents      INTEGER NOT NULL DEFAULT 0,
  discount_cents      INTEGER NOT NULL DEFAULT 0,
  tip_cents           INTEGER NOT NULL DEFAULT 0,
  total_cents         INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'RON',
  source              TEXT,
  opened_at           TEXT,
  closed_at           TEXT,
  sent_to_kitchen_at  TEXT,
  updated_at          TEXT NOT NULL,
  fetched_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_remote_orders_table ON remote_orders(table_id);
CREATE INDEX IF NOT EXISTS idx_remote_orders_open ON remote_orders(is_open);

CREATE TABLE IF NOT EXISTS remote_order_items (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES remote_orders(id) ON DELETE CASCADE,
  menu_item_id        TEXT,
  name                TEXT NOT NULL,
  quantity            INTEGER NOT NULL DEFAULT 1,
  unit_price_cents    INTEGER NOT NULL DEFAULT 0,
  line_total_cents    INTEGER NOT NULL DEFAULT 0,
  vat_rate_bp         INTEGER,
  status              TEXT NOT NULL DEFAULT 'pending',
  kitchen_ticket_id   TEXT,
  round_number        INTEGER NOT NULL DEFAULT 1,
  sent_at             TEXT,
  fetched_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_remote_items_order ON remote_order_items(order_id);

CREATE TABLE IF NOT EXISTS remote_kitchen_tickets (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL,
  station             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  created_at          TEXT,
  seen_at             TEXT,
  completed_at        TEXT,
  preparation_seconds INTEGER,
  fetched_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_remote_tickets_station ON remote_kitchen_tickets(station);
CREATE INDEX IF NOT EXISTS idx_remote_tickets_order ON remote_kitchen_tickets(order_id);
