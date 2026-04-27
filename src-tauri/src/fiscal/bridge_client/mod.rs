// Fiscal bridge client — Rust port of fiscal-bridge/bridge/main.py::_claim_code
// + ws_client.py. The same WSS endpoint the Python agent uses today
// (`/api/fiscal-bridge/agent`) is consumed here. Backend stays unchanged.
//
// Sprint 1.b deliverables (this module):
//   * POST /api/fiscal-bridge/claim    → swap one-time code for device_token
//   * WSS /api/fiscal-bridge/agent     → hello / heartbeat / job / job_result
//   * reconnect with capped exponential backoff
//   * exit on close 4000 (replaced by another bridge — same rule as Python)
//   * apply server-pushed `{type:config}` overrides
//
// Where this differs from Python: a single binary (no separate service).
// Tray + Tk GUI + NSSM all gone — Tauri owns process lifecycle.

pub mod claim;
pub mod state;
pub mod ws;
