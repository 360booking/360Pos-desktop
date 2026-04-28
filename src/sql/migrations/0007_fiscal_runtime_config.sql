-- =============================================================
-- 360booking POS desktop — migration 0007 (fiscal runtime config)
--
-- Single-row table that holds the per-station fiscal hardware config.
-- Replaces FISCAL_* env vars as the source of truth so the operator
-- can configure the cash register from Settings → Casa de marcat
-- without touching Windows environment variables.
--
-- Lookup order at runtime (Rust runtime_config::effective_*):
--   1. value in this table when present and non-NULL
--   2. matching FISCAL_* env var (back-compat for dev / scripted launches)
--   3. provider/dialect default
--
-- Single row enforced by id = 1; UPSERT is the only write path.
-- Sensitive note: operator_password is stored plaintext in this local
-- SQLite for the Sprint 1 of this UI. OS keychain / stronghold
-- integration is the same Sprint 11+ ticket as the auth refresh-token
-- row.
--
-- 2026-04-28: rewritten without inline column comments. The previous
-- shape used `-- ...` comments after every column, which the
-- tauri-plugin-sql migration runner split incorrectly on Windows.
-- =============================================================

CREATE TABLE IF NOT EXISTS fiscal_runtime_config (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  provider           TEXT,
  serial_port        TEXT,
  baud               INTEGER,
  protocol_variant   TEXT,
  operator           TEXT,
  operator_password  TEXT,
  printer_model      TEXT,
  use_rust           INTEGER,
  enable_raw_logs    INTEGER,
  vat_map_json       TEXT,
  cmd_codes_json     TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
