# Windows POS smoke test — pilot checklist

This is the operator-facing checklist for the **first run of POS Desktop on a Windows machine** against the production backend at `https://360booking.ro`. Code is verified green on Linux (vitest 125/125, tsc clean, vite build OK), but Tauri shell + SQLite plugin + COM-port adapters only really run on Windows. Run through this list end-to-end before declaring the device pilot-ready.

> **Hard rule:** until every section here passes, do NOT enable real fiscal printing (Datecs), real card payments (BT POS), or real ANAF live submit. Simulator-only.

## 0. Prerequisites on the Windows machine

- [ ] Windows 11 (or 10 21H2+), x64.
- [ ] Visual C++ Redistributable 2015–2022 installed.
- [ ] Node.js LTS (≥ 20.10) installed (`node --version`).
- [ ] pnpm ≥ 9 installed (`pnpm --version`).
- [ ] Rust stable toolchain (only required if building from source: `rustup show`).
- [ ] Backend reachable: `curl https://360booking.ro/api/pos/health` → `pos_api_version: "1.2.0"`.
- [ ] User account credentials available — must have role `waiter`, `tenant_admin` or `super_admin` on a tenant that has at least one `restaurant`.

## 1. Clone + install

```powershell
git clone git@github.com:360booking/360Pos-desktop.git C:\360Pos-desktop
cd C:\360Pos-desktop
pnpm install
```

Expect: clean install, no peer dependency errors.

## 2. Configure environment

Create `.env` at the repo root:

```
VITE_BACKEND_URL=https://360booking.ro
VITE_SYNC_TRANSPORT_MODE=http
POS_BUILD_PROFILE=tenant
VITE_TENANT_SLUG=<your-tenant-slug>
VITE_RESTAURANT_ID=<your-restaurant-uuid>
```

## 3. First launch

```powershell
pnpm tauri dev
```

- [ ] Tauri shell window opens, no Rust panic.
- [ ] StatusBar visible, all dots starting at `unknown`.
- [ ] First HTTP call: `POST /api/pos/devices/register` with the local `device_id`. Verify in backend logs (`docker compose logs backend --tail=50 | grep devices/register`).
- [ ] Backend `Bootstrap` cell turns **green within 5 seconds** with detail `now`.

## 4. SQLite migrations 0001–0005

In a separate PowerShell window:

```powershell
$db = "$env:APPDATA\360booking-pos\pos-desktop.db"
sqlite3 $db ".tables"
```

Expected tables (alphabetical):
- `card_recoveries` ← Sprint 8
- `categories`, `products`, `tables`, `settings` ← Sprint 0/1
- `events`, `sync_outbox`, `sync_cursor` ← Sprint 0/1
- `device_logs` ← Sprint 0
- `orders`, `order_items` ← Sprint 0 (local-write side, not yet used)
- `remote_orders`, `remote_order_items`, `remote_kitchen_tickets` ← Sprint 6
- `__diesel_schema_migrations` (or tauri-plugin-sql equivalent)

```powershell
sqlite3 $db "SELECT version FROM _sqlx_migrations ORDER BY version"
```
Expected: `1, 2, 3, 4, 5`.

## 5. Bootstrap hydration

- [ ] In SQLite: `sqlite3 $db "SELECT count(*) FROM products"` returns the same product count as the backend.
- [ ] `sqlite3 $db "SELECT count(*) FROM tables"` returns the table count.
- [ ] StatusBar `Bootstrap` cell shows `now`. After 30 minutes, it auto-refreshes (StatusBar updates the timestamp to `now` again).

## 6. HTTP transport sanity (sync_outbox emptying)

Test scenario:
1. Tap a free table → POS creates a draft order (`ORDER_CREATED` event).
2. Tap a product in MenuPane → `ORDER_ITEM_ADDED` event.
3. Tap "Trimite" → `SENT_TO_KITCHEN` event.

Verify:
- [ ] In SQLite: `sqlite3 $db "SELECT count(*) FROM events WHERE status='pending'"` drops to 0 within ~3 seconds.
- [ ] `sqlite3 $db "SELECT count(*) FROM sync_outbox"` is 0 after a successful push.
- [ ] Backend logs: 3 `POST /api/pos/sync/push 200` entries.
- [ ] Backend DB: `SELECT id FROM restaurant_orders WHERE source='pos' AND opened_at > now()-interval '1 minute'` shows the new order.

## 7. Recovery Tray (CARD_PAYMENT_UNKNOWN)

> The simulator returns `unknown` ~10% of the time. To force one, hit the `Card POS` button several times until you see the yellow `recovery N` pill in the StatusBar.

- [ ] Pill appears in StatusBar with count.
- [ ] Tap pill → RecoveryTray modal opens with the row.
- [ ] Tap `Plătit` → row resolved (`status='resolved_paid'` in `card_recoveries`).
- [ ] Tap `Void` on a fresh unknown → `status='resolved_void'`.
- [ ] `Detalii` button shows the raw JSON.
- [ ] `Retry` button is **disabled** (BT POS adapter still in skeleton — Sprint 10).

## 8. Foreign-device claim flow

Run a second POS desktop on a second Windows machine OR run two `pnpm tauri dev` instances against the same backend with **different** `deviceId`s in their `%APPDATA%/360booking-pos/config.json`.

- [ ] Device A creates an order on table 5.
- [ ] Within 8 seconds (one pull tick), Device B sees table 5 with a 🔒 `Lock` icon.
- [ ] Device B taps table 5 → `ClaimOrderModal` opens showing Device A as owner + lock expiry.
- [ ] Device B with role `waiter`: only `Preluare` button visible (no force button).
- [ ] Device B with role `tenant_admin` / `super_admin`: both `Preluare` AND `Preluare forțată` visible.
- [ ] Tap `Preluare` while Device A still holds → response `conflict`, modal shows error.
- [ ] On Device B with admin role: tap `Preluare forțată` → response `claimed`, ownership transfers. Verify in backend: `pos_sync_events` has a row with `event_type='ORDER_LOCK_FORCE_CLAIMED'` (Sprint 9 audit).

## 9. KitchenQueueStrip

- [ ] After "Trimite", strip shows `1 pending` for the appropriate station.
- [ ] In a separate browser tab on the web POS (`https://360booking.ro/admin/restaurant/kds`), the same ticket appears.
- [ ] Mark ticket as `seen` in the web KDS (or via `POST /api/pos/kitchen-tickets/{id}/seen`).
- [ ] Within 8 seconds, the strip on the desktop reflects `1 preparing`.
- [ ] Mark ticket `complete` → strip drops the entry.

## 10. Heartbeat lock renewal

- [ ] In SQLite on Device A: `sqlite3 $db "SELECT key, value_json FROM settings WHERE key LIKE '%lastSync%'"` shows recent heartbeat timestamp.
- [ ] In backend DB: `SELECT id, owner_device_id, owner_expires_at FROM restaurant_orders WHERE owner_device_id IS NOT NULL` — `owner_expires_at` is bumped roughly every 60s.
- [ ] Stop Device A (close the Tauri window). After 10 min (TTL), the lock auto-expires; Device B sees the table without the lock badge.

## 11. Production build (one-shot)

```powershell
pnpm tauri build
```

- [ ] Build completes; installer at `src-tauri\target\release\bundle\msi\*.msi`.
- [ ] Run the MSI, install, launch from Start Menu.
- [ ] Repeat sections 4–9 against the installed build (no `tauri dev`).

## 12. Hand-off back to dev

If any section above fails, stop, capture:
- The failing step.
- Backend `docker compose logs backend --tail=200`.
- Desktop `%APPDATA%\360booking-pos\logs\*` (Tauri rotates them daily).
- A `sqlite3 $db ".dump"` of the local DB (small — < 1 MB per device).
- Screenshot of the StatusBar.

…and ping back so the dev team can patch before the pilot opens to live customers.
