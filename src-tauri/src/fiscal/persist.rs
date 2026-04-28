// Append-only persistence for fiscal_attempts + payment_attempts + station_pairings.
// Mirrors the schema defined in `pos-desktop/src/sql/migrations/0006_fiscal_attempts.sql`.
//
// Both tables are keyed semantically by `mutation_id` (UNIQUE). UPSERT on conflict
// lets a single attempt transition pending → printed/failed/unknown without ever
// creating a duplicate row. Audit §5.5 (`fiscal-port-audit.md`) — fiscal and
// payment attempts MUST live in separate tables; never combined.
//
// Connection model: rusqlite opens the same SQLite file that tauri-plugin-sql
// manages (`<app_data_dir>/pos-desktop.db`). SQLite WAL mode (sticky once
// enabled) allows concurrent writers, so mixing this rusqlite path with the
// plugin's sqlx connection is safe as long as we keep writes inside short
// transactions.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::fiscal::dto::{ReceiptRequest, ReceiptResponse, ReceiptStatus};
use crate::fiscal::error::FiscalError;

fn other(detail: impl Into<String>) -> FiscalError {
    FiscalError::Other { detail: detail.into() }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FiscalAttemptRow {
    pub id: String,
    pub mutation_id: String,
    pub order_local_id: String,
    pub device_id: String,
    pub fiscal_device_id: Option<String>,
    pub provider: String,
    pub printer_model: Option<String>,
    pub serial_port: Option<String>,
    pub baud: Option<i64>,
    pub protocol_variant: Option<String>,
    /// 'pending' | 'printed' | 'failed' | 'unknown' | 'confirmed_failed'
    pub status: String,
    pub fiscal_number: Option<String>,
    pub fiscal_date: Option<String>,
    pub raw_request: Option<String>,
    pub raw_response: Option<String>,
    pub parsed_response: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub status_bytes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentAttemptRow {
    pub id: String,
    pub mutation_id: String,
    pub order_local_id: String,
    pub device_id: String,
    pub payment_terminal_id: Option<String>,
    pub provider: String,
    pub amount_cents: i64,
    pub currency: String,
    /// 'pending' | 'approved' | 'declined' | 'cancelled' | 'unknown'
    pub status: String,
    pub stan: Option<String>,
    pub rrn: Option<String>,
    pub authorization_code: Option<String>,
    pub terminal_id: Option<String>,
    pub merchant_id: Option<String>,
    pub card_scheme: Option<String>,
    pub last4: Option<String>,
    pub response_code: Option<String>,
    pub response_text: Option<String>,
    pub raw_request: Option<String>,
    pub raw_response: Option<String>,
}

pub fn db_path(app: &AppHandle) -> Result<PathBuf, FiscalError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| other(format!("app_data_dir: {e}")))?;
    Ok(dir.join("pos-desktop.db"))
}

fn open(path: &Path) -> Result<Connection, FiscalError> {
    let conn = Connection::open(path)
        .map_err(|e| other(format!("sqlite open {}: {e}", path.display())))?;
    // 5s busy timeout matches what `lib/db.ts::initDb` sets on the sqlx
    // pool. Without it, any concurrent write from the sync engine would
    // surface here as `database is locked` instead of waiting briefly.
    let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
    // WAL is sticky once set by the plugin; this is a no-op if already enabled
    // but keeps the rusqlite path safe if it is the first writer.
    let _: String = conn
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap_or_else(|_| "wal".into());
    Ok(conn)
}

pub fn record_fiscal_attempt(path: &Path, row: &FiscalAttemptRow) -> Result<(), FiscalError> {
    let conn = open(path)?;
    conn.execute(
        r#"
        INSERT INTO fiscal_attempts (
            id, mutation_id, order_local_id, device_id, fiscal_device_id,
            provider, printer_model, serial_port, baud, protocol_variant,
            status, fiscal_number, fiscal_date,
            raw_request, raw_response, parsed_response,
            error_code, error_message, status_bytes,
            created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13,
            ?14, ?15, ?16,
            ?17, ?18, ?19,
            datetime('now'), datetime('now')
        )
        ON CONFLICT(mutation_id) DO UPDATE SET
            status          = excluded.status,
            fiscal_number   = excluded.fiscal_number,
            fiscal_date     = excluded.fiscal_date,
            raw_request     = COALESCE(excluded.raw_request, fiscal_attempts.raw_request),
            raw_response    = COALESCE(excluded.raw_response, fiscal_attempts.raw_response),
            parsed_response = COALESCE(excluded.parsed_response, fiscal_attempts.parsed_response),
            error_code      = excluded.error_code,
            error_message   = excluded.error_message,
            status_bytes    = COALESCE(excluded.status_bytes, fiscal_attempts.status_bytes),
            updated_at      = datetime('now')
        "#,
        params![
            row.id,
            row.mutation_id,
            row.order_local_id,
            row.device_id,
            row.fiscal_device_id,
            row.provider,
            row.printer_model,
            row.serial_port,
            row.baud,
            row.protocol_variant,
            row.status,
            row.fiscal_number,
            row.fiscal_date,
            row.raw_request,
            row.raw_response,
            row.parsed_response,
            row.error_code,
            row.error_message,
            row.status_bytes,
        ],
    )
    .map_err(|e| other(format!("INSERT fiscal_attempts: {e}")))?;
    Ok(())
}

pub fn record_payment_attempt(path: &Path, row: &PaymentAttemptRow) -> Result<(), FiscalError> {
    let conn = open(path)?;
    conn.execute(
        r#"
        INSERT INTO payment_attempts (
            id, mutation_id, order_local_id, device_id, payment_terminal_id,
            provider, amount_cents, currency, status,
            stan, rrn, authorization_code, terminal_id, merchant_id,
            card_scheme, last4, response_code, response_text,
            raw_request, raw_response,
            created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, ?9,
            ?10, ?11, ?12, ?13, ?14,
            ?15, ?16, ?17, ?18,
            ?19, ?20,
            datetime('now'), datetime('now')
        )
        ON CONFLICT(mutation_id) DO UPDATE SET
            status              = excluded.status,
            stan                = COALESCE(excluded.stan, payment_attempts.stan),
            rrn                 = COALESCE(excluded.rrn, payment_attempts.rrn),
            authorization_code  = COALESCE(excluded.authorization_code, payment_attempts.authorization_code),
            terminal_id         = COALESCE(excluded.terminal_id, payment_attempts.terminal_id),
            merchant_id         = COALESCE(excluded.merchant_id, payment_attempts.merchant_id),
            card_scheme         = COALESCE(excluded.card_scheme, payment_attempts.card_scheme),
            last4               = COALESCE(excluded.last4, payment_attempts.last4),
            response_code       = excluded.response_code,
            response_text       = excluded.response_text,
            raw_request         = COALESCE(excluded.raw_request, payment_attempts.raw_request),
            raw_response        = COALESCE(excluded.raw_response, payment_attempts.raw_response),
            updated_at          = datetime('now')
        "#,
        params![
            row.id,
            row.mutation_id,
            row.order_local_id,
            row.device_id,
            row.payment_terminal_id,
            row.provider,
            row.amount_cents,
            row.currency,
            row.status,
            row.stan,
            row.rrn,
            row.authorization_code,
            row.terminal_id,
            row.merchant_id,
            row.card_scheme,
            row.last4,
            row.response_code,
            row.response_text,
            row.raw_request,
            row.raw_response,
        ],
    )
    .map_err(|e| other(format!("INSERT payment_attempts: {e}")))?;
    Ok(())
}

pub fn list_fiscal_attempts(
    path: &Path,
    order_local_id: &str,
) -> Result<Vec<FiscalAttemptRow>, FiscalError> {
    let conn = open(path)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, mutation_id, order_local_id, device_id, fiscal_device_id,
                   provider, printer_model, serial_port, baud, protocol_variant,
                   status, fiscal_number, fiscal_date,
                   raw_request, raw_response, parsed_response,
                   error_code, error_message, status_bytes
              FROM fiscal_attempts
             WHERE order_local_id = ?1
             ORDER BY created_at ASC
            "#,
        )
        .map_err(|e| other(format!("prepare list_fiscal_attempts: {e}")))?;
    let rows = stmt
        .query_map(params![order_local_id], |r| {
            Ok(FiscalAttemptRow {
                id: r.get(0)?,
                mutation_id: r.get(1)?,
                order_local_id: r.get(2)?,
                device_id: r.get(3)?,
                fiscal_device_id: r.get(4)?,
                provider: r.get(5)?,
                printer_model: r.get(6)?,
                serial_port: r.get(7)?,
                baud: r.get(8)?,
                protocol_variant: r.get(9)?,
                status: r.get(10)?,
                fiscal_number: r.get(11)?,
                fiscal_date: r.get(12)?,
                raw_request: r.get(13)?,
                raw_response: r.get(14)?,
                parsed_response: r.get(15)?,
                error_code: r.get(16)?,
                error_message: r.get(17)?,
                status_bytes: r.get(18)?,
            })
        })
        .map_err(|e| other(format!("query_map fiscal_attempts: {e}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| other(format!("collect fiscal_attempts: {e}")))?;
    Ok(rows)
}

pub fn list_payment_attempts(
    path: &Path,
    order_local_id: &str,
) -> Result<Vec<PaymentAttemptRow>, FiscalError> {
    let conn = open(path)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, mutation_id, order_local_id, device_id, payment_terminal_id,
                   provider, amount_cents, currency, status,
                   stan, rrn, authorization_code, terminal_id, merchant_id,
                   card_scheme, last4, response_code, response_text,
                   raw_request, raw_response
              FROM payment_attempts
             WHERE order_local_id = ?1
             ORDER BY created_at ASC
            "#,
        )
        .map_err(|e| other(format!("prepare list_payment_attempts: {e}")))?;
    let rows = stmt
        .query_map(params![order_local_id], |r| {
            Ok(PaymentAttemptRow {
                id: r.get(0)?,
                mutation_id: r.get(1)?,
                order_local_id: r.get(2)?,
                device_id: r.get(3)?,
                payment_terminal_id: r.get(4)?,
                provider: r.get(5)?,
                amount_cents: r.get(6)?,
                currency: r.get(7)?,
                status: r.get(8)?,
                stan: r.get(9)?,
                rrn: r.get(10)?,
                authorization_code: r.get(11)?,
                terminal_id: r.get(12)?,
                merchant_id: r.get(13)?,
                card_scheme: r.get(14)?,
                last4: r.get(15)?,
                response_code: r.get(16)?,
                response_text: r.get(17)?,
                raw_request: r.get(18)?,
                raw_response: r.get(19)?,
            })
        })
        .map_err(|e| other(format!("query_map payment_attempts: {e}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| other(format!("collect payment_attempts: {e}")))?;
    Ok(rows)
}

/// Read `station_pairings.fiscal_device_id` for the current device, if any.
/// Used by auto-recording to stamp `fiscal_device_id` without TS having to
/// ferry it through every receipt request.
pub fn read_paired_fiscal_device(
    path: &Path,
    device_id: &str,
) -> Result<Option<String>, FiscalError> {
    let conn = open(path)?;
    conn.query_row(
        "SELECT fiscal_device_id FROM station_pairings WHERE device_id = ?1 LIMIT 1",
        params![device_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|e| other(format!("read_paired_fiscal_device: {e}")))
    .map(|opt| opt.flatten())
}

/// Full snapshot of the station's 1:1:1 pairing — fiscal device + payment
/// terminal. Audit Q2 keeps the row keyed only by `device_id`; nullable FKs
/// let the UI persist a partial pairing (fiscal claimed, terminal not yet
/// enrolled or vice versa).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationPairingRow {
    pub device_id: String,
    pub fiscal_device_id: Option<String>,
    pub payment_terminal_id: Option<String>,
    pub fiscal_provider: Option<String>,
    pub payment_provider: Option<String>,
}

pub fn read_station_pairing(
    path: &Path,
    device_id: &str,
) -> Result<Option<StationPairingRow>, FiscalError> {
    let conn = open(path)?;
    conn.query_row(
        r#"SELECT device_id, fiscal_device_id, payment_terminal_id,
                  fiscal_provider, payment_provider
             FROM station_pairings WHERE device_id = ?1 LIMIT 1"#,
        params![device_id],
        |r| {
            Ok(StationPairingRow {
                device_id: r.get(0)?,
                fiscal_device_id: r.get(1)?,
                payment_terminal_id: r.get(2)?,
                fiscal_provider: r.get(3)?,
                payment_provider: r.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|e| other(format!("read_station_pairing: {e}")))
}

/// UPSERT a station pairing. Audit Q2 (Sprint 1) — exactly one row per
/// `device_id`; ON CONFLICT updates the fields the caller passed and leaves
/// the rest as-is so a partial pair (e.g. only fiscal, no terminal yet)
/// stays consistent across calls.
pub fn upsert_station_pairing(
    path: &Path,
    row: &StationPairingRow,
) -> Result<(), FiscalError> {
    let conn = open(path)?;
    conn.execute(
        r#"
        INSERT INTO station_pairings (
            device_id, fiscal_device_id, payment_terminal_id,
            fiscal_provider, payment_provider, paired_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))
        ON CONFLICT(device_id) DO UPDATE SET
            fiscal_device_id    = COALESCE(excluded.fiscal_device_id,    station_pairings.fiscal_device_id),
            payment_terminal_id = COALESCE(excluded.payment_terminal_id, station_pairings.payment_terminal_id),
            fiscal_provider     = COALESCE(excluded.fiscal_provider,     station_pairings.fiscal_provider),
            payment_provider    = COALESCE(excluded.payment_provider,    station_pairings.payment_provider),
            updated_at          = datetime('now')
        "#,
        params![
            row.device_id,
            row.fiscal_device_id,
            row.payment_terminal_id,
            row.fiscal_provider,
            row.payment_provider,
        ],
    )
    .map_err(|e| other(format!("upsert station_pairings: {e}")))?;
    Ok(())
}

/// Hard reset for a station pairing — used by the manual "unpair" UI button
/// when an admin needs to re-claim against a different fiscal device.
pub fn clear_station_pairing(path: &Path, device_id: &str) -> Result<(), FiscalError> {
    let conn = open(path)?;
    conn.execute(
        "DELETE FROM station_pairings WHERE device_id = ?1",
        params![device_id],
    )
    .map_err(|e| other(format!("delete station_pairings: {e}")))?;
    Ok(())
}

/// Build a `FiscalAttemptRow` from the receipt request + provider response.
/// Caller passes the device + provider context that `ReceiptRequest` does not
/// carry (we don't want to balloon the wire shape).
pub struct AttemptContext<'a> {
    pub device_id: &'a str,
    pub provider: &'a str,
    pub printer_model: Option<&'a str>,
    pub serial_port: Option<&'a str>,
    pub baud: Option<u32>,
    pub protocol_variant: Option<&'a str>,
    pub fiscal_device_id: Option<String>,
    pub raw_logging: bool,
}

pub fn attempt_row_from_response(
    req: &ReceiptRequest,
    res: &ReceiptResponse,
    ctx: &AttemptContext<'_>,
) -> FiscalAttemptRow {
    let status = match &res.status {
        ReceiptStatus::Printed => "printed",
        ReceiptStatus::Failed => "failed",
        ReceiptStatus::Unknown => "unknown",
    }
    .to_string();

    let parsed_response = serde_json::to_string(res).ok();
    let raw_response = if ctx.raw_logging {
        Some(res.raw_trace.clone())
    } else {
        None
    };
    let raw_request = if ctx.raw_logging {
        serde_json::to_string(req).ok()
    } else {
        None
    };

    FiscalAttemptRow {
        id: req.fiscal_attempt_id.clone(),
        mutation_id: req.mutation_id.clone(),
        order_local_id: req.order_local_id.clone(),
        device_id: ctx.device_id.to_string(),
        fiscal_device_id: ctx.fiscal_device_id.clone(),
        provider: ctx.provider.to_string(),
        printer_model: ctx.printer_model.map(str::to_string),
        serial_port: ctx.serial_port.map(str::to_string),
        baud: ctx.baud.map(|b| b as i64),
        protocol_variant: ctx.protocol_variant.map(str::to_string),
        status,
        fiscal_number: res.fiscal_number.clone(),
        fiscal_date: res.fiscal_date.clone(),
        raw_request,
        raw_response,
        parsed_response,
        error_code: res.error_code.clone(),
        error_message: res.error_message.clone(),
        status_bytes: None,
    }
}
