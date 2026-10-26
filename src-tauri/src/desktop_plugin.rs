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
//     open_fiscal_settings, open_pos, toggle_kiosk, print_kitchen
// local pages only (capabilities/default.json):
//     offline_list_orders, offline_close_order, offline_mark_reviewed,
//     offline_requeue, offline_resolve_unknown
// the configured tenant origin only (runtime capability, shell/mod.rs):
//     fiscal_link — automatic link from Setări → Casa de marcat
//
// Keep the command list in sync with build.rs.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Webview, Wry};

use crate::fiscal::bridge_client::state::now_unix;
use crate::fiscal::commands::{fiscal_bridge_claim, fiscal_bridge_run};
use crate::fiscal::config as fiscal_config;
use crate::fiscal::credentials;
use crate::escpos::{self, EscposResult};
use crate::fiscal::persist;
use crate::fiscal::providers;
use crate::fiscal::runtime_config;
use crate::offline::{self, CachePayload, CachedOrder, CloseRequest, JournalEntry, Prepared, SyncResult};
use crate::shell::{self, agent, config, link};

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
        let station = config::current();
        let default_vat = station.offline_default_vat;
        if provider_name == "simulator" && !station.offline_allow_simulator {
            return Err("Casa de marcat nu este configurată pe această stație (simulator). \
                        Configureaz-o din „Casă de marcat” (Ctrl+Shift+F) ca să emiți bonuri offline."
                .into());
        }

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

/// Bonul de bucătărie al POS-ului web (2026-10-26): aplicația e stația de
/// tipărire a restaurantului. Serverul face bonul (ESC/POS) și alege
/// imprimanta postului; aici doar îl trimitem pe rețeaua locală, prin același
/// `escpos_send` ca butonul de test. Pagina e remote, deci porturile sunt
/// strict cele RAW de imprimantă (nu un scaner de porturi pentru oricine).
#[tauri::command]
async fn print_kitchen(host: String, port: u16, data: Vec<u8>) -> Result<EscposResult, String> {
    let host = host.trim().to_string();
    if host.is_empty() || host.len() > 253 {
        return Err("Adresa imprimantei lipsește.".into());
    }
    if !(9100..=9109).contains(&port) {
        return Err("Portul nu e de imprimantă (9100–9109).".into());
    }
    if data.is_empty() || data.len() > 256 * 1024 {
        return Err("Bonul e gol sau prea mare.".into());
    }
    if let Ok(ip) = host.trim_matches(|c| c == '[' || c == ']').parse::<std::net::IpAddr>() {
        let link_local = matches!(ip, std::net::IpAddr::V4(v4) if v4.is_link_local());
        if ip.is_loopback() || ip.is_multicast() || ip.is_unspecified() || link_local {
            return Err("Adresa nu poate fi a unei imprimante.".into());
        }
    }
    Ok(escpos::escpos_send(host, port, data).await)
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

// ---------------------------------------------------------------------------
// Automatic link (2026-10-14, „casa simplu”) — see shell/link.rs.

static LINKING: AtomicBool = AtomicBool::new(false);

struct LinkingGuard;
impl Drop for LinkingGuard {
    fn drop(&mut self) {
        LINKING.store(false, Ordering::SeqCst);
    }
}

/// Links this app to the restaurant with a fresh enrolment code obtained by
/// the admin page (POST /api/fiscal-bridge/enroll). Runs the same functions
/// as step 2 of the guide: claim → fiscal_bridge_run → protocol config →
/// reconnect. Accepts only a code (8 letters/digits), never a token, and only
/// from the main window showing the configured tenant site.
#[tauri::command]
async fn fiscal_link(app: AppHandle, webview: Webview<Wry>, code: String) -> Result<Value, String> {
    let cfg = config::current();
    let tenant = cfg
        .tenant_origin()
        .ok_or_else(|| "Adresa restaurantului nu e setată în aplicație.".to_string())?;
    let page = webview.url().map_err(|e| e.to_string())?;
    if webview.label() != shell::MAIN || !link::is_tenant_page(&page, &tenant) {
        log::warn!(
            "fiscal_link: refused — caller {} on {} is not the restaurant page {}",
            webview.label(),
            page.origin().ascii_serialization(),
            tenant.as_str()
        );
        return Err("Legarea casei de marcat se pornește doar din pagina restaurantului.".into());
    }
    let code = link::normalise_enrollment_code(&code)
        .ok_or_else(|| "Codul de legare nu e valid.".to_string())?;
    if LINKING.swap(true, Ordering::SeqCst) {
        return Err("Legarea e deja în curs.".into());
    }
    let _guard = LinkingGuard;
    link::set_state(link::LinkState { state: "linking".into(), at: now_unix(), error: None, bridge_id: None });
    match run_link(&app, &code).await {
        Ok(v) => {
            link::set_state(link::LinkState {
                state: "ok".into(),
                at: now_unix(),
                error: None,
                bridge_id: v.get("bridgeId").and_then(|b| b.as_str()).map(str::to_string),
            });
            Ok(v)
        }
        Err(raw) => {
            log::error!("fiscal_link: failed: {raw}");
            let text = link::explain_link_error(&raw);
            link::set_state(link::LinkState { state: "error".into(), at: now_unix(), error: Some(text.clone()), bridge_id: None });
            Err(text)
        }
    }
}

async fn run_link(app: &AppHandle, code: &str) -> Result<Value, String> {
    let db = persist::db_path(app).ok();
    let saved = db.as_ref().and_then(|p| credentials::read(p).ok().flatten());
    let server = saved
        .as_ref()
        .map(|c| c.server_base_url.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| link::DEFAULT_SERVER.to_string());
    let rc = db
        .as_ref()
        .and_then(|p| runtime_config::read(p).ok())
        .unwrap_or_default();
    let model = link::printer_model_for_claim(rc.provider.as_deref());
    log::info!("fiscal_link: claiming on {server} (model {model})");
    // Same calls as step 2 of the guide (fiscal-guide/FiscalGuide.tsx).
    let r = fiscal_bridge_claim(app.clone(), server.clone(), code.to_string(), model.clone(), None).await?;
    fiscal_bridge_run(app.clone(), r.websocket_url.clone(), r.device_token.clone(), model)?;
    match fiscal_config::pull_config(&server, &r.device_token).await {
        Ok(pulled) => {
            fiscal_config::put_in_memory(pulled.clone());
            if let Err(e) = fiscal_config::write_disk_cache(app, &pulled) {
                log::warn!("fiscal_link: config cache write failed: {e}");
            }
        }
        Err(e) => log::warn!("fiscal_link: pull config failed: {e}"),
    }
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || agent::reconnect_now(&a))
        .await
        .map_err(|e| format!("task: {e}"))?;
    log::info!("fiscal_link: linked (bridge_id={} tenant_id={})", r.bridge_id, r.tenant_id);
    Ok(json!({ "bridgeId": r.bridge_id, "tenantId": r.tenant_id }))
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
            fiscal_link,
            print_kitchen,
        ])
        .build()
}
