# POS Desktop — Architecture (Sprint 0 baseline)

This document captures the architectural decisions implemented in Sprint 0 and the contracts later sprints must respect. It is the entry point for any contributor.

## Stack

| Layer | Choice | Rationale |
|---|---|---|
| Shell | Tauri 2 (Rust) | 10× smaller bundle than Electron, native single-instance + auto-update plugins, sidecar binary support for the existing Python `fiscal-bridge`. |
| UI | React 18 + TypeScript + Vite + Tailwind 3 | Same stack as the web POS — full visual + code reuse. |
| State (UI) | Zustand + React Query | Same as web. |
| Local DB | SQLite via `tauri-plugin-sql` | Robust, file-based, WAL mode for crash safety. |
| Hardware I/O | Sidecar processes (Python today, Rust later) over stdio JSON-RPC | Existing Datecs `fiscal-bridge` is reused as a sidecar without rewrite. Same pattern for printer / payment terminal. |
| HTTP client | axios (`@/lib/api/client`-equivalent, redux-free) | Mirrors web client; auto-retries through the sync engine, not at the axios layer. |
| Logging | `tauri-plugin-log` + structured ring buffer in SQLite | Logs ship to backend when online (Sprint 11). |
| Auto-update | `tauri-plugin-updater` | Wired in Sprint 10. |

If any of these blocks during Sprint 0 with no workaround, fall back to **Electron + React** is documented in the parent task brief; we did not hit any blocker.

## Top-level layout

```
/opt/360booking/
├── backend/              ← unchanged in Sprint 0
├── frontend/             ← unchanged in Sprint 0
├── fiscal-bridge/        ← unchanged in Sprint 0; will be packaged as a sidecar in Sprint 5
├── docs/                 ← new design + architecture docs
│   ├── pos-ui-parity.md
│   ├── pos-desktop-architecture.md
│   ├── offline-sync-strategy.md
│   ├── fiscal-flow.md
│   ├── hardware-adapters.md
│   └── github-public-release.md
└── pos-desktop/          ← NEW — Tauri shell + React UI
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── index.html
    ├── config.example.json
    ├── README.md
    ├── .gitignore
    ├── .env.example
    ├── src/
    │   ├── main.tsx
    │   ├── App.tsx
    │   ├── styles/globals.css
    │   ├── features/pos/         ← three-pane shell, status bar
    │   ├── features/settings/    ← devices, COM ports, diagnostics
    │   ├── adapters/             ← FiscalDeviceAdapter, PaymentTerminalAdapter, ReceiptPrinterAdapter + simulators
    │   ├── lib/                  ← config, api client, db client, logger
    │   ├── store/                ← zustand stores
    │   └── sql/migrations/       ← SQLite migrations (raw SQL files)
    └── src-tauri/
        ├── Cargo.toml
        ├── tauri.conf.json
        ├── build.rs
        ├── src/main.rs
        └── capabilities/default.json
```

## Internal layering (must not be violated)

```
┌────────────────────────────────────────────────────┐
│ React UI                  (apps/pos-desktop/src)   │  ← presentational only
│  └─ uses zustand stores + queries                  │
├────────────────────────────────────────────────────┤
│ pos-core                  (later sprint package)   │  ← pure TS, no I/O, no React
├────────────────────────────────────────────────────┤
│ sync-engine + db-client   (lib/db.ts, lib/sync.ts) │  ← talks to SQLite + outbox
├────────────────────────────────────────────────────┤
│ adapters (Fiscal/Payment/Printer)  (adapters/)     │  ← hardware contract; impls = sim or sidecar
├────────────────────────────────────────────────────┤
│ Tauri Rust shell  (src-tauri)                      │  ← single-instance, sidecar lifecycle, OS bridges
└────────────────────────────────────────────────────┘
```

Hard rules:
1. **React components never import from `adapters/` directly** — they go through a service layer (`features/*/service.ts`). This keeps hardware swappable.
2. **No fetch in components** — all HTTP goes through `lib/api/client.ts`, which is the only place that knows about the backend URL.
3. **No fiscal logic in UI** — fiscal state machine lives in `pos-core` (Sprint 1) and is invoked by the FiscalService.
4. **No backend dependency for critical operations** — see `offline-sync-strategy.md`.

## Sprint 3 additions (this commit)

### Backend — `/api/pos/*` router (additive)

Mounted at `/api/pos` in `backend/src/api/main.py`. Endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/pos/health` | Server time + DB OK + app/pos versions. Replaces `/api/health` for the desktop StatusBar. |
| GET  | `/api/pos/bootstrap?restaurant_id=` | Master-data snapshot: products, categories, tables, users, vat config, sync cursor. |
| POST | `/api/pos/sync/push` | Idempotent event ingestion (see contract below). |
| GET  | `/api/pos/sync/pull?since=N` | Stub returning `{events: [], nextCursor}` — Sprint 8/9 fills it in. |
| POST | `/api/pos/devices/register` | Idempotent on `(tenant_id, device_id)`. |
| POST | `/api/pos/devices/{device_id}/heartbeat` | Updates `last_seen_at` + `status`. |
| POST | `/api/pos/devices/{device_id}/logs` | Batch log ingestion. |

Auth: existing JWT staff token (`Depends(get_current_active_user)`). Tenant comes from the user row.

### New tables (Alembic migration `possync0427`)

- `pos_devices` — paired Windows POS stations (`device_id` unique per tenant via composite index).
- `pos_sync_events` — append-only mutation log; **`mutation_id` is globally unique** and is the dedup key.
- `pos_device_logs` — structured logs shipped from the desktop.

All three are additive — no existing table is altered.

### Tip-in-VAT alignment (backend)

`fiscal_service._vat_base_for(order)` now returns `subtotal − discount` by default. Set `POS_TIP_IN_VAT_BASE=true` in the env to restore the legacy behaviour (tip included in the VAT base). Tests in `tests/test_tip_in_vat_alignment.py` cover both modes.

### Desktop — HTTP transport

`pos-desktop/src/lib/sync/httpTransport.ts` implements the same `SyncTransport` interface as `InMemorySyncTransport`. The outbox worker is unchanged. HTTP error mapping:

| HTTP outcome | PushOutcome.status | retryable |
|---|---|---|
| 200 + per-event `accepted`/`duplicate`/`conflict`/`failed` | as returned | server-driven |
| 200 but mutation missing from results | `failed` | true |
| 409 | `conflict` | false |
| 400 / 422 | `failed` | false |
| 401 / 403 | `failed` | false (auth must be fixed) |
| 500+ | `failed` | true |
| Network / no response | `failed` (NETWORK) | true |
| Timeout (`ECONNABORTED`) | `failed` (TIMEOUT) | true |

### Transport selection

`AppConfig.syncTransportMode = 'memory' | 'http'`. Default: `memory`. Inferred to `http` when `POS_BUILD_PROFILE=tenant` AND `VITE_BACKEND_URL` is set. Override with `VITE_SYNC_TRANSPORT_MODE=http`.

### Deploy step required for live verification

`/api/pos/*` is new code. The running backend container loaded `main.py` before this commit; restart is needed:
```bash
cd /opt/360booking && docker compose restart backend
```
After restart, smoke-probe inside the container:
```bash
docker compose exec backend python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/api/pos/health').read())"
```
Expected: JSON `{"status":"ok","server_time":"...","db_ok":true,"app_version":"...","pos_api_version":"1.0.0", ...}`.

## Sprint 2 additions (this commit)

- **Local event store + outbox** in `pos-desktop/src/lib/sync/`:
  - `eventStore.ts` — `persistBatch`, `pendingDue`, `markSynced`, `scheduleRetry`, `markFailed`, `markDead`, `counts`. Single transaction for the `events` + `sync_outbox` insert pair so the queue can never lose an event without a row, and vice versa.
  - `backoff.ts` — 1s / 5s / 30s / 2m / 10m / cap-1h ladder, exactly per `offline-sync-strategy.md`.
  - `outboxWorker.ts` — pulls due rows, groups by `order_local_id` for per-order serialisation, sends through transport, applies outcomes, schedules retries, dead-letters at 50 attempts. `start()` returns a stop fn.
- **SyncTransport contract** + `InMemorySyncTransport`. Modes: `success / duplicate / conflict / offline / timeout / failed / fatal`. Per-mutation `scriptOutcome()` for targeted scenarios. Sprint 3 swaps in an `HttpSyncTransport` without touching the worker.
- **DB executor abstraction** (`SqlExecutor`):
  - `tauriExecutor` wraps `tauri-plugin-sql` (production).
  - `memoryExecutor` is a hand-rolled in-memory shim that understands ONLY the SQL the sync engine sends — used by tests so we can run on Node without bundling SQLite.
- **Migration 0002** adds `events.order_local_id` for per-order grouping.
- **Dispatch** (`dispatch.ts`): `runAction(() => addItem(order, cmd, ctx))` runs the pure pos-core action and persists the resulting events. UI never touches the store directly.
- **useSyncStatus** hook polls `store.counts()` into the device-status zustand store. StatusBar got two new pills: **failed** (when > 0) and **dead** (when > 0), plus a `tx:in-memory|http` badge so the operator can see which transport is live.
- **Tests:** 27 new vitest cases (96 total). Coverage on pos-core + sync + db = **96.58% lines / 87.16% branches / 94.84% functions**.

### Tip-in-VAT decision (Sprint 2)
pos-core stays correct (tip out of VAT base); backend stays as-is for now. To be aligned in Sprint 3 when `/api/pos/sync/push` lands. The cart pane will label its TVA row as a preview; the fiscal receipt remains authoritative. See `docs/fiscal-flow.md § Tip-in-VAT — official rule`.

## Sprint 1 additions (this commit)

- New `pos-desktop/src/core/pos-core/` — pure TypeScript domain, **no React, no I/O**.
- Public surface: `types/`, `money`, `vat`, `calculator`, `state-machine`, `actions`, `events`.
- 13 pure actions (createOrder, addItem, voidItem, applyDiscount, addTip, sendToKitchen, registerCashPayment, registerCardPaymentResult, createFiscalAttempt, markFiscalPrinted, markFiscalUnknown, closeOrder, cancelOrder).
- 9-state order state machine with typed transition errors (IllegalTransitionError, OrderCancelledError, OrderFiscalisedError, OrderNotPaidError, OfflineCardPaymentError, FiscalUnknownNoRetryError, OrderNotOwnedError, PaymentExceedsRemainingError, EmptyOrderError).
- Money is **integer cents** everywhere; VAT rate is **integer basis points**. Verified by tests that every calculator output is `Number.isInteger`.
- `PosShell.tsx` `CartPane` now reads totals from `computeTotals(order)` against a demo order. Layout unchanged.
- 69 vitest tests, **98.47% statements / 91.37% branches / 96.61% functions** coverage on pos-core.

### What pos-core deliberately does NOT do (kept out for later sprints)
- No SQLite I/O — that's the sync engine's job (Sprint 2).
- No HTTP — apiClient handles that.
- No COM port / hardware — adapters wrap that.
- No React hooks — UI consumes the pure functions and stores state in zustand.
- No `Date.now()` / `Math.random()` directly — caller injects `Clock` + `IdGen` so events are deterministic and replayable.

## Sprint 0 deliverables (this commit)

- pos-desktop scaffold with Tauri 2 + Vite + React 18 + TS + Tailwind.
- Three-pane POS shell visually matching the web POS (skeleton — no live data yet).
- Top status bar with placeholder indicators (backend / DB / fiscal / payment / printer / queue / online).
- SQLite schema migration for all 15 Sprint 0 tables.
- Adapter interfaces + working simulators (fiscal/payment/printer).
- Backend healthcheck plumbing (HTTP).
- Sidecar stub: a Rust command that reports whether the fiscal-bridge sidecar binary is present (without launching real fiscalisation).
- Local config loader with `config.example.json` template.

## Future sprint integration points

| Sprint | Adds | Touches |
|---|---|---|
| 1 | `pos-core` package (pure TS state machine + types) | `pos-desktop/src/features/pos/*` switches to import from pos-core |
| 2 | Real event store + outbox processor | `pos-desktop/src/lib/sync.ts` |
| 3 | FastAPI `/api/pos/*` endpoints | New backend router; pos-desktop bootstrap + push targets it |
| 4 | UI parity completion (live data, full menus, full ticket panel) | UI components |
| 5 | Real Datecs adapter via sidecar | adapters/fiscal/datecs.ts + src-tauri sidecar manifest |
| 6 | Real ESC/POS printer adapter | adapters/printer/escpos.ts |
| 7 | Real payment terminal adapter | adapters/payment/* |
| 8 | Conflict UI + dead-letter queue | features/sync/* |
| 9 | KDS desktop / WS sync | new features/kds/* |
| 10 | Installer + GitHub release pipeline | src-tauri/tauri.conf.json updater config |
| 11 | Pilot stabilisation | diagnostics, telemetry |

## Sprint 4 — server-authoritative IDs and live-table forwarding

Sprint 4 connects the dedup spine (Sprint 3) to the actual `restaurant_orders` / `restaurant_order_items` / `restaurant_order_payments` tables and locks in the `orderLocalId ↔ orderServerId` contract.

### ID lifecycle

```
desktop:                               backend:
─────────                              ────────
runAction(ORDER_CREATED)
  ├─ orderLocalId = uuid()
  └─ event → outbox            ─push─►  POST /api/pos/sync/push
                                          └─ create_draft(restaurant=..., waiter_id=user.id)
                                              └─ order.id ← uuid()             ← server-generated
                                          └─ pos_sync_events.row(
                                                order_local_id, order_server_id=order.id,
                                                mutation_id, …)
                                          ◄─ serverState.orderId
event store update on outcome                ↑                                    ↑
  ├─ orderServerId saved on event row        │                                    │
  └─ cart pane treats it as authoritative    │                                    │
                                                                                  │
runAction(ORDER_ITEM_ADDED, …)                                                    │
  ├─ payload references productId, quantity                                       │
  └─ event.orderLocalId = "o-1"  ─push─►  POST /api/pos/sync/push                  │
                                          └─ resolve order_server_id ────────────┘
                                              from pos_sync_events
                                                where order_local_id="o-1"
                                                AND   order_server_id IS NOT NULL
                                          └─ add_item(order, menu_item, qty)
                                          ◄─ serverState.itemId, totals
```

The desktop never has to wait for `serverState.orderId` before pushing the next mutation — `orderLocalId` alone is enough for the backend to resolve. Only when the desktop wants to show the server-side id (for staff-side support, or the URL of a printed receipt) does it need `orderServerId`.

### Dedup spine vs. live-table writes

Each push runs in two layers inside one DB transaction:

1. The forwarder runs inside `db.begin_nested()` (a SQLite/Postgres SAVEPOINT). On success it commits the savepoint; on `ValueError` it rolls back the savepoint *only*, so any half-written row from `add_item` / `add_payment` is discarded.
2. The `pos_sync_events` row itself is then inserted in the outer transaction with `result_status='accepted'` or `'failed'` depending on what happened. The dedup spine row therefore *always* lands, which lets the desktop replay and discover the failure without re-attempting the side effects.

The outer transaction is committed once, at the end of the `/api/pos/sync/push` call, after all events in the batch have been processed.

### Forwarder coverage

| Event type | Forwarded? | Service called | serverState fields |
|---|---|---|---|
| `ORDER_CREATED` | ✅ Sprint 4 | `restaurant_order_service.create_draft` | `orderId`, `status`, `isOpen`, `totals` |
| `ORDER_ITEM_ADDED` | ✅ Sprint 4 | `restaurant_order_service.add_item` | `itemId`, `orderId`, `lineTotal`, `totals` |
| `ORDER_ITEM_QTY_UPDATED` | ✅ Sprint 5 | `restaurant_order_service.update_item(quantity=…)` | `itemId`, `orderId`, `quantity`, `lineTotal`, `totals` |
| `ORDER_ITEM_VOIDED` | ✅ Sprint 5 | in-pos.py soft-void (`status='void'`, `line_total=0`) + `_recalculate_totals` | `itemId`, `orderId`, `status`, `totals` |
| `SENT_TO_KITCHEN` | ✅ Sprint 5 | `restaurant_order_service.send_to_kitchen` (one ticket per station) | `orderId`, `status`, `kitchenTicketIds`, `stations` |
| `PAYMENT_REGISTERED` | ✅ Sprint 4 | `restaurant_order_service.add_payment` (auto-issues fiscal receipt on full settle) | `paymentId`, `orderId`, `paymentStatus`, `fiscalReceiptNumber` |
| `DISCOUNT_APPLIED`, `TIP_ADDED`, `FISCAL_*`, `ORDER_CLOSED`, `ORDER_CANCELLED` | ⏳ | (Sprint 6+) | `{ack:true, stage:"stored"}` (envelope persisted for forensic replay) |

### Pull contract (Sprint 6)

`GET /api/pos/sync/pull?since=<iso>` is the live read channel. Where push
is the desktop telling the backend what changed locally, pull is the
backend telling the desktop what other devices (and the web POS)
changed remotely. The combo is run by `pullScheduler` every 8 seconds,
and on reconnect the engine schedules push BEFORE pull so any pending
local mutation lands first.

Response shape:

```jsonc
{
  "events": [],
  "changes": {
    "orders":         [ {id, tableId, status, paymentStatus, isOpen,
                          subtotal, discountTotal, tipTotal, total,
                          currency, source, openedAt, closedAt,
                          sentToKitchenAt, updatedAt}, ... ],
    "orderItems":     [ {id, orderId, menuItemId, name, quantity,
                          unitPriceCents, lineTotalCents, vatRateBp,
                          status, kitchenTicketId, roundNumber, sentAt}, ... ],
    "kitchenTickets": [ {id, orderId, station, status,
                          createdAt, seenAt, completedAt,
                          preparationSeconds}, ... ]
  },
  "nextCursor": "2026-04-26T08:00:00.123456+00:00",
  "serverTime": "2026-04-26T08:00:00.180000+00:00"
}
```

Cursor strategy:
- Cursor is a server-generated ISO-8601 timestamp echoed back unchanged.
- `since=null` (no cursor): server returns only **open** orders + their
  full items + the active kitchen-ticket set. This is the cold-start
  snapshot a freshly-paired desktop sees.
- `since=<iso>`: server returns rows whose `updated_at > cursor`,
  including orders that just closed (so the cache can drop them).
  Items: full per-order re-list when the order's `updated_at` advances
  (any line edit bumps the parent's `updated_at` via
  `_recalculate_totals`).
- Kitchen tickets: full active set every pull. The ticket model has
  no `updated_at` column, so a full re-list is the only honest answer
  until Sprint 8 adds one. Acceptable cost: ≤200 rows per restaurant
  during service.

Merge rules on the desktop (`applyPullChanges`):
- Orders UPSERT by `id`. `isOpen=false` triggers `DELETE FROM
  remote_orders WHERE id = ?` so closed tabs disappear from the cache.
- Items full-replace per order: `DELETE FROM remote_order_items WHERE
  order_id = ?` then re-insert the rows the server shipped.
- Kitchen tickets full-replace: `DELETE FROM remote_kitchen_tickets`
  then re-insert. A ticket missing from the new batch has been
  completed and should disappear.
- Cursor persisted in `settings.sync.pull.cursor` so a restart picks
  up where it left off.
- The merge runs inside one SQLite transaction; partial failure
  rolls back. The `events` / `sync_outbox` tables (the desktop's own
  write side) are NEVER touched by a pull.

Foreign-device read-only rule:
- A remote order on a table that the operator hasn't claimed locally
  shows up in `TablesPane` with a small lock badge. Tapping the table
  is allowed (operator may want to inspect / pay), but writing to
  that order from this desktop is intentionally blocked at the
  pos-core action layer (`assertOwnedLocally` already enforces the
  ownership check in offline mode; Sprint 6 documents the pattern,
  Sprint 7 brings server-side lock acquisition for online takeover).

### Per-line server-id mapping (Sprint 5)

`ORDER_ITEM_ADDED` carries `payload.localItemId` — the desktop's UUID
for the new line. The backend forwarder writes `result_json.itemId` =
the server `RestaurantOrderItem.id` it just created.

For any later mutation on the same line (`ORDER_ITEM_VOIDED`,
`ORDER_ITEM_QTY_UPDATED`), the desktop only needs to send the
`localItemId`. The backend resolves it through
`_resolve_server_item_id`, which scans accepted `ORDER_ITEM_ADDED`
rows in `pos_sync_events` (filtered by `tenant_id`) and matches on
`payload_json.localItemId`. The tenant filter keeps the lookup
cheap; the secondary index on `event_type` plus the tenant index
makes the scan fit in memory for any realistic order size.

This mirrors the order-id mapping (Sprint 4) but at one level
deeper. The dedup spine still wins: a duplicate mutation_id replays
the stored result, and a forwarded mutation that finds no prior
add lands as `failed` with `errorCode=ITEM_NOT_FOUND`.

### Auth tightening

Every `/api/pos/*` endpoint **except** `/health` now requires `require_restaurant_waiter` (waiter / tenant_admin / super_admin). `/health` stays public because the desktop status bar polls it before login, and because it is the same contract as `/api/health`.

## Why we did NOT introduce a global pnpm-workspace yet

Doing so would require modifying `/opt/360booking/frontend/package.json` and the deploy pipeline, which Sprint 0 explicitly forbids. `pos-desktop/` is a self-contained package with its own `package.json` and `node_modules`. When Sprint 1 introduces `packages/pos-core`, we revisit and likely add a workspace root with `frontend`, `pos-desktop`, and `packages/*` — but only if that change can be done without touching the web build/deploy.
