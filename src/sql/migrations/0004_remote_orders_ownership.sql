-- =============================================================
-- 360booking POS desktop — migration 0004 (Sprint 7)
--
-- Owner / lock metadata on remote_orders so the desktop can show a
-- correct lock badge and gate cart edits without re-asking the backend.
-- =============================================================

ALTER TABLE remote_orders ADD COLUMN owner_device_id TEXT;
ALTER TABLE remote_orders ADD COLUMN owner_expires_at TEXT;
-- Server-computed convenience flag: 1 when the calling device may edit,
-- 0 when another device holds a valid lock. We store the value the
-- backend stamped at the time of pull; a fresh pull always overwrites.
ALTER TABLE remote_orders ADD COLUMN current_device_can_edit INTEGER NOT NULL DEFAULT 1;
