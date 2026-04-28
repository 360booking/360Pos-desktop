// Persisted bridge claim — read/write of `fiscal_bridge_credentials`
// (migration 0008). The claim handshake gives us a long-lived
// `device_token` + `websocket_url`; we save the bundle so the next app
// launch can re-attach the WSS loop without forcing the operator to
// generate a fresh enrollment code.
//
// All sites use rusqlite NO_CREATE + busy_timeout, mirroring
// `runtime_config::open_existing` so we never race with the sqlx pool
// the rest of the engine uses.

use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::fiscal::error::FiscalError;

fn other(detail: impl Into<String>) -> FiscalError {
    FiscalError::Other { detail: detail.into() }
}

fn open_existing(path: &Path) -> Result<Connection, FiscalError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags)
        .map_err(|e| other(format!("sqlite open (no-create) {}: {e}", path.display())))?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
    Ok(conn)
}

fn open_or_create(path: &Path) -> Result<Connection, FiscalError> {
    let conn = Connection::open(path)
        .map_err(|e| other(format!("sqlite open {}: {e}", path.display())))?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
    Ok(conn)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeCredentials {
    pub server_base_url: String,
    pub websocket_url: String,
    pub device_token: String,
    pub bridge_id: String,
    pub tenant_id: String,
    pub printer_model: Option<String>,
    pub device_id: Option<String>,
    pub claimed_at: Option<String>,
    pub updated_at: Option<String>,
}

pub fn read(path: &Path) -> Result<Option<BridgeCredentials>, FiscalError> {
    if !path.exists() {
        return Ok(None);
    }
    let conn = open_existing(path)?;
    // Tolerate missing migration (race with first launch).
    let table_present: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='fiscal_bridge_credentials'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if table_present == 0 {
        return Ok(None);
    }
    let row = conn
        .query_row(
            r#"SELECT server_base_url, websocket_url, device_token, bridge_id,
                       tenant_id, printer_model, device_id, claimed_at, updated_at
                  FROM fiscal_bridge_credentials WHERE id = 1"#,
            [],
            |r| {
                Ok(BridgeCredentials {
                    server_base_url: r.get(0)?,
                    websocket_url: r.get(1)?,
                    device_token: r.get(2)?,
                    bridge_id: r.get(3)?,
                    tenant_id: r.get(4)?,
                    printer_model: r.get(5)?,
                    device_id: r.get(6)?,
                    claimed_at: r.get(7)?,
                    updated_at: r.get(8)?,
                })
            },
        )
        .optional()
        .map_err(|e| other(format!("SELECT fiscal_bridge_credentials: {e}")))?;
    Ok(row)
}

pub fn write(path: &Path, c: &BridgeCredentials) -> Result<(), FiscalError> {
    let conn = open_or_create(path)?;
    conn.execute(
        r#"INSERT INTO fiscal_bridge_credentials (
              id, server_base_url, websocket_url, device_token, bridge_id,
              tenant_id, printer_model, device_id, claimed_at, updated_at
           ) VALUES (
              1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), datetime('now')
           )
           ON CONFLICT(id) DO UPDATE SET
              server_base_url = excluded.server_base_url,
              websocket_url   = excluded.websocket_url,
              device_token    = excluded.device_token,
              bridge_id       = excluded.bridge_id,
              tenant_id       = excluded.tenant_id,
              printer_model   = excluded.printer_model,
              device_id       = excluded.device_id,
              updated_at      = datetime('now')"#,
        params![
            c.server_base_url,
            c.websocket_url,
            c.device_token,
            c.bridge_id,
            c.tenant_id,
            c.printer_model,
            c.device_id,
        ],
    )
    .map_err(|e| other(format!("UPSERT fiscal_bridge_credentials: {e}")))?;
    Ok(())
}

pub fn clear(path: &Path) -> Result<(), FiscalError> {
    if !path.exists() {
        return Ok(());
    }
    let conn = open_existing(path)?;
    conn.execute("DELETE FROM fiscal_bridge_credentials", [])
        .map_err(|e| other(format!("DELETE fiscal_bridge_credentials: {e}")))?;
    Ok(())
}
