-- ============================================================================
-- 360booking POS desktop — migration 0009 (Faza 2 — local payment outbox)
-- ============================================================================
--
-- Append-only ledger of cash payments that were collected on this device
-- while offline (or that are mid-flight to the backend). The flow is:
--
--   1. operator taps "Cash" on a cached server order → DP-25X prints the
--      bon fiscal locally → row inserted here as `pending_sync` with the
--      external receipt number stamped on it.
--   2. localPaymentSyncWorker picks it up when reachable, flips the row
--      to `syncing`, posts to /api/restaurant/orders/{order_id}/payments
--      with the SAME `idempotency_key`, the receipt number, and
--      `fiscalization_source='device_offline'` so the backend attaches
--      our locally-issued receipt instead of minting a new one.
--   3. on 200 → `synced`; on transient → exponential `next_retry_at`;
--      on 4xx non-retriable → `failed` (UI surfaces a persistent alert).
--
-- We never delete `synced` rows from this table. Operators (and us) need
-- the audit trail when reconciling fiscal counters with the cloud — the
-- backend's `idempotency_keys` row is the dual side of this ledger and
-- the two together prove that a given bon fiscal corresponds to exactly
-- one payment in production.
--
-- Constraints:
--   - `idempotency_key` is UNIQUE — the same key cannot drive two
--     payments; the worker uses this key on the wire.
--   - `local_payment_id` is UNIQUE — this is the desktop's own UUID for
--     the row (used in logs / UI references); never reused.
--   - `order_id` is the SERVER order id (`remote_orders.id`). Cash
--     offline is forbidden on draft-only / non-cached orders, so this
--     column is non-null and references the cached server id directly.

CREATE TABLE IF NOT EXISTS local_payment_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Multi-tenant scoping mirrors the rest of the desktop schema so a
    -- future multi-restaurant build doesn't have to reshape this table.
    restaurant_id TEXT NOT NULL,
    order_id TEXT NOT NULL,            -- server order id (remote_orders.id)
    local_payment_id TEXT NOT NULL,    -- desktop UUID — UNIQUE
    idempotency_key TEXT NOT NULL,     -- key sent on /payments — UNIQUE

    amount_cents INTEGER NOT NULL,
    method TEXT NOT NULL DEFAULT 'cash',
    -- Lifecycle: pending_sync → syncing → synced
    --                       └──────────→ failed (non-retriable)
    status TEXT NOT NULL DEFAULT 'pending_sync',

    -- Wall-clock timestamps. `collected_at` is when the operator pressed
    -- Cash and the bon was printed; `synced_at` is when the backend
    -- acknowledged the payment.
    collected_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced_at TEXT,

    -- Retry bookkeeping. `attempts` includes the in-flight one.
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    last_error TEXT,

    -- Fiscal pass-through — the worker forwards both to the backend so
    -- it knows NOT to auto-fiscalize this payment (Faza 1 contract).
    external_fiscal_receipt_number TEXT,
    fiscalization_source TEXT NOT NULL DEFAULT 'device_offline',

    -- Optional links into the existing local fiscal ledger
    -- (`fiscal_attempts` was added in migration 0006). NULL when the
    -- desktop ran without the Rust fiscal port (rare on Windows; common
    -- in Vitest unit tests).
    fiscal_attempt_id INTEGER,
    fiscal_receipt_id TEXT
);

-- One key, one row, ever — protects against a bug in the worker that
-- might double-claim a row or against multiple POS instances writing
-- against the same db file (we don't support that, but the constraint
-- makes it explicit).
CREATE UNIQUE INDEX IF NOT EXISTS uq_local_payment_outbox_idempotency_key
    ON local_payment_outbox (idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_local_payment_outbox_local_payment_id
    ON local_payment_outbox (local_payment_id);

-- Worker scan path: status + next_retry_at. We list pending rows oldest-
-- first and bound the batch in code; the index keeps the scan cheap even
-- when the table grows over a long offline shift.
CREATE INDEX IF NOT EXISTS ix_local_payment_outbox_status_retry
    ON local_payment_outbox (status, next_retry_at);

-- UI badge / per-order overlay reads by order_id; small partial index
-- expressed as a regular composite index (SQLite ignores WHERE on older
-- versions, which is fine — the planner still uses it).
CREATE INDEX IF NOT EXISTS ix_local_payment_outbox_order_status
    ON local_payment_outbox (order_id, status);
