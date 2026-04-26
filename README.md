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
```

Output: `src-tauri/target/release/bundle/{msi,nsis}/`. The demo profile is the default; the `tenant` profile (private adapters) is documented in `docs/github-public-release.md` and is only buildable from a private fork.

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
npx vitest run                  # 96 tests
npx vitest run --coverage       # plus coverage report
npx tsc --noEmit                # type-check
```

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
