-- =============================================================
-- 360booking POS desktop — migration 0006 (Sprint 11 — fiscal port)
--
-- Three append-only tables that record every fiscal + payment attempt
-- locally, separately. Audit §5.5 (pos-desktop/docs/fiscal-port-audit.md)
-- spells out the user-mandated rule:
--
--   * fiscal_attempts and payment_attempts NEVER live in the same row.
--   * If a card payment is approved but fiscalization fails, the order
--     stays approved + retry-able; we keep STAN/RRN/auth_code so the
--     operator can re-fiscalize without re-charging.
--   * `unknown` is never treated as success — the row stays in that
--     state until manager flow resolves it.
--
-- Raw request/response columns are NULL by default; populated only when
-- FISCAL_ENABLE_RAW_LOGS=true (env, read at provider time). Keeps the
-- DB small in production while leaving the column there for diagnostics
-- without another migration later.
--
-- The columns mirror what the Rust DTO already serializes
-- (src-tauri/src/fiscal/dto.rs) plus the metadata the existing pos-core
-- FiscalAttempt structure needs (orderLocalId, mutationId, deviceId).
--
-- Schema is intentionally protocol-agnostic — same shape works for
-- simulator / Datecs DP-25 / future Tremol / Eltrade. Only `provider`
-- + `printer_model` change.
--
-- 2026-04-28: REWRITTEN to drop all inline column comments. The previous
-- shape used `-- ...` comments with parens/commas after every column,
-- which the tauri-plugin-sql migration runner (sqlx) split incorrectly,
-- producing partial CREATE TABLE statements on Windows where the column
-- `fiscal_device_id` ended up missing. CREATE INDEX on that column then
-- failed with "no such column". Schema is unchanged from before.
-- =============================================================

CREATE TABLE IF NOT EXISTS fiscal_attempts (
  id                  TEXT PRIMARY KEY,
  mutation_id         TEXT NOT NULL UNIQUE,
  order_local_id      TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  fiscal_device_id    TEXT,
  provider            TEXT NOT NULL,
  printer_model       TEXT,
  serial_port         TEXT,
  baud                INTEGER,
  protocol_variant    TEXT,
  status              TEXT NOT NULL CHECK (status IN ('pending','printed','failed','unknown','confirmed_failed')),
  fiscal_number       TEXT,
  fiscal_date         TEXT,
  raw_request         TEXT,
  raw_response        TEXT,
  parsed_response     TEXT,
  error_code          TEXT,
  error_message       TEXT,
  status_bytes        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_order      ON fiscal_attempts(order_local_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_status     ON fiscal_attempts(status);
CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_device     ON fiscal_attempts(device_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_fiscal_dev ON fiscal_attempts(fiscal_device_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_created    ON fiscal_attempts(created_at);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id                    TEXT PRIMARY KEY,
  mutation_id           TEXT NOT NULL UNIQUE,
  order_local_id        TEXT NOT NULL,
  device_id             TEXT NOT NULL,
  payment_terminal_id   TEXT,
  provider              TEXT NOT NULL,
  amount_cents          INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'RON',
  status                TEXT NOT NULL CHECK (status IN ('pending','approved','declined','cancelled','unknown')),
  stan                  TEXT,
  rrn                   TEXT,
  authorization_code    TEXT,
  terminal_id           TEXT,
  merchant_id           TEXT,
  card_scheme           TEXT,
  last4                 TEXT,
  response_code         TEXT,
  response_text         TEXT,
  raw_request           TEXT,
  raw_response          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_order    ON payment_attempts(order_local_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status   ON payment_attempts(status);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_device   ON payment_attempts(device_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_terminal ON payment_attempts(payment_terminal_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_created  ON payment_attempts(created_at);

CREATE TABLE IF NOT EXISTS station_pairings (
  device_id              TEXT PRIMARY KEY,
  fiscal_device_id       TEXT,
  payment_terminal_id    TEXT,
  fiscal_provider        TEXT,
  payment_provider       TEXT,
  paired_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
