-- =============================================================
-- 360booking POS desktop — migration 0008 (persist bridge credentials)
--
-- Stores the device_token + websocket_url returned by a successful
-- /api/fiscal-bridge/claim so the WSS loop can be re-started at app
-- launch without forcing the operator to generate a brand-new
-- enrollment code every time. Sprint 1 only persisted bridge_id in
-- station_pairings; everything else lived in memory and was lost on
-- restart.
--
-- Single-row table (id = 1) — one POS desktop = one paired bridge.
-- device_token is stored in clear for now, same caveat as the auth
-- refresh token (Stronghold / OS keychain is the same Sprint 11+
-- ticket that covers both).
-- =============================================================

CREATE TABLE IF NOT EXISTS fiscal_bridge_credentials (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  server_base_url     TEXT NOT NULL,
  websocket_url       TEXT NOT NULL,
  device_token        TEXT NOT NULL,
  bridge_id           TEXT NOT NULL,
  tenant_id           TEXT NOT NULL,
  printer_model       TEXT,
  device_id           TEXT,
  claimed_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
