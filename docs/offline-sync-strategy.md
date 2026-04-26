# Offline & Sync Strategy

The POS desktop is **offline-first**. The backend is the eventual source of truth; the local SQLite is the *operational* source of truth.

## Operations

### Allowed offline
- Create local order
- Add / remove items, modifiers, notes
- Apply discount, tip
- Send-to-kitchen → write `kitchen_tickets` row + enqueue `print_jobs`
- Cash payment
- Fiscal print **cash** via Datecs (printer is local; no network needed)
- Close order

### Forbidden offline
- Card payment (terminal must be online to its acquirer)
- Editing master data (products, prices, users, taxes)
- B2B invoicing / e-Factura submission
- Z-report (manager action; we want server-side audit)
- Operations on orders **not owned** by this device — see ownership rule

## Ownership rule (enforced by pos-core, Sprint 1)

`pos-core/state-machine.ts:assertOwnedLocally(order, localDeviceId, online)` is called from **every mutation action** (`addItem`, `voidItem`, `applyDiscount`, `addTip`, `sendToKitchen`, `registerCashPayment`, `registerCardPaymentResult`, `createFiscalAttempt`). When `online === true`, server arbitrates and the guard is a no-op. When `online === false`, the order may only be edited by the device whose `id === order.ownerDeviceId`. Any other device sees `OrderNotOwnedError` with a Romanian operator message.



A `locked_by_device_id` flag on the server is *not enough* if both devices are offline — they cannot coordinate. So we use **local ownership**:

- A device "owns" an order if (a) it created the order locally, or (b) it received an `ownership_grant` from the server while online.
- Cached orders from other devices appear **read-only** while offline. The UI displays a lock icon and a tooltip: "Sincronizare necesară pentru a edita".
- On reconnection, the backend validates ownership, version, and status. If two devices each created edits, the backend resolves per the conflict rules below and the loser sees a conflict screen.

## Event store

`events` table is **append-only**. Every state change is one row:

```
events(id, mutation_id UNIQUE, type, payload_json, created_at, status, synced_at, server_response_json, last_error)
```

Status: `pending → processing → synced` (happy path) or `pending → processing → failed → … → dead` (after exponential backoff exhaustion).

`mutation_id` is a v4 UUID generated at the *click handler*, persisted to SQLite **before** any network call or hardware call. This guarantees:
- After a crash, the event is recoverable and retryable.
- The backend dedupes by `mutation_id` (idempotency).
- Hardware (fiscal printer) dedupes by `mutation_id` (no double receipts).

## Sprint 3 status update

| Component | File | Status |
|---|---|---|
| HTTP transport | `pos-desktop/src/lib/sync/httpTransport.ts` | ✅ |
| Transport selection (memory ↔ http) | `pos-desktop/src/lib/sync/bootstrap.ts` + `lib/config.ts` | ✅ |
| Backend `/api/pos/sync/push` (idempotent) | `backend/src/api/pos.py` | ✅ |
| Backend `/api/pos/sync/pull` (stub) | `backend/src/api/pos.py` | ✅ stub |
| Backend `/api/pos/bootstrap` | `backend/src/api/pos.py` | ✅ |
| Device register / heartbeat / logs | `backend/src/api/pos.py` | ✅ |
| Conflict UI tray | _Sprint 8_ | ⬜ |
| Dead-letter UI | _Sprint 8_ | ⬜ |
| Real `/api/pos/sync/pull` deltas | _Sprint 8/9_ | ⬜ |

### `/api/pos/sync/push` idempotency contract

The backend persists every event in `pos_sync_events` with `mutation_id` UNIQUE. On replay (any subsequent push with the same `mutation_id`), the stored `result_status` and `result_json` are returned **without re-processing**. This guarantees:

- The desktop can safely retry indefinitely.
- A POS desktop crash mid-sync produces zero duplicate orders/payments/fiscal-receipts.
- Forwarding from `pos_sync_events` into the live `restaurant_orders` tree (Sprint 4+) is a separate concern; the dedup spine is in place now.

## Sprint 2 implementation status

Implemented in `pos-desktop/src/lib/sync/`:

| Component | File | Status |
|---|---|---|
| Append-only event store | `eventStore.ts` | ✅ |
| sync_outbox writer | `eventStore.ts` (single tx with events insert) | ✅ |
| Backoff schedule (1s, 5s, 30s, 2m, 10m, cap 1h) | `backoff.ts` | ✅ |
| Outbox worker (pull, push, retry, dead-letter) | `outboxWorker.ts` | ✅ |
| Per-order serialisation | `outboxWorker.ts:groupByOrder` | ✅ |
| Transport contract | `transport.ts` | ✅ |
| In-memory transport (success/duplicate/conflict/offline/timeout/failed/fatal) | `inMemoryTransport.ts` | ✅ |
| HTTP transport (real backend) | _Sprint 3_ | ⬜ |
| Conflict UI tray | _Sprint 8_ | ⬜ |
| Dead-letter UI | _Sprint 8_ | ⬜ |
| Pull (`/api/pos/sync/pull`) | _Sprint 3_ | ⬜ |
| WAL mode + crash backups | _Sprint 8_ | ⬜ |

**Restart contract verified by test** (`__tests__/outboxWorker.test.ts: restart replay`): persisted events survive a "process restart" (we model this by tearing down the worker + store and rebuilding both against the same DB). The same `mutation_id` is replayed; the in-memory transport replies `accepted` first time and `duplicate` on the second, demonstrating idempotency.

## Outbox processing

A background worker reads `sync_outbox` ordered by `created_at`. For each pending event:

1. POST to `/api/pos/sync/push`.
2. On `200 OK` with `{status: "applied", server_state}` → mark `synced`, update local row from server state.
3. On `200 OK` with `{status: "duplicate"}` → mark `synced` (server had it already).
4. On `409 Conflict` → mark `failed`, surface to conflict UI.
5. On `5xx` / network → exponential backoff: 1s, 5s, 30s, 2m, 10m, capped at 1h. After 50 attempts → `dead` (manager intervention).
6. On `4xx` (other than 409) → `dead` immediately (the payload is wrong; retrying won't help).

The worker is single-threaded **per `order_id`** so events on the same order land in order at the server.

## Pull (delta sync)

`/api/pos/sync/pull?since=<cursor>` returns events that other devices created (e.g. waiter B's order). The cursor is per resource (orders, kitchen_tickets, payments). Stored in `sync_cursor`.

Pull runs:
- Once at boot.
- Every 30s while online.
- Immediately after every push that succeeded (to converge fast).
- On WebSocket nudge (Sprint 9).

## Conflict handling

Server-side rules (enforced in `/api/pos/sync/push`):

1. Order is `paid` / `cancelled` → reject any mutation.
2. Order has `fiscal_receipt_number` → reject `add_item`, `apply_discount`, `void_item`.
3. Items are append-only. "Removal" is a `void_item` event with reason; we never delete history.
4. Payments are append-only.
5. Per-field last-writer-wins for `discount_note`, `tip_total`, `customer_name`.

On conflict, the offending event is marked `failed` and surfaced in the **Conflict Tray** (Sprint 8) with the server's current state and a manager-only "Force resolve" action.

## Crash safety

- SQLite in **WAL mode** (`PRAGMA journal_mode=WAL`).
- Synchronous writes for the `events` table (`PRAGMA synchronous=NORMAL` by default; FULL on the commit that closes a fiscal print).
- Hourly compressed backup of the SQLite file to `%APPDATA%/360booking-pos/backups/` (Sprint 8).
- The Tauri shell enforces single-instance — two POS-desktops on the same machine would corrupt the DB otherwise.

## Restart contract

After a crash mid-action, on next boot:
1. The DB opens cleanly (WAL replays on its own).
2. A startup task scans `events` where `status IN ('pending','processing')` and:
   - For non-hardware events → re-marks `pending` and lets the outbox retry.
   - For fiscal/payment events with status `unknown` (timeout mid-call) → routes them to the **Recovery Queue** (Sprint 8) — never auto-retried, manager must confirm what physically happened.

## What we deliberately do NOT do

- **No CRDT.** We chose centralised conflict resolution because the data model is small and the user expectations (ownership + manager override) match a server-authoritative model better.
- **No fiscal-number pre-allocation.** The audit recommended block reservation, but real Datecs hardware emits the fiscal number from the device — we trust the response, store it after the fact, and refuse to invent a number locally. (See `fiscal-flow.md`.)
- **No automatic retry on fiscal `unknown`.** Risk of double-printing. See fiscal-flow.md.
- **No auto-fiscalisation when payment status is `unknown`.** Same reason.

---

## Sprint 4 — server-authoritative IDs and bootstrap refresh

Sprint 4 closes out the offline-sync contract for the order pipeline with two rules.

### orderLocalId ↔ orderServerId mapping

The desktop generates a UUID for every new order locally (`orderLocalId`) so it can keep working without backend latency or connectivity. The backend, when it processes the first `ORDER_CREATED` for that local id, generates the *real* `restaurant_orders.id` and returns it in `serverState.orderId`. The mapping is persisted on both sides:

- **Desktop (SQLite `events` table):** writes `orderServerId` onto its event row once the push succeeds; the cart pane treats `orderServerId` as authoritative once known.
- **Backend (`pos_sync_events`):** stores both `order_local_id` and `order_server_id` on the row that processed `ORDER_CREATED`, and the same `order_server_id` on every later event for the same `order_local_id`.

**Resolution rule.** Any later event (`ORDER_ITEM_ADDED`, `PAYMENT_REGISTERED`, …) may arrive at the backend with **only `orderLocalId`** — the desktop need not block waiting for the round-trip. The `/api/pos/sync/push` handler resolves `orderServerId` from the prior mapping (`pos_sync_events` filtered on `order_local_id` with `order_server_id IS NOT NULL`) and proceeds. If no prior `ORDER_CREATED` exists, the event is recorded as `failed` with `errorCode=ORDER_NOT_FOUND`.

### Duplicate `ORDER_CREATED`

A replay returns the **same** `orderServerId`. The dedup spine is `pos_sync_events.mutation_id` (UNIQUE); on a duplicate push the server replays `result_json` verbatim without invoking `restaurant_order_service.create_draft` a second time. This is what makes the desktop safe to retry indefinitely on a flaky link.

### Bootstrap refresh — 30-minute background cadence

On top of the existing manual + first-launch refreshes, the desktop runs a background `fetchBootstrap()` every 30 minutes. The refresh is **non-disruptive**:

1. **In-flight order is not affected.** The current cart and any draft orders keep using the price/VAT snapshot they captured at `addItem` time.
2. **Item-level price/VAT snapshot.** When an item is added to an order, its `unitPrice`, `vatRate`, and `name` are frozen on the order line. A subsequent menu price change does *not* mutate that line. This matches `restaurant_order_service.add_item` server-side, which writes `unit_price` and `name_snapshot` on the `RestaurantOrderItem` row.
3. **Newly-inactive products.** If a product becomes `isActive=false` server-side, the desktop hides it from the **add-to-cart** flow but keeps it visible on any open order that already has it. No silent removal.
4. **Offline behaviour.** If the device is offline at the 30-minute tick, the refresh is skipped and retried on the next cycle. The status bar shows the timestamp of the last successful bootstrap.
5. **Refresh failure.** A failing refresh does not interrupt the POS; the UI surfaces a yellow `Bootstrap stale` indicator and falls back to the cached SQLite snapshot.

The first version uses full-bootstrap refresh (idempotent UPSERT into the local catalogue tables). When `/api/pos/sync/pull?since=cursor` ships its real diff (Sprint 8/9), the 30-minute cadence switches to delta pull and full bootstrap becomes a defensive fallback only.

---

## Sprint 6 — pull is live

`/api/pos/sync/pull?since=<iso>` is no longer a stub. It's the live read
channel for orders + kitchen tickets, separate from the catalogue
refresh which still runs through `/api/pos/bootstrap`.

**Push-then-pull on reconnect.** When the desktop comes back online,
the engine kicks the outbox first (so the desktop's own writes land
on the backend) and *then* runs `pullScheduler.runNow()` (so the
read snapshot includes everything we just wrote). Every 8 seconds
the scheduler ticks again with the same order. A pull failure is a
no-op — the cached SQLite snapshot stays the source of truth and the
next tick retries.

**Foreign-device read-only.** Any order whose `tableId` matches a
table the operator hasn't claimed locally renders in `TablesPane`
with a `Lock` badge. Reading is fine; writing is intentionally
blocked at the pos-core action layer (`assertOwnedLocally`). Sprint 7
adds server-side lock acquisition so a waiter at another station can
explicitly take over a table, with a clean UI.

**Kitchen tickets are a full-replace each pull.** The model has no
`updated_at` so the backend ships every active ticket and the desktop
deletes-and-reinserts the local cache on each pull. ~200 rows max per
restaurant during service is fine; an `updated_at` column lands when
Sprint 8 / KDS sync needs it.

**Cursor persistence.** The cursor lives in
`settings.sync.pull.cursor` so a desktop restart picks up where it
left off; if the cursor is missing the desktop falls back to a cold
snapshot, which is identical to the first-launch case.
