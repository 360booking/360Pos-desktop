// Etapa 5 — `desktop` plugin: the native surface of the POS desktop shell.
//
// Implemented as an (inlined) plugin rather than app commands on purpose:
// plugin commands are always checked against the capability ACL, so the
// remote web POS can be granted exactly `desktop:default` (see build.rs and
// capabilities/remote-pos.json) and nothing else — none of the fiscal /
// SQLite app commands are reachable from a remote origin.
//
// `desktop:default` (remote web POS + local pages):
//     bridge_info, offline_cache_orders, offline_pending_sync,
//     offline_mark_synced, offline_journal, open_offline_till,
//     open_fiscal_settings, open_pos, toggle_kiosk
// local pages only (capabilities/default.json):
//     offline_list_orders, offline_close_order, offline_mark_reviewed,
//     offline_requeue, offline_resolve_unknown
//
// Keep the command list in sync with build.rs.

use serde_json::{json, Value};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Wry};

use crate::fiscal::persist;
use crate::fiscal::providers;
use crate::fiscal::runtime_config;
use crate::offline::{self, CachePayload, CachedOrder, CloseRequest, JournalEntry, Prepared, SyncResult};
use crate::shell::{self, agent, config};

async fn blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(&app))
        .await
        .map_err(|e| format!("task: {e}"))?
}

#[tauri::command]
async fn bridge_info(app: AppHandle) -> Result<Value, String> {
    blocking(app, |app| {
        let cfg = config::current();
        let journal = offline::with_store(app, |c| offline::counts(c)).unwrap_or_default();
        Ok(json!({
            "version": app.package_info().version.to_string(),
            "kind": "pos_desktop_tauri",
            "mode": cfg.mode,
            "tenantUrl": cfg.tenant_origin().map(|u| u.as_str().trim_end_matches('/').to_string()),
            "posUrl": cfg.pos_url().map(|u| u.to_string()),
            "online": shell::is_online(),
            "onlineChangedAt": shell::online_changed_at(),
            "kiosk": shell::kiosk_on(),
            "defaultVat": cfg.offline_default_vat,
            "journal": journal,
            "fiscal": agent::health(),
            "agent": agent::summary(app),
        }))
    })
    .await
}

#[tauri::command]
async fn offline_cache_orders(app: AppHandle, payload: CachePayload) -> Result<Value, String> {
    blocking(app, move |app| {
        let n = offline::with_store(app, |c| offline::cache_orders(c, &payload))?;
        Ok(json!({ "cached": n }))
    })
    .await
}

#[tauri::command]
async fn offline_list_orders(app: AppHandle) -> Result<Vec<CachedOrder>, String> {
    blocking(app, |app| offline::with_store(app, |c| offline::list_cached(c))).await
}

#[tauri::command]
async fn offline_pending_sync(app: AppHandle) -> Result<Vec<JournalEntry>, String> {
    blocking(app, |app| offline::with_store(app, |c| offline::pending_sync(c))).await
}

#[tauri::command]
async fn offline_mark_synced(app: AppHandle, id: String, result: SyncResult) -> Result<JournalEntry, String> {
    blocking(app, move |app| offline::with_store(app, |c| offline::mark_synced(c, &id, &result))).await
}

#[tauri::command]
async fn offline_journal(app: AppHandle, limit: Option<i64>) -> Result<Vec<JournalEntry>, String> {
    blocking(app, move |app| {
        offline::with_store(app, |c| offline::list_journal(c, limit.unwrap_or(100)))
    })
    .await
}

#[tauri::command]
async fn offline_mark_reviewed(app: AppHandle, id: String) -> Result<JournalEntry, String> {
    blocking(app, move |app| offline::with_store(app, |c| offline::mark_reviewed(c, &id))).await
}

#[tauri::command]
async fn offline_requeue(app: AppHandle, id: String) -> Result<JournalEntry, String> {
    blocking(app, move |app| offline::with_store(app, |c| offline::requeue(c, &id))).await
}

#[tauri::command]
async fn offline_resolve_unknown(
    app: AppHandle,
    id: String,
    printed: bool,
    fiscal_number: Option<String>,
) -> Result<JournalEntry, String> {
    blocking(app, move |app| {
        offline::with_store(app, |c| offline::resolve_unknown(c, &id, printed, fiscal_number.as_deref()))
    })
    .await
}

/// Close a cached order offline: journal row → local fiscal receipt → BF.
/// The store lock is NOT held while the device prints (that can take 10s+);
/// the device itself is serialised by `providers::device_lock`.
#[tauri::command]
async fn offline_close_order(app: AppHandle, request: CloseRequest) -> Result<JournalEntry, String> {
    blocking(app, move |app| {
        let rc = persist::db_path(app)
            .ok()
            .and_then(|p| runtime_config::read(&p).ok())
            .unwrap_or_default();
        let provider_name = runtime_config::effective_provider(&rc);
        let default_vat = config::current().offline_default_vat;

        let prepared = offline::with_store(app, |c| {
            offline::prepare_close(c, &request, default_vat, &provider_name)
        })?;
        let (entry_id, receipt) = match prepared {
            Prepared::Existing(e) => return Ok(e),
            Prepared::Print { entry_id, request } => (entry_id, request),
        };
        log::info!(
            "offline: printing receipt for order {} (mutation {}, provider {})",
            receipt.order_local_id,
            receipt.mutation_id,
            provider_name
        );
        let outcome = providers::build(&provider_name, &rc)
            .and_then(|p| p.print_receipt(receipt))
            .map_err(|e| e.to_string());
        if let Err(e) = &outcome {
            log::warn!("offline: print failed: {e}");
        }
        offline::with_store(app, |c| offline::finish_print(c, &entry_id, outcome))
    })
    .await
}

// Window work happens in async commands: creating a window from a sync
// command deadlocks on Windows (wry#583).
#[tauri::command]
async fn open_offline_till(app: AppHandle) -> Result<(), String> {
    shell::open_offline_till(&app)
}

#[tauri::command]
async fn open_fiscal_settings(app: AppHandle) -> Result<(), String> {
    shell::open_fiscal_settings(&app)
}

#[tauri::command]
async fn open_pos(app: AppHandle) -> Result<(), String> {
    shell::open_pos(&app)
}

#[tauri::command]
async fn toggle_kiosk(app: AppHandle) -> Result<bool, String> {
    shell::toggle_kiosk(&app)
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::<Wry>::new("desktop")
        .invoke_handler(tauri::generate_handler![
            bridge_info,
            offline_cache_orders,
            offline_list_orders,
            offline_pending_sync,
            offline_mark_synced,
            offline_journal,
            offline_mark_reviewed,
            offline_requeue,
            offline_resolve_unknown,
            offline_close_order,
            open_offline_till,
            open_fiscal_settings,
            open_pos,
            toggle_kiosk,
        ])
        .build()
}
