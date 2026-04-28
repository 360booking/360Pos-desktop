use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

mod fiscal;

const MIGRATION_V1_INIT: &str = include_str!("../../src/sql/migrations/0001_init.sql");
const MIGRATION_V2_EVENTS_ORDER_LINK: &str =
    include_str!("../../src/sql/migrations/0002_events_order_link.sql");
const MIGRATION_V3_REMOTE_READ_MODEL: &str =
    include_str!("../../src/sql/migrations/0003_remote_read_model.sql");
const MIGRATION_V4_REMOTE_ORDERS_OWNERSHIP: &str =
    include_str!("../../src/sql/migrations/0004_remote_orders_ownership.sql");
const MIGRATION_V5_CARD_RECOVERY: &str =
    include_str!("../../src/sql/migrations/0005_card_recovery.sql");
const MIGRATION_V6_FISCAL_ATTEMPTS: &str =
    include_str!("../../src/sql/migrations/0006_fiscal_attempts.sql");
const MIGRATION_V7_FISCAL_RUNTIME_CONFIG: &str =
    include_str!("../../src/sql/migrations/0007_fiscal_runtime_config.sql");

#[derive(Serialize)]
struct FiscalBridgeStatus {
    present: bool,
    path: Option<String>,
}

/// Reports whether the optional Datecs fiscal-bridge sidecar binary is
/// installed alongside the app. Sprint 0 only checks presence; actual
/// fiscalisation lands in Sprint 5.
#[tauri::command]
fn fiscal_bridge_status(app: tauri::AppHandle) -> Result<FiscalBridgeStatus, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?;

    let candidates: [PathBuf; 2] = [
        resource_dir.join("sidecars").join("fiscal-bridge.exe"),
        resource_dir.join("sidecars").join("fiscal-bridge"),
    ];

    for c in candidates.iter() {
        if c.exists() {
            return Ok(FiscalBridgeStatus {
                present: true,
                path: Some(c.to_string_lossy().to_string()),
            });
        }
    }

    Ok(FiscalBridgeStatus {
        present: false,
        path: None,
    })
}

/// Returns the OS-specific application data directory used by the POS
/// app for config and the SQLite database.
#[tauri::command]
fn app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "init schema",
            sql: MIGRATION_V1_INIT,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "events.order_local_id",
            sql: MIGRATION_V2_EVENTS_ORDER_LINK,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "remote read model — Sprint 6",
            sql: MIGRATION_V3_REMOTE_READ_MODEL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "remote_orders ownership — Sprint 7",
            sql: MIGRATION_V4_REMOTE_ORDERS_OWNERSHIP,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "card_recoveries queue — Sprint 8",
            sql: MIGRATION_V5_CARD_RECOVERY,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "fiscal_attempts + payment_attempts + station_pairings — Sprint 11",
            sql: MIGRATION_V6_FISCAL_ATTEMPTS,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "fiscal_runtime_config (Settings UI source-of-truth)",
            sql: MIGRATION_V7_FISCAL_RUNTIME_CONFIG,
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Focus the existing window if the user double-launches.
            if let Some(window) = app.webview_windows().values().next() {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:pos-desktop.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            fiscal_bridge_status,
            app_data_dir,
            fiscal::commands::fiscal_use_rust_enabled,
            fiscal::commands::fiscal_get_runtime_config,
            fiscal::commands::fiscal_set_runtime_config,
            fiscal::commands::fiscal_test_connection,
            fiscal::commands::fiscal_get_status,
            fiscal::commands::fiscal_print_receipt,
            fiscal::commands::fiscal_cancel_receipt,
            fiscal::commands::fiscal_request_z_confirm,
            fiscal::commands::fiscal_print_z_report,
            fiscal::commands::fiscal_record_payment_attempt,
            fiscal::commands::fiscal_list_attempts,
            fiscal::commands::fiscal_list_payment_attempts,
            fiscal::commands::fiscal_probe,
            fiscal::commands::fiscal_list_ports,
            fiscal::commands::fiscal_raw_debug,
            fiscal::commands::fiscal_debug_credentials,
            fiscal::commands::fiscal_bridge_claim,
            fiscal::commands::fiscal_bridge_run,
            fiscal::commands::fiscal_bridge_state,
            fiscal::commands::fiscal_pull_config,
            fiscal::commands::fiscal_get_cached_config,
            fiscal::commands::fiscal_get_station_pairing,
            fiscal::commands::fiscal_upsert_station_pairing,
            fiscal::commands::fiscal_clear_station_pairing,
        ])
        .run(tauri::generate_context!())
        .expect("error while running 360booking POS");
}
