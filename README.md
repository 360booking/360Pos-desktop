# 360booking POS — Windows Desktop (Sprint 0)

Premium Windows POS for the 360booking restaurant module. Tauri 2 + React 18 + TypeScript + SQLite. Offline-first; reuses the existing `fiscal-bridge` Datecs sidecar; integrates with the FastAPI backend over HTTP/WS.

> **Status:** Sprint 0 — scaffold + UI parity skeleton + simulator adapters. No live data yet. Do not deploy.

## Quick start (developer)

Prerequisites:
- **Node.js ≥ 18.18** + **pnpm 9** (or npm 10)
- **Rust toolchain** (`rustup default stable`)
- **Tauri prerequisites for your platform** — on Windows: WebView2 runtime (preinstalled on Win10 21H2+ / Win11) and Visual Studio Build Tools.
- For Linux dev (only the dev preview, no production target): `webkit2gtk-4.1`, `libsoup-3.0`, `libgtk-3-dev`, `librsvg2-dev`.

```bash
cd /opt/360booking/pos-desktop
pnpm install            # or: npm install
pnpm tauri:dev          # opens the Tauri window with HMR
```

Web preview without the Tauri shell (no SQLite, no sidecar, useful for UI work):

```bash
pnpm dev                # opens http://localhost:1420
```

## Build a Windows installer

```bash
pnpm tauri:build:demo   # MSI + NSIS, simulator adapters only
# equivalent: cross-env POS_BUILD_PROFILE=demo tauri build
```

Artefacts (after a successful Windows build):

- `src-tauri/target/release/bundle/msi/360booking POS_<version>_x64_en-US.msi`
- `src-tauri/target/release/bundle/nsis/360booking POS_<version>_x64-setup.exe`
- Unpacked binary: `src-tauri/target/release/360booking POS.exe`

The demo profile is the default — every adapter (`fiscal` / `payment` / `printer`) resolves to the simulator class in `src/adapters/index.ts`, so a demo MSI **cannot** drive a real Datecs printer, BT POS terminal, or ESC/POS kitchen printer even if the COM port is configured. The `tenant` profile (private adapters) is documented in `docs/github-public-release.md` and is only buildable from a private fork.

> **Icons are placeholders.** `src-tauri/icons/` ships a generic dark-blue
> "POS" wordmark so the build does not abort. Replace with the final brand
> artwork before any public release — see `src-tauri/icons/README.md`.

> **Windows-only build.** `pnpm tauri build` cannot produce an MSI / NSIS from
> Linux; it must run on Windows with the WebView2 runtime + MSVC build tools.
> See `docs/windows-pos-smoke-test.md` § 0.5 for the preflight and § 11–12 for
> the full Windows checklist.

### Build via GitHub Actions (no Windows machine needed)

There are TWO Windows workflows, both publishing the MSI as a downloadable
artifact (no GitHub Release):

| Workflow | Profile | Backend | Use case |
|---|---|---|---|
| `pos-desktop-windows.yml` | demo | none — in-memory shim | UI walk-through, training, mock data, no real login |
| `pos-desktop-windows-tenant.yml` | **tenant** | `https://360booking.ro` | Pilot testing — login with real 360booking creds, real tables, real menu |

How to start either:

1. Open the repo on github.com → **Actions** tab.
2. Pick the workflow on the left:
   - **`pos-desktop-windows-demo`** — also runs automatically on push.
   - **`pos-desktop-windows-tenant`** — manual only (`workflow_dispatch`).
3. Click **Run workflow** → choose the branch → **Run workflow**.
4. Wait for the green check (~10–15 min on a cold cache, ~5 min warm).
5. Open the run → scroll to **Artifacts** → download
   **`360booking-pos-windows-demo`** or **`360booking-pos-windows-tenant`**.
   The zip contains both `msi/*.msi` and `nsis/*.exe`.

**Hard limits of both CI builds** (by design):

- No GitHub Secrets are consumed.
- No tenant slug, restaurant id, device token, or JWT is baked into either
  build. The tenant build asks you to log in on first launch and learns
  everything from the login response.
- `simulatorMode=true` for hardware in both builds — neither MSI can drive
  a real Datecs / BT POS / ESC/POS device, even with COM ports configured.
- The MSI is for **pilot testing only** — never auto-published as a Release.
  Distribution of a real installer goes through the Sprint 11 signing flow.

### After installing the tenant MSI — first launch

1. Run the installer (right-click → "Run as administrator" if SmartScreen
   blocks; the binary is unsigned until Sprint 11).
2. Launch **360booking POS** from the Start Menu.
3. The first screen is **LoginScreen** — branded, dark theme, with a
   backend status pill. If the pill is red, the machine cannot reach
   `https://360booking.ro` and login will fail. Fix the network first.
4. Enter your 360booking email + password. Tick **"Ține-mă logat pe acest
   dispozitiv"** if this is a pilot machine you don't want to log in
   on every restart.
5. After login the app picks your restaurant automatically (1 user → 1
   tenant → 1 restaurant for now). If a future release supports multiple
   restaurants per tenant, a picker is shown instead.
6. The POS shell renders. The Bootstrap pill in the StatusBar should turn
   green within ~5 seconds and pull your real menu, categories, tables.

If the POS shows up empty (no tables, no products): open Diagnostics from
the StatusBar (gear icon), copy the snapshot, and check `bootstrap` /
`syncTransportMode` / `accessTokenStatus`. The snapshot never contains
your password or token values.

## Architecture

See `/opt/360booking/docs/`:
- `pos-desktop-architecture.md`
- `pos-ui-parity.md`
- `offline-sync-strategy.md`
- `fiscal-flow.md`
- `hardware-adapters.md`
- `github-public-release.md`

## What works in Sprint 3 (current)

- **HTTP sync transport** (`createHttpSyncTransport`) implements the same `SyncTransport` interface as the in-memory shim. The outbox worker is unchanged; swapping transports is a one-line config change.
- **Transport selection** via `AppConfig.syncTransportMode = 'memory' | 'http'`. Default `memory`. Inferred to `http` automatically when `POS_BUILD_PROFILE=tenant` and `VITE_BACKEND_URL` is set.
- **`/api/pos/health`** is the new probe used by the StatusBar (replaces `/api/health`).
- **`fetchBootstrap()`** client targets `/api/pos/bootstrap` and returns `{products, categories, tables, vatConfig, syncCursor, ...}`. Sprint 4 hydrates SQLite from this.
- **HTTP error mapping** is exhaustive: 200/results/missing/409/422/400/401/403/500/network/timeout — see `docs/pos-desktop-architecture.md § Sprint 3`.

### Switching memory ↔ http

```bash
# Demo / dev (default): in-memory shim, no backend required.
POS_BUILD_PROFILE=demo pnpm tauri:dev

# Live backend:
POS_BUILD_PROFILE=tenant VITE_BACKEND_URL=https://backend.example.com pnpm tauri:dev

# Force HTTP regardless of profile:
VITE_SYNC_TRANSPORT_MODE=http VITE_BACKEND_URL=http://localhost:8000 pnpm tauri:dev
```

## What works in Sprint 2 (previous)

- Local **event store** (SQLite) with append-only events + sync_outbox, written atomically.
- **Outbox worker** with exponential backoff (1s → 5s → 30s → 2m → 10m → 1h cap) and dead-letter at 50 attempts.
- **Per-order serialisation**: events for the same `order_local_id` go in a single batch; different orders push in parallel.
- **In-memory sync transport** (`createInMemorySyncTransport`) with modes `success / duplicate / conflict / offline / timeout / failed / fatal`. Sprint 3 will swap in the HTTP transport without changing the worker.
- **`runAction()`** dispatcher: UI calls `runAction(() => addItem(order, cmd, ctx))` → pure pos-core action runs → events persist → caller gets the new state. UI never bypasses persistence.
- **`useSyncStatus`** drives the StatusBar: queue depth (existing pill), `failed` and `dead` indicators (new), `tx:in-memory` transport badge (new).
- **Restart-replay** test demonstrates: persisted events survive a process restart, the *same* `mutation_id` is reused, transport reports `duplicate` on the second push, and the row is marked synced once.

## Quick test cycle

```bash
cd /opt/360booking/pos-desktop
npx vitest run                  # 130 tests (Sprint 9.6)
npx vitest run --coverage       # plus coverage report
npx tsc --noEmit                # type-check
npx vite build                  # client-side production bundle (no Tauri shell)
```

These four commands are the **Linux-side green-light** for a Windows build —
all four must pass before kicking off `pnpm tauri build` on a Windows box.
Last verified green: 2026-04-26 (130/130 vitest, tsc clean, vite build OK).

## What works in Sprint 0

- Three-pane POS shell visually mirrors the web POS (placeholder data).
- Top status bar polls backend health + adapter status.
- SQLite schema for all sync/transaction tables migrates on first launch.
- Simulator adapters (fiscal, payment, printer) cycle through success / failure / unknown outcomes.
- Tauri shell enforces single-instance and exposes `fiscal_bridge_status` + `app_data_dir` commands.

## What's stubbed / pending

- No live menu / orders / payments — all data is mock.
- No event store writes yet (Sprint 2).
- No backend `/api/pos/*` endpoints (Sprint 3).
- No real Datecs / ECR / ESC/POS adapters (Sprints 5–7).
- No installer signing (Sprint 10).

## Repository safety

- **Never commit `config.json`, `.env*` (except `.env.example`), or `private-adapters/`.**
- Real Datecs / vendor-licensed protocols ship from a private fork. Public builds simulate.
- See `docs/github-public-release.md` for the full secret hygiene checklist.

## License

Proposed: MIT for the desktop client. Final decision in Sprint 10.
