// Fiscal module — Datecs DP-25/FP-55 + simulator. Replaces the standalone
// fiscal-bridge Python service. See pos-desktop/docs/fiscal-port-audit.md
// for the audit + Sprint 1 scope.
//
// Sprint 1 ships: trait + DTOs + simulator + Datecs DP-25 + transport + probe
// + Tauri commands. WSS / enrollment integration with the backend lands in
// Sprint 1.b (see fiscal-port-status.md).

pub mod bridge_client;
pub mod commands;
pub mod config;
pub mod diagnostics;
pub mod dto;
pub mod error;
pub mod mapping;
pub mod persist;
pub mod provider;
pub mod providers;
pub mod transport;
