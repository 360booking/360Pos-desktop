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

## 0.5 Preflight (run BEFORE `pnpm tauri dev`)

Run each command in PowerShell. Each line should succeed; capture output for the failure-capture template if any fails.

```powershell
# Versions
node --version                              # expect: v20.x or v22.x
pnpm --version                              # expect: 9.x
rustup show                                 # expect: stable-x86_64-pc-windows-msvc default
where.exe rustc                             # expect: a path under .cargo\bin

# WebView2 runtime (Tauri 2 requires this; usually preinstalled on Win 11)
Get-AppxPackage -Name *WebView*             # expect: at least one match
# Or install: winget install Microsoft.EdgeWebView2Runtime

# Backend reachable from this exact machine
curl.exe -sS https://360booking.ro/api/pos/health
# expect: {"status":"ok","pos_api_version":"1.2.0",...}

# APPDATA writable (Tauri stores SQLite DB + logs there)
$dst = "$env:APPDATA\360booking-pos"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
"$(Get-Date) preflight write check" | Out-File "$dst\preflight.txt" -Encoding ascii
Get-Content "$dst\preflight.txt"            # expect: the line we just wrote
Remove-Item "$dst\preflight.txt"

# SQLite create probe (Tauri's plugin will do this for real on launch;
# this just proves the directory + filesystem permissions work)
sqlite3 "$dst\preflight.db" "CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1); SELECT count(*) FROM t;"
# expect: 1
Remove-Item "$dst\preflight.db"

# COM ports listing (only if a fiscal/payment terminal is meant to be tested here)
Get-WmiObject Win32_SerialPort | Select-Object Name,DeviceID,Description
# expect: zero or more entries depending on hardware
```

If any line above fails, **stop here** and report. The Tauri shell will not behave any better than the prerequisites underneath it.

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

## 12. Tauri config sanity (do this once before MSI build)

Audited 2026-04-26 in `src-tauri/tauri.conf.json` and `src-tauri/capabilities/default.json`:

| Item | State | Notes |
|---|---|---|
| `identifier` | ✅ `com.x360booking.pos` | stable, MSI/NSIS will reuse it |
| `productName` / `version` | ✅ `360booking POS` / `0.1.0` | bump version on every public MSI |
| `bundle.targets` | ✅ `["msi", "nsis"]` | both Win installers; pick one for distribution |
| `app.security.csp` | ✅ default-src 'self' + connect-src https://* | tight |
| `capabilities/default.json` | ✅ `core:default`, `log:default`, `shell:allow-open`, `sql:*` for `sqlite:pos-desktop.db` | no serialport / no fiscal-bridge sidecar permissions yet — correct for Sprint 9.5 (no real hardware) |
| Sidecar Datecs | ✅ NOT auto-launched | `fiscal_bridge_status` command only checks file presence; never spawns |
| Adapter wiring | ✅ all branches resolve to simulator in `src/adapters/index.ts` | demo build cannot start a real Datecs / BT POS / ESC/POS device — every `case 'datecs' / 'bt-ecr' / 'escpos'` falls through to the simulator class |
| Default `simulatorMode` | ✅ `true` for `POS_BUILD_PROFILE=demo` (the `tauri:build:demo` script) | flipped to `false` only when `POS_BUILD_PROFILE=tenant` is set explicitly |
| **Icons** | ✅ placeholder set in `src-tauri/icons/` | `32x32.png`, `128x128.png`, `icon.ico` plus the full Windows-Store square set generated 2026-04-26. Marked **TEMPORARY** in `src-tauri/icons/README.md` — replace with real brand artwork before Sprint 10 public release. |

Action items before MSI distribution:
- [ ] Replace placeholder icons (see `src-tauri/icons/README.md`) with the final brand artwork.
- [ ] Bump `productVersion` on every public installer.
- [ ] Verify the publisher field matches the signing certificate (for code-signed releases — Sprint 11+).

## 12.5 Sprint 9.6 — pre-Windows-test readiness

Verified on Linux on 2026-04-26 (build artefacts only — Tauri shell itself
still has to be exercised on Windows in section 11):

| Check | Command | Expected | Last result |
|---|---|---|---|
| TypeScript compile | `cd /opt/360booking/pos-desktop && npx tsc --noEmit` | exit 0, no diagnostics | ✅ exit 0 |
| Vite production build | `cd /opt/360booking/pos-desktop && npx vite build` | `dist/` written, no errors | ✅ 1841 modules, ~2 s |
| Vitest suite | `cd /opt/360booking/pos-desktop && npx vitest run` | all green | ✅ 130/130 in 17 files |
| Icons present | `ls src-tauri/icons/{32x32.png,128x128.png,icon.ico}` | three files exist | ✅ placeholder set |

What is **not** verified on Linux and must be re-checked on Windows:
- `pnpm tauri dev` opening the WebView2 shell.
- `pnpm tauri build` producing a working MSI / NSIS under `src-tauri/target/release/bundle/`.
- SQLite plugin migrations against `%APPDATA%\360booking-pos\pos-desktop.db`.
- `fiscal_bridge_status` Tauri command.

## 12.4 Sprint 10 — login flow + tenant MSI

This is now the **primary** path for a pilot install. The Sprint 9.6
demo MSI is kept around for UI walkthroughs but it does NOT reach the
real backend, so any pilot test against `https://360booking.ro` must use
the tenant MSI from the workflow below.

### Run the tenant workflow

1. github.com → repo → **Actions** → **`pos-desktop-windows-tenant`**.
2. **Run workflow** → branch `main` → leave inputs default
   (`backend_url=https://360booking.ro`, `release_marker=` empty unless
   you want to label this MSI for a specific pilot day).
3. Wait ~10–15 min cold cache, ~5 min warm.
4. Open the run → **Artifacts** → download
   **`360booking-pos-windows-tenant`** (zip).
5. Unzip → `msi/*.msi` and `nsis/*.exe` are the installers.

The workflow runs the same gate as the demo build (tsc → vitest →
vite build → tauri build) plus an explicit guard that fails the build
if any forbidden env var is present (slug / restaurant id / device
token / JWT / refresh token).

### First-launch checklist (Sprint 10 login flow)

- [ ] Installer runs without prerequisites errors. SmartScreen warning
  is expected — click **More info** → **Run anyway**.
- [ ] App opens on **LoginScreen** (dark gradient, branding pane on
  desktop layouts, login form on the right).
- [ ] Backend pill in the lower-left of the branding pane is green
  (`online · <ms>ms`) within 3 seconds. Red here = network / TLS
  problem. Stop and capture before continuing.
- [ ] Login with an account that has role `super_admin`,
  `tenant_admin`, `manager`, `waiter`, or `cashier` on a tenant that
  owns at least one restaurant.
- [ ] After Login button: spinner → POS shell renders. Restaurant
  picker is auto-skipped when the user has exactly one restaurant
  (the data model today never gives more).
- [ ] StatusBar Bootstrap pill goes green with detail `now` within 5
  seconds. Tables pane shows the **real** tables. Menu pane shows the
  **real** products / categories.
- [ ] StatusBar right side shows `<your name> · <restaurant name>` pill
  with a Logout dropdown.
- [ ] Diagnostics → Copy snapshot. Verify the snapshot contains
  `authStatus="authenticated"`, `accessTokenStatus="present"`, and
  `accessTokenSecondsToExpiry` near 900. Confirm there is NO raw token
  string in the snapshot — only `present`/`expired`/`missing`.

### Login error matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| Backend pill stays red | TLS / firewall / DNS | `curl https://360booking.ro/api/pos/health` from PowerShell |
| 401 "Email sau parolă greșite" | typo / wrong env account | reset password via web admin |
| 403 "Rolul nu are acces la POS desktop" | role `cook` or `customer` | give the user role `waiter`+ |
| 429 "Prea multe încercări" | 5+ failed logins in 15 min | wait 15 min OR change source IP |
| Login OK but POS shell stays empty | bootstrap failed silently | open Diagnostics, check `bootstrap` field; verify the user's tenant has a `restaurants` row |
| StatusBar Bootstrap stays grey/red | restaurant has no products / tables | seed at least one of each in admin |

### Logout + switch user

StatusBar right pill → dropdown → **Logout**. The app:

1. Calls `/api/pos/auth/logout` to revoke the refresh token server-side.
2. Stops the local sync engine (`stopSyncEngine`).
3. Wipes in-memory tokens + the persisted `auth.refresh` row in
   pos-desktop.db.
4. Returns to LoginScreen.

The next user can log in immediately on the same machine; the
`device-id` row stays so backend telemetry still recognises this
installation across logouts.

### Known Sprint 10 gaps (logged for Sprint 11)

- Refresh token in `pos-desktop.db.settings` is **not encrypted yet**.
  The row carries a `_do_not_share` warning string. OS keychain /
  stronghold integration is the Sprint 11 ticket.
- No 2FA on POS desktop login (web admin has it). Pilot users with 2FA
  enabled must temporarily disable it for POS desktop or wait for
  Sprint 11.
- No "Switch restaurant" UI — relogin to switch (a single-tenant
  install never needs it today).
- MSI is unsigned; SmartScreen warning persists.

## 12.55 Build the demo MSI in CI instead of locally

If the tester does not have Rust + MSVC + WebView2 installed, the CI workflow
at `.github/workflows/pos-desktop-windows.yml` produces the same demo MSI on a
GitHub-hosted `windows-latest` runner. Use this for the *first* test pass —
fall back to a local `pnpm tauri build` only when iterating on adapter code.

How to start it:

1. github.com → repo → **Actions** tab → **`pos-desktop-windows-demo`**.
2. **Run workflow** → branch → **Run workflow**.
3. ~10–15 min cold, ~5 min warm.
4. Run page → **Artifacts** → download **`360booking-pos-windows-demo`** (zip).
5. Unzip → `msi/*.msi` and `nsis/*.exe` are inside.

What the workflow runs (per `.github/workflows/pos-desktop-windows.yml`):

```
npm ci  (or pnpm install --frozen-lockfile)
npx tsc --noEmit
npx vitest run
npx vite build
npx @tauri-apps/cli build      # POS_BUILD_PROFILE=demo
                               # VITE_SYNC_TRANSPORT_MODE=memory
                               # VITE_BACKEND_URL=https://360booking.ro
```

CI build hard limits (do not relax without a separate ticket):

- Demo profile only — adapter registry resolves every `case` to the simulator.
- No GitHub Secrets consumed → no tokens / device JWTs / ANAF creds in the bundle.
- Artifact retention: 14 days.
- Artifact is **not** auto-promoted to a GitHub Release — distribution waits for the Sprint 11 signing pipeline.

Treat any MSI from this workflow as **pilot test only**.

## 12.6 Windows handoff — what the tester runs and reports

> Goal of this section: a tester who has never touched the repo can copy-paste,
> run, and report results without pinging the dev team.

### Ce rulez pe Windows (in order)

1. **Preflight** — section 0.5 above, top to bottom in PowerShell. Stop at the first failing line and jump to "Ce copiez dacă apare eroare".
2. **Clone + install** — section 1.
3. **Configure `.env`** — section 2 (use the tenant slug + restaurant UUID handed over for the pilot).
4. **Dev shell** — `pnpm tauri dev` (section 3). Window must open within ~30 s.
5. **DB migrations** — section 4. Confirm migration version `5`.
6. **Bootstrap hydration** — section 5.
7. **Sync round-trip** — section 6.
8. **Recovery tray (simulator)** — section 7.
9. **Foreign-device claim** — section 8 (only if a second machine is available; otherwise skip and note it).
10. **Kitchen queue** — section 9.
11. **Heartbeat lock** — section 10.
12. **Production build** — section 11. **This is the first time `pnpm tauri build` is exercised end-to-end**, so it is the most likely failure point.

### Ce copiez dacă apare eroare

For any failure, fill in the **section 13** "Failure capture template" and attach:

- Full PowerShell scrollback of the failing command.
- `%APPDATA%\360booking-pos\pos-desktop.db` snapshot if the failure is data-shaped (`sqlite3 ... .dump`).
- DiagnosticsModal snapshot (if the shell opened at all).
- Screenshot of the StatusBar.

Special cases:

- **`pnpm tauri build` icon error** — should not happen anymore (placeholder set is in `src-tauri/icons/`), but if it does, paste the full Tauri build log; do not hand-edit `tauri.conf.json`.
- **WebView2 missing** — `winget install Microsoft.EdgeWebView2Runtime`, then re-run preflight.
- **Rust toolchain missing** — `rustup-init.exe` from rustup.rs, then `rustup default stable-x86_64-pc-windows-msvc`.

### Ce rezultate aștept

Per section, a green checkbox is the success signal. The hard gates for a "pilot ready" call:

- Sections 3–6 all green → backend wiring is healthy.
- Section 11 green → MSI installer actually builds and runs from Start Menu.
- Sections 7, 9, 10 green → simulator + sync workers behave on the real OS.

A "yellow" pilot (most things work, one of 7/9/10 flaky) is acceptable for a one-store soak as long as it is reported.

### Când opresc testul

Stop and report immediately if **any** of these happen:

- Tauri shell crashes / Rust panic on launch.
- SQLite migration error or `_sqlx_migrations` does not reach version 5.
- `pnpm tauri build` fails (after the icon fix). The MSI is the deliverable.
- Backend `Bootstrap` cell stays red for > 30 s (likely network / TLS / token issue).
- Any operation accidentally engages real hardware (printer / fiscal / card terminal). The demo profile should make this impossible — if it happens, file a P0.

Otherwise, run the full checklist top to bottom and only then close out.

### Ce NU testez încă

Out of scope for this Windows pilot run — do **not** wire these even if the device is plugged in:

- **Real Datecs fiscal printer.** Section 7 must use the simulator only. Real fiscal flow requires the ANAF/technician activation step tracked separately, plus the v0.3.4 fiscal-bridge `.exe` update on Ovidiu's PC.
- **Real BT POS card terminal.** The adapter is still a Sprint 9 skeleton; `Retry` in the recovery tray is correctly disabled.
- **Real ESC/POS kitchen printer.** Simulator only.
- **ANAF e-Factura live submit.** Sprint 1 of e-Factura is per-tenant inbox only; live submit is later.
- **Code-signed / notarised installer.** Sprint 11+. The MSI from section 11 will trigger Windows SmartScreen warnings — that is expected.

## 13. Failure capture template

When something doesn't work, paste this template into the support ticket / Slack thread filled in:

```
=== 360booking POS desktop — failure report ===
Windows version:       (Win+R → winver, paste the build line)
Machine name:          (hostname)
App version:           (from DiagnosticsModal → snapshot.appVersion)
Build profile:         (snapshot.buildProfile)
Sync transport mode:   (snapshot.syncTransportMode)
Backend URL:           (snapshot.backendUrl)
Device ID:             (snapshot.deviceId)
SQLite DB path:        %APPDATA%\360booking-pos\pos-desktop.db
SQLite migration ver:  (sqlite3 ... "SELECT version FROM _sqlx_migrations ORDER BY version DESC LIMIT 1")

What I was doing (one sentence):

Expected:

Actual:

Reproduction steps:
  1.
  2.
  3.

DiagnosticsModal → Copy snapshot output (paste below):
---8<---
(paste here)
--->8---

Tauri console output (last 100 lines):
---8<---
(paste here)
--->8---

Backend logs around the time of failure:
   docker compose logs backend --since 5m | grep <relevant-route>
---8<---
(paste here)
--->8---

Screenshot:
   (attach: full window + StatusBar visible)

SQLite dump (≤1 MB):
   sqlite3 "$env:APPDATA\360booking-pos\pos-desktop.db" .dump > C:\Temp\pos-dump.sql
   (attach pos-dump.sql)
=== end ===
```

Send the filled-in template back so the dev team can patch before the pilot opens to live customers.
