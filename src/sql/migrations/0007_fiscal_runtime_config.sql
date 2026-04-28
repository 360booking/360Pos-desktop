-- =============================================================
-- 360booking POS desktop — migration 0007 (fiscal runtime config)
--
-- Single-row table that holds the per-station fiscal hardware config.
-- Replaces FISCAL_* env vars as the source of truth so the operator
-- can configure the cash register from Settings → Casă de marcat
-- without touching Windows environment variables.
--
-- Lookup order at runtime (Rust `fiscal::runtime_config::effective_*`):
--   1. value in this table when present and non-NULL
--   2. matching FISCAL_* env var (back-compat for dev / scripted launches)
--   3. provider/dialect default
--
-- Single row enforced by `id = 1`; UPSERT is the only write path.
-- Sensitive note: `operator_password` is stored plaintext in this local
-- SQLite for Sprint 1 of this UI. OS keychain / stronghold integration
-- is the same Sprint 11+ ticket as the auth refresh-token row.
-- =============================================================

CREATE TABLE IF NOT EXISTS fiscal_runtime_config (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  provider           TEXT,                 -- 'simulator' | 'datecs_dp25' | 'datecs_fp'
  serial_port        TEXT,                 -- COM3 / /dev/ttyUSB0
  baud               INTEGER,              -- 9600 / 19200 / 115200
  protocol_variant   TEXT,                 -- 'fp55' | 'fp700'
  operator           TEXT,                 -- usually '1'
  operator_password  TEXT,                 -- plaintext for now (see header)
  printer_model      TEXT,                 -- free-form label, e.g. 'Datecs DP-25'
  use_rust           INTEGER,              -- 0/1; promotes RustFiscalAdapter
  enable_raw_logs    INTEGER,              -- 0/1; gate for fiscal_attempts.raw_*
  vat_map_json       TEXT,                 -- override for decimal-rate → A/B/C/D
  cmd_codes_json     TEXT,                 -- override for Datecs CMD codes
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
