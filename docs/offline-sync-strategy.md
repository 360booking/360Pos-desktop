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
