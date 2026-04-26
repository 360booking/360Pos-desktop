-- =============================================================
-- 360booking POS desktop — migration 0002 (Sprint 2)
-- Add events.order_local_id so the outbox worker can serialise
-- pushes per order without parsing payload_json for every row.
-- =============================================================

ALTER TABLE events ADD COLUMN order_local_id TEXT;
CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_local_id);
