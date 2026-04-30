# Sidecars

Auxiliary binaries bundled into the MSI alongside the main app.

## fiscal-bridge

The Datecs fiscal-bridge service is downloaded by the Windows build
workflow (`pos-desktop-windows.yml` / `pos-desktop-windows-tenant.yml`)
from the [`360booking/fiscal-bridge`](https://github.com/360booking/fiscal-bridge)
release pinned in the workflow and dropped here as `fiscal-bridge.exe`
before `tauri build` runs.

The Rust runtime spawns it on app start and stops it on exit
(`src-tauri/src/lib.rs::spawn_fiscal_bridge`). It still has its own
`single_instance` lock, so a service-installed copy on the same machine
keeps priority and the sidecar exits cleanly.

Local dev builds without a bridge binary just log
`fiscal-bridge sidecar not present in resource dir` and continue —
fiscal commands fail with the bridge offline, everything else works.

This directory is intentionally empty in source control.
