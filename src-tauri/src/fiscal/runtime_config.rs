// Runtime config — single-row store for the fiscal hardware settings the
// operator picks from Settings → Casă de marcat. Replaces FISCAL_* env vars
// as the canonical source. Env vars stay readable as a fallback so a dev
// who launches `cargo tauri dev` from a shell with env vars set still works
// without a UI round-trip.
//
// Lookup order for any value: DB row > matching FISCAL_* env var > default.
// `effective_*` helpers encapsulate that priority so callers (`commands.rs`,
// `providers::build`) never reach for `std::env::var` directly anymore.

use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::fiscal::error::FiscalError;
use crate::fiscal::providers::datecs_dp25::{CmdCodes, DatecsConfig};

fn other(detail: impl Into<String>) -> FiscalError {
    FiscalError::Other { detail: detail.into() }
}

/// Open the SQLite store WITHOUT creating it. Critical: at app cold start
/// `fiscal_use_rust_enabled` runs from a React effect that fires before
/// `initDb()` (the tauri-plugin-sql connection that owns the migrations
/// pipeline). If we used the default `Connection::open` here, rusqlite would
/// create an empty DB file ahead of sqlx, which then fails to apply
/// migrations on the pre-existing handle and the whole sync engine never
/// starts. Read path must be NO_CREATE; write path opens normally because
/// it only runs from the Settings UI long after migrations have completed.
fn open_existing(path: &Path) -> Result<Connection, FiscalError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags)
        .map_err(|e| other(format!("sqlite open (no-create) {}: {e}", path.display())))?;
    apply_pragmas(&conn);
    Ok(conn)
}

/// Mirrors what `lib/db.ts::initDb` sets on the sqlx pool: a 5s busy
/// timeout so concurrent writers (sqlx pool from sync engine vs. our
/// rusqlite handle from Settings UI) wait for each other instead of
/// raising SQLITE_BUSY immediately. WAL is sticky once enabled by sqlx
/// so we only need to opt the rusqlite side into the same wait policy.
fn apply_pragmas(conn: &Connection) {
    let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
    let _ = conn.execute_batch("PRAGMA journal_mode = WAL;");
    let _ = conn.execute_batch("PRAGMA synchronous = NORMAL;");
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RuntimeConfig {
    pub provider: Option<String>,
    pub serial_port: Option<String>,
    pub baud: Option<i64>,
    pub protocol_variant: Option<String>,
    pub operator: Option<String>,
    pub operator_password: Option<String>,
    pub printer_model: Option<String>,
    pub use_rust: Option<bool>,
    pub enable_raw_logs: Option<bool>,
    pub vat_map_json: Option<String>,
    pub cmd_codes_json: Option<String>,
    pub updated_at: Option<String>,
}

fn open(path: &Path) -> Result<Connection, FiscalError> {
    let conn = Connection::open(path)
        .map_err(|e| other(format!("sqlite open {}: {e}", path.display())))?;
    apply_pragmas(&conn);
    Ok(conn)
}

pub fn read(path: &Path) -> Result<RuntimeConfig, FiscalError> {
    // Cold-start safety: if the DB file does not exist yet (first launch,
    // before tauri-plugin-sql has had a chance to connect and run
    // migrations), return defaults instead of creating an empty file that
    // would later confuse sqlx's migration runner.
    if !path.exists() {
        return Ok(RuntimeConfig::default());
    }
    let conn = open_existing(path)?;
    // Equally important: the table itself may not exist yet if this read
    // races migration 7. Tolerate that by returning defaults.
    let table_present: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='fiscal_runtime_config'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if table_present == 0 {
        return Ok(RuntimeConfig::default());
    }
    let row = conn
        .query_row(
            r#"SELECT provider, serial_port, baud, protocol_variant,
                       operator, operator_password, printer_model,
                       use_rust, enable_raw_logs,
                       vat_map_json, cmd_codes_json, updated_at
                  FROM fiscal_runtime_config WHERE id = 1"#,
            [],
            |r| {
                Ok(RuntimeConfig {
                    provider: r.get(0)?,
                    serial_port: r.get(1)?,
                    baud: r.get(2)?,
                    protocol_variant: r.get(3)?,
                    operator: r.get(4)?,
                    operator_password: r.get(5)?,
                    printer_model: r.get(6)?,
                    use_rust: r.get::<_, Option<i64>>(7)?.map(|v| v != 0),
                    enable_raw_logs: r.get::<_, Option<i64>>(8)?.map(|v| v != 0),
                    vat_map_json: r.get(9)?,
                    cmd_codes_json: r.get(10)?,
                    updated_at: r.get(11)?,
                })
            },
        )
        .optional()
        .map_err(|e| other(format!("SELECT fiscal_runtime_config: {e}")))?;
    Ok(row.unwrap_or_default())
}

pub fn write(path: &Path, cfg: &RuntimeConfig) -> Result<(), FiscalError> {
    let conn = open(path)?;
    conn.execute(
        r#"INSERT INTO fiscal_runtime_config (
              id, provider, serial_port, baud, protocol_variant,
              operator, operator_password, printer_model,
              use_rust, enable_raw_logs,
              vat_map_json, cmd_codes_json, updated_at
           ) VALUES (
              1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now')
           )
           ON CONFLICT(id) DO UPDATE SET
              provider          = excluded.provider,
              serial_port       = excluded.serial_port,
              baud              = excluded.baud,
              protocol_variant  = excluded.protocol_variant,
              operator          = excluded.operator,
              operator_password = excluded.operator_password,
              printer_model     = excluded.printer_model,
              use_rust          = excluded.use_rust,
              enable_raw_logs   = excluded.enable_raw_logs,
              vat_map_json      = excluded.vat_map_json,
              cmd_codes_json    = excluded.cmd_codes_json,
              updated_at        = datetime('now')"#,
        params![
            cfg.provider,
            cfg.serial_port,
            cfg.baud,
            cfg.protocol_variant,
            cfg.operator,
            cfg.operator_password,
            cfg.printer_model,
            cfg.use_rust.map(|v| if v { 1_i64 } else { 0 }),
            cfg.enable_raw_logs.map(|v| if v { 1_i64 } else { 0 }),
            cfg.vat_map_json,
            cfg.cmd_codes_json,
        ],
    )
    .map_err(|e| other(format!("UPSERT fiscal_runtime_config: {e}")))?;
    log::debug!(
        "runtime_config UPSERT: provider={:?} port={:?} baud={:?} variant={:?} use_rust={:?}",
        cfg.provider, cfg.serial_port, cfg.baud, cfg.protocol_variant, cfg.use_rust,
    );
    Ok(())
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

fn env_bool(key: &str) -> Option<bool> {
    std::env::var(key)
        .ok()
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE"))
}

/// DB > env > default ("simulator").
pub fn effective_provider(cfg: &RuntimeConfig) -> String {
    cfg.provider
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| env_opt("FISCAL_PROVIDER"))
        .unwrap_or_else(|| "simulator".into())
}

pub fn effective_use_rust(cfg: &RuntimeConfig) -> bool {
    cfg.use_rust.or_else(|| env_bool("FISCAL_USE_RUST")).unwrap_or(false)
}

pub fn effective_raw_logs(cfg: &RuntimeConfig) -> bool {
    cfg.enable_raw_logs
        .or_else(|| env_bool("FISCAL_ENABLE_RAW_LOGS"))
        .unwrap_or(false)
}

pub fn effective_serial_port(cfg: &RuntimeConfig) -> Option<String> {
    cfg.serial_port
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| env_opt("FISCAL_SERIAL_PORT"))
}

pub fn effective_baud(cfg: &RuntimeConfig) -> u32 {
    cfg.baud
        .map(|b| b as u32)
        .or_else(|| std::env::var("FISCAL_BAUD_RATE").ok().and_then(|s| s.parse().ok()))
        .unwrap_or(9600)
}

pub fn effective_protocol_variant(cfg: &RuntimeConfig) -> Option<String> {
    cfg.protocol_variant
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| env_opt("FISCAL_PROTOCOL_VARIANT"))
}

pub fn effective_operator(cfg: &RuntimeConfig) -> String {
    cfg.operator
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| env_opt("FISCAL_OPERATOR"))
        .unwrap_or_else(|| "1".into())
}

pub fn effective_operator_password(cfg: &RuntimeConfig) -> String {
    // Default depends on the device family per Datecs `PM_FMP350X_FMP55X_FP700X`
    // manual: DP-25 / DP-25X / DP-150X / WP-25X / WP-50X / WP-500X / DP-05C
    // ship with operator password = "0001" (4-digit, padded). FMP-350X /
    // FMP-55X / FP-700X ship with "0000". Operator confirms his DP-25 is
    // "0001". Falls back to the FP-700-family default when provider is
    // unknown so we don't break older installs.
    let provider_default = match cfg.provider.as_deref() {
        Some("datecs_dp25") => "0001",
        _ => "0000",
    };
    cfg.operator_password
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| env_opt("FISCAL_OPERATOR_PASSWORD"))
        .unwrap_or_else(|| provider_default.into())
}

pub fn effective_printer_model(cfg: &RuntimeConfig) -> Option<String> {
    cfg.printer_model
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| env_opt("FISCAL_PRINTER_MODEL"))
}

/// Build the `DatecsConfig` the DP-25 provider needs, blending DB > env.
/// Returns ConfigurationError if no serial port is set anywhere — the caller
/// (provider factory) surfaces that to the UI as „COM port lipsește".
pub fn effective_datecs_config(cfg: &RuntimeConfig) -> Result<DatecsConfig, FiscalError> {
    let port = effective_serial_port(cfg).ok_or_else(|| FiscalError::ConfigurationError {
        detail: "Port serial lipsește (Settings → Casă de marcat → Port serial)".into(),
    })?;
    let variant_fp700 = matches!(effective_protocol_variant(cfg).as_deref(), Some("fp700"));
    Ok(DatecsConfig {
        serial_port: port,
        baud: effective_baud(cfg),
        operator: effective_operator(cfg),
        operator_password: effective_operator_password(cfg),
        variant_fp700,
        cmd_codes: CmdCodes::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::NamedTempFile;

    fn fresh_db() -> NamedTempFile {
        let f = NamedTempFile::new().unwrap();
        let conn = Connection::open(f.path()).unwrap();
        conn.execute_batch(include_str!(
            "../../../src/sql/migrations/0007_fiscal_runtime_config.sql"
        ))
        .unwrap();
        f
    }

    // Env-vs-DB precedence is intentionally not tested here — tests share the
    // process env, so toggling FISCAL_* would race other tests in the same
    // binary. The DB-only path below is the one the UI exercises; env
    // fallback is a thin extra branch covered by inspection.

    #[test]
    fn read_returns_default_when_table_empty() {
        let f = fresh_db();
        let cfg = read(f.path()).unwrap();
        assert!(cfg.provider.is_none());
        assert!(cfg.serial_port.is_none());
        assert!(cfg.use_rust.is_none());
    }

    #[test]
    fn upsert_round_trip() {
        let f = fresh_db();
        let cfg = RuntimeConfig {
            provider: Some("datecs_dp25".into()),
            serial_port: Some("COM3".into()),
            baud: Some(19200),
            protocol_variant: Some("fp55".into()),
            operator: Some("1".into()),
            operator_password: Some("0001".into()),
            printer_model: Some("Datecs DP-25".into()),
            use_rust: Some(true),
            enable_raw_logs: Some(false),
            ..Default::default()
        };
        write(f.path(), &cfg).unwrap();
        let back = read(f.path()).unwrap();
        assert_eq!(back.provider.as_deref(), Some("datecs_dp25"));
        assert_eq!(back.serial_port.as_deref(), Some("COM3"));
        assert_eq!(back.baud, Some(19200));
        assert_eq!(back.use_rust, Some(true));
        assert_eq!(back.enable_raw_logs, Some(false));
        assert_eq!(back.operator_password.as_deref(), Some("0001"));
    }

    #[test]
    fn write_then_overwrite_preserves_id_one() {
        let f = fresh_db();
        write(
            f.path(),
            &RuntimeConfig {
                provider: Some("simulator".into()),
                ..Default::default()
            },
        )
        .unwrap();
        write(
            f.path(),
            &RuntimeConfig {
                provider: Some("datecs_dp25".into()),
                serial_port: Some("COM7".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let back = read(f.path()).unwrap();
        assert_eq!(back.provider.as_deref(), Some("datecs_dp25"));
        assert_eq!(back.serial_port.as_deref(), Some("COM7"));
        // Sanity: still a single row.
        let conn = Connection::open(f.path()).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM fiscal_runtime_config", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn effective_provider_prefers_db_value() {
        let cfg = RuntimeConfig {
            provider: Some("datecs_dp25".into()),
            ..Default::default()
        };
        // Even if env is unset, DB wins.
        assert_eq!(effective_provider(&cfg), "datecs_dp25");
    }

    #[test]
    fn effective_baud_falls_back_to_default() {
        let cfg = RuntimeConfig::default();
        // 9600 is the doc-stated default per Datecs FP-55 manual.
        assert_eq!(effective_baud(&cfg), 9600);
    }

    #[test]
    fn effective_datecs_config_errors_when_port_missing() {
        let cfg = RuntimeConfig {
            provider: Some("datecs_dp25".into()),
            ..Default::default()
        };
        // env left untouched — if FISCAL_SERIAL_PORT happens to be set in CI
        // env we accept either outcome (the negative-path assertion is more
        // useful in dev shells). Skip when env supplies a value.
        if std::env::var("FISCAL_SERIAL_PORT").is_ok() {
            return;
        }
        let err = effective_datecs_config(&cfg).unwrap_err();
        match err {
            FiscalError::ConfigurationError { detail } => {
                assert!(detail.contains("Port serial"));
            }
            _ => panic!("expected ConfigurationError"),
        }
    }
}
