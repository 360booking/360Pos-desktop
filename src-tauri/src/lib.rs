use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_sql::{Migration, MigrationKind};

mod desktop_plugin;
mod escpos;
mod fiscal;
mod localdb;
mod offline;
mod shell;

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
const MIGRATION_V8_FISCAL_BRIDGE_CREDENTIALS: &str =
    include_str!("../../src/sql/migrations/0008_fiscal_bridge_credentials.sql");
const MIGRATION_V9_LOCAL_PAYMENT_OUTBOX: &str =
    include_str!("../../src/sql/migrations/0009_local_payment_outbox.sql");
const MIGRATION_V10_PRODUCT_IMAGE: &str =
    include_str!("../../src/sql/migrations/0010_product_image.sql");

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

/// Panics go to the app log too (2026-10-14): before, a panic in the fiscal
/// agent thread left no trace in `360restaurants POS.log`. The default hook
/// (stderr) still runs after.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        log::error!(
            "PANIC in thread '{}': {}\n{}",
            thread.name().unwrap_or("<fără nume>"),
            info,
            std::backtrace::Backtrace::force_capture()
        );
        previous(info);
    }));
}

/// App log (`%LOCALAPPDATA%\com.x360booking.pos\logs`): Info for everything,
/// Debug for the fiscal agent / printer watchdog and the WSS TLS setup (the
/// "Added N/M native root certificates" line); 5 MB per file, 5 files kept.
/// Before: no filter (TRACE from every crate) and the default KeepOne at
/// 40 KB, which deleted the log at the next start.
fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .level_for("pos_desktop_lib::fiscal", log::LevelFilter::Debug)
        .level_for("pos_desktop_lib::shell::agent", log::LevelFilter::Debug)
        .level_for("tokio_tungstenite", log::LevelFilter::Debug)
        .max_file_size(5_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
        .build()
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
        Migration {
            version: 8,
            description: "fiscal_bridge_credentials (persist claim across restarts)",
            sql: MIGRATION_V8_FISCAL_BRIDGE_CREDENTIALS,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "local_payment_outbox — Faza 2",
            sql: MIGRATION_V9_LOCAL_PAYMENT_OUTBOX,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "products.image_url — photo-first cards",
            sql: MIGRATION_V10_PRODUCT_IMAGE,
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Focus the existing window if the user double-launches.
            if let Some(window) = app
                .get_webview_window(shell::MAIN)
                .or_else(|| app.webview_windows().values().next().cloned())
            {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(log_plugin())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:pos-desktop.db", migrations)
                .build(),
        )
        .plugin(desktop_plugin::init())
        .manage(localdb::LocalDb::new())
        .manage(offline::OfflineStore::new())
        .setup(|app| {
            install_panic_hook();
            log::info!("360restaurants POS v{} starting", app.package_info().version);
            let handle = app.handle().clone();
            // Etapa 5 — station config first: it decides what the main
            // window loads and which fiscal agent runs.
            let cfg = shell::config::load(&handle);
            log::info!(
                "shell: mode={} tenant={} kiosk={} agent={}",
                cfg.mode,
                if cfg.tenant_url.is_empty() { "(unset)" } else { cfg.tenant_url.as_str() },
                cfg.kiosk,
                cfg.fiscal_agent
            );
            // Receipts interrupted by a crash/power cut are flagged for a
            // manual check — never reprinted automatically.
            match offline::with_store(&handle, |c| offline::recover_interrupted(c)) {
                Ok(n) if n > 0 => log::warn!("offline: {n} receipt(s) interrupted mid-print flagged for review"),
                Ok(_) => {}
                Err(e) => log::warn!("offline: store init failed: {e}"),
            }
            shell::start_connectivity_monitor();
            shell::create_main_window(&handle)?;
            // Fiscal agent: the integrated Rust agent, started from the
            // credentials saved by the enrolment. Supervised.
            shell::agent::start(&handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            fiscal::commands::fiscal_print_x_report,
            fiscal::commands::fiscal_open_drawer,
            fiscal::commands::fiscal_reprint_last,
            fiscal::commands::fiscal_print_periodic_memory,
            fiscal::commands::fiscal_record_payment_attempt,
            fiscal::commands::fiscal_list_attempts,
            fiscal::commands::fiscal_list_payment_attempts,
            fiscal::commands::fiscal_probe,
            fiscal::commands::fiscal_list_ports,
            fiscal::commands::fiscal_list_ports_detailed,
            fiscal::commands::fiscal_raw_debug,
            fiscal::commands::fiscal_debug_credentials,
            fiscal::commands::fiscal_bridge_claim,
            fiscal::commands::fiscal_get_saved_bridge_credentials,
            fiscal::commands::fiscal_clear_saved_bridge_credentials,
            fiscal::commands::fiscal_bridge_run,
            fiscal::commands::fiscal_bridge_state,
            fiscal::commands::fiscal_pull_config,
            fiscal::commands::fiscal_get_cached_config,
            fiscal::commands::fiscal_get_station_pairing,
            fiscal::commands::fiscal_upsert_station_pairing,
            fiscal::commands::fiscal_clear_station_pairing,
            fiscal::diagnostics::report::fiscal_diagnostics,
            fiscal::diagnostics::report::fiscal_open_log_dir,
            escpos::escpos_send,
            localdb::db_select,
            localdb::db_execute,
            localdb::db_begin,
            localdb::db_commit,
            localdb::db_rollback,
            localdb::db_reset_session,
            shell::shell_get_config,
            shell::shell_set_config,
            shell::shell_test_tenant,
            shell::shell_open_pos,
            shell::shell_open_offline,
            shell::shell_open_fiscal_settings,
            shell::shell_set_kiosk,
            shell::shell_quit,
            shell::agent::shell_fiscal_health,
            shell::agent::shell_fiscal_reconnect,
        ])
        .build(tauri::generate_context!())
        .expect("error while building 360booking POS")
        .run(|app, event| match event {
            // Only the main window ends the session; closing the fiscal
            // settings window must not kill the fiscal agent.
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } if label == shell::MAIN => {
                app.exit(0);
            }
            _ => {}
        });
}
