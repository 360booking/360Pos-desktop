-- =============================================================
-- 360booking POS desktop — migration 0005 (Sprint 8)
--
-- Local recovery queue for CARD_PAYMENT_UNKNOWN events. The backend
-- treats those as forensic-only (no payment row, order stays unpaid);
-- the desktop holds them in this table until the operator manually
-- resolves them (mark resolved, retry status check, or cancel).
--
-- Rows are append-only — updates only flip status / add notes.
-- =============================================================

CREATE TABLE IF NOT EXISTS card_recoveries (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL,
  terminal_trace      TEXT,
  terminal_auth_code  TEXT,
  terminal_rrn        TEXT,
  raised_at           TEXT NOT NULL DEFAULT (datetime('now')),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved_paid','resolved_void','cancelled')),
  resolved_at         TEXT,
  resolution_note     TEXT
);
CREATE INDEX IF NOT EXISTS idx_card_recoveries_status ON card_recoveries(status);
CREATE INDEX IF NOT EXISTS idx_card_recoveries_order ON card_recoveries(order_id);
