-- =============================================================
-- 360booking POS desktop — migration 0001 (Sprint 0)
-- Local store. WAL is enabled at runtime by lib/db.ts.
-- All time fields are ISO-8601 UTC strings unless suffixed _ms.
-- =============================================================

-- ─── Local-only configuration & operational logs ────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key            TEXT PRIMARY KEY,
  value_json     TEXT NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS device_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  level          TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  source         TEXT NOT NULL,
  message        TEXT NOT NULL,
  context_json   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  shipped_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_logs_shipped ON device_logs(shipped_at);
CREATE INDEX IF NOT EXISTS idx_device_logs_created ON device_logs(created_at);

-- ─── Event store + outbox (sync engine) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id          TEXT NOT NULL UNIQUE,
  type                 TEXT NOT NULL,
  payload_json         TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','processing','synced','failed','dead')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at            TEXT,
  server_response_json TEXT,
  last_error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_status_created ON events(status, created_at);

CREATE TABLE IF NOT EXISTS sync_outbox (
  event_id        INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_retry_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_next_retry ON sync_outbox(next_retry_at);

CREATE TABLE IF NOT EXISTS sync_cursor (
  resource        TEXT PRIMARY KEY,
  since_id        INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Master data (hydrated at bootstrap, refreshed via pull) ─────────────────
CREATE TABLE IF NOT EXISTS categories (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  station         TEXT,                 -- 'kitchen' | 'bar' | 'pizza' | custom
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,
  sku             TEXT,
  name            TEXT NOT NULL,
  price_cents     INTEGER NOT NULL,
  vat_group       TEXT,                 -- 'A' | 'B' | 'C' (Romanian fiscal letters)
  category_id     TEXT REFERENCES categories(id),
  is_active       INTEGER NOT NULL DEFAULT 1,
  metadata_json   TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

CREATE TABLE IF NOT EXISTS tables (
  id              TEXT PRIMARY KEY,
  table_number    TEXT NOT NULL,
  capacity        INTEGER,
  qr_token        TEXT,
  is_reservable   INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Transactional (created locally, replicated to backend) ─────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                       TEXT PRIMARY KEY,            -- local UUID
  server_id                TEXT,                         -- backend id once synced
  mutation_id              TEXT NOT NULL UNIQUE,         -- creation mutation
  table_id                 TEXT REFERENCES tables(id),
  status                   TEXT NOT NULL DEFAULT 'draft',
  source                   TEXT,                         -- 'pos','online','qr','home_delivery',...
  opened_at                TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at                TEXT,
  subtotal_cents           INTEGER NOT NULL DEFAULT 0,
  tax_cents                INTEGER NOT NULL DEFAULT 0,
  discount_cents           INTEGER NOT NULL DEFAULT 0,
  tip_cents                INTEGER NOT NULL DEFAULT 0,
  total_cents              INTEGER NOT NULL DEFAULT 0,
  payment_status           TEXT NOT NULL DEFAULT 'unpaid',
  owner_device_id          TEXT,                         -- which device created the order
  fiscal_receipt_number    TEXT,
  fiscal_issued_at         TEXT,
  version                  INTEGER NOT NULL DEFAULT 0,
  synced_at                TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_synced ON orders(synced_at);
CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_id);

CREATE TABLE IF NOT EXISTS order_items (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  mutation_id         TEXT NOT NULL UNIQUE,
  product_id          TEXT REFERENCES products(id),
  product_name        TEXT NOT NULL,
  quantity            INTEGER NOT NULL,
  unit_price_cents    INTEGER NOT NULL,
  line_total_cents    INTEGER NOT NULL,
  modifiers_json      TEXT,
  kitchen_ticket_id   TEXT,
  sent_at             TEXT,
  voided_at           TEXT,
  void_reason         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  mutation_id         TEXT NOT NULL UNIQUE,
  method              TEXT NOT NULL,                    -- 'cash','card','voucher','online','glovo',...
  amount_cents        INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'recorded' -- 'recorded','approved','declined','unknown'
                        CHECK (status IN ('recorded','approved','declined','cancelled','unknown')),
  terminal_auth_code  TEXT,
  terminal_rrn        TEXT,
  terminal_trace      TEXT,
  raw_response        TEXT,
  error_code          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS fiscal_attempts (
  id                   TEXT PRIMARY KEY,
  mutation_id          TEXT NOT NULL UNIQUE,
  order_id             TEXT NOT NULL REFERENCES orders(id),
  device_id            TEXT NOT NULL,
  adapter_id           TEXT NOT NULL,
  request_payload_json TEXT NOT NULL,
  response_json        TEXT,
  raw_trace            TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','printed','failed','unknown','confirmed_failed')),
  fiscal_number        TEXT,
  error_code           TEXT,
  error_message        TEXT,
  started_at           TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_order ON fiscal_attempts(order_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_status ON fiscal_attempts(status);

CREATE TABLE IF NOT EXISTS fiscal_receipts (
  id                   TEXT PRIMARY KEY,
  mutation_id          TEXT NOT NULL UNIQUE,
  fiscal_attempt_id    TEXT NOT NULL REFERENCES fiscal_attempts(id),
  order_id             TEXT NOT NULL REFERENCES orders(id),
  fiscal_number        TEXT NOT NULL,
  fiscal_date          TEXT NOT NULL,
  device_id            TEXT NOT NULL,
  recovery_source      TEXT NOT NULL DEFAULT 'device' -- 'device' | 'manual'
                         CHECK (recovery_source IN ('device','manual')),
  raw_trace            TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_receipts_number ON fiscal_receipts(fiscal_number);

CREATE TABLE IF NOT EXISTS kitchen_tickets (
  id              TEXT PRIMARY KEY,
  mutation_id     TEXT NOT NULL UNIQUE,
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  station         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','seen','in_prep','ready','completed','cancelled','modified')),
  parent_ticket_id TEXT REFERENCES kitchen_tickets(id),  -- set on MODIFICARE
  printed_at      TEXT,
  seen_at         TEXT,
  in_prep_at      TEXT,
  ready_at        TEXT,
  completed_at    TEXT,
  preparation_seconds INTEGER,
  payload_json    TEXT,
  synced_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_kitchen_tickets_order ON kitchen_tickets(order_id);
CREATE INDEX IF NOT EXISTS idx_kitchen_tickets_status ON kitchen_tickets(status);

CREATE TABLE IF NOT EXISTS print_jobs (
  id              TEXT PRIMARY KEY,
  mutation_id     TEXT NOT NULL UNIQUE,
  station         TEXT NOT NULL,
  template        TEXT NOT NULL,
  data_json       TEXT NOT NULL,
  copies          INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','printed','failed','unknown','reprint')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  raw_trace       TEXT,
  error_code      TEXT,
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_station ON print_jobs(station);

-- Default cursors so the sync engine has rows to update without a NULL check.
INSERT OR IGNORE INTO sync_cursor(resource, since_id) VALUES
  ('orders', 0),
  ('order_items', 0),
  ('payments', 0),
  ('kitchen_tickets', 0),
  ('products', 0),
  ('categories', 0),
  ('tables', 0);
