// Sprint 11 / C12: pull resolved fiscal protocol config from the backend.
//
// The backend already merges per-model defaults with per-tenant overrides
// (`backend/src/api/fiscal_bridge.py::resolve_protocol_config`). The Python
// bridge consumed this through a WSS `{"type": "config"}` message at hello
// time. Per audit Q9 the Rust port pulls it instead, at startup + on manual
// refresh — no hot-reload, no live override.
//
// This module provides three pieces:
//   - `pull_config(server_base_url, device_token)` — async GET against
//     `/api/fiscal-bridge/config?token=...`, returns the parsed JSON.
//   - Disk cache at `<app_data_dir>/fiscal-config.json` so the next cold
//     start can boot with the last-known config even if the backend is
//     unreachable.
//   - In-memory cache (OnceLock) for the current session.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::fiscal::error::FiscalError;

const CACHE_FILE: &str = "fiscal-config.json";

fn other(detail: impl Into<String>) -> FiscalError {
    FiscalError::Other { detail: detail.into() }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FiscalConfig {
    pub bridge_id: String,
    pub tenant_id: String,
    pub printer_model: Option<String>,
    pub protocol: Value,
}

static IN_MEMORY: OnceLock<Mutex<Option<FiscalConfig>>> = OnceLock::new();

fn cache_slot() -> &'static Mutex<Option<FiscalConfig>> {
    IN_MEMORY.get_or_init(|| Mutex::new(None))
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, FiscalError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| other(format!("app_data_dir: {e}")))?;
    Ok(dir.join(CACHE_FILE))
}

pub fn put_in_memory(cfg: FiscalConfig) {
    if let Ok(mut slot) = cache_slot().lock() {
        *slot = Some(cfg);
    }
}

pub fn get_in_memory() -> Option<FiscalConfig> {
    cache_slot().lock().ok().and_then(|s| s.clone())
}

pub fn write_disk_cache(app: &AppHandle, cfg: &FiscalConfig) -> Result<(), FiscalError> {
    let path = cache_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| other(format!("mkdir {}: {e}", parent.display())))?;
    }
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| other(format!("serialize fiscal-config: {e}")))?;
    std::fs::write(&path, json)
        .map_err(|e| other(format!("write {}: {e}", path.display())))?;
    Ok(())
}

pub fn read_disk_cache(app: &AppHandle) -> Result<Option<FiscalConfig>, FiscalError> {
    let path = cache_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| other(format!("read {}: {e}", path.display())))?;
    let cfg: FiscalConfig = serde_json::from_slice(&bytes)
        .map_err(|e| other(format!("parse {}: {e}", path.display())))?;
    Ok(Some(cfg))
}

pub async fn pull_config(
    server_base_url: &str,
    device_token: &str,
) -> Result<FiscalConfig, FiscalError> {
    let base = server_base_url.trim_end_matches('/');
    let url = format!(
        "{base}/api/fiscal-bridge/config?token={token}",
        token = url_encode(device_token),
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| FiscalError::CommunicationError { detail: format!("client: {e}") })?;
    let resp = client.get(&url).send().await.map_err(|e| {
        FiscalError::CommunicationError { detail: format!("GET {url}: {e}") }
    })?;
    let status = resp.status();
    if !status.is_success() {
        if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(FiscalError::ConfigurationError {
                detail: format!("backend rejected device_token (HTTP {status})"),
            });
        }
        return Err(FiscalError::CommunicationError {
            detail: format!("HTTP {status}"),
        });
    }
    let cfg: FiscalConfig = resp.json().await.map_err(|e| {
        FiscalError::CommunicationError { detail: format!("parse JSON: {e}") }
    })?;
    Ok(cfg)
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}
