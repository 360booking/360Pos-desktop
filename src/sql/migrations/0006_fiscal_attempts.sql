-- =============================================================
-- 360booking POS desktop — migration 0006 (Sprint 11 — fiscal port)
--
-- Two append-only tables that record every fiscal + payment attempt
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
-- =============================================================

CREATE TABLE IF NOT EXISTS fiscal_attempts (
  id                  TEXT PRIMARY KEY,
  mutation_id         TEXT NOT NULL UNIQUE,
  order_local_id      TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  fiscal_device_id    TEXT,                            -- pairing per audit Q2 (1:1, nullable until paired)
  provider            TEXT NOT NULL,                   -- 'simulator' | 'datecs_dp25' | 'datecs_fp' | future
  printer_model       TEXT,                            -- e.g. 'Datecs DP-25 (FP-55)'
  serial_port         TEXT,                            -- COM3 / /dev/ttyUSB0 — null for simulator
  baud                INTEGER,
  protocol_variant    TEXT,                            -- 'fp55' | 'fp700' | NULL
  status              TEXT NOT NULL CHECK (status IN ('pending','printed','failed','unknown','confirmed_failed')),
  fiscal_number       TEXT,                            -- BF number from close_fiscal reply
  fiscal_date         TEXT,                            -- ISO-8601 UTC
  raw_request         TEXT,                            -- gated on FISCAL_ENABLE_RAW_LOGS
  raw_response        TEXT,                            -- gated on FISCAL_ENABLE_RAW_LOGS
  parsed_response     TEXT,                            -- structured dump of provider response
  error_code          TEXT,                            -- one of fiscal::error::FiscalError variants
  error_message       TEXT,
  status_bytes        TEXT,                            -- 6-byte Datecs STATUS hex (debugging)
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
  payment_terminal_id   TEXT,                          -- pairing per audit Q2 (1:1, nullable until paired)
  provider              TEXT NOT NULL,                 -- 'stub' | 'bt-ecr' | 'smartpay' | future
  amount_cents          INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'RON',
  status                TEXT NOT NULL CHECK (status IN ('pending','approved','declined','cancelled','unknown')),
  stan                  TEXT,                          -- system trace audit number
  rrn                   TEXT,                          -- retrieval reference number
  authorization_code    TEXT,
  terminal_id           TEXT,                          -- terminal serial / TID
  merchant_id           TEXT,
  card_scheme           TEXT,                          -- 'visa' | 'mastercard' | ...
  last4                 TEXT,
  response_code         TEXT,
  response_text         TEXT,
  raw_request           TEXT,                          -- gated on FISCAL_ENABLE_RAW_LOGS
  raw_response          TEXT,                          -- gated on FISCAL_ENABLE_RAW_LOGS
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_order    ON payment_attempts(order_local_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status   ON payment_attempts(status);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_device   ON payment_attempts(device_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_terminal ON payment_attempts(payment_terminal_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_created  ON payment_attempts(created_at);

-- Per-station device pairing. Audit Q2: 1:1:1 strict in Sprint 1 (one
-- station = one fiscal device + one payment terminal). Schema lets the
-- foreign key live elsewhere later, but the UI/flow stays single-pair.
CREATE TABLE IF NOT EXISTS station_pairings (
  device_id              TEXT PRIMARY KEY,             -- pos-desktop device_id
  fiscal_device_id       TEXT,                         -- bridge_id from fiscal_bridges (or local sim id)
  payment_terminal_id    TEXT,                         -- terminal serial / TID
  fiscal_provider        TEXT,                         -- mirrors fiscal_attempts.provider
  payment_provider       TEXT,                         -- mirrors payment_attempts.provider
  paired_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
