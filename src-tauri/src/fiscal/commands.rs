// Tauri commands wired to the React adapter. Sprint 1 exposes the same
// surface the existing FiscalDeviceAdapter (src/adapters/fiscal/types.ts)
// uses, plus a diagnostic probe that mirrors Python --probe-printer and the
// bridge client (claim + WSS) that mirrors fiscal-bridge/bridge/ws_client.py.
//
// Sprint 11 (B9) adds auto-persistence: after `print_receipt` returns, the
// command upserts a row into `fiscal_attempts` (SQLite v6). Payment attempts
// stay TS-driven for now (BT-ECR provider lands in Sprint 2) but the
// `fiscal_record_payment_attempt` command is exposed so the existing JS card
// flow can persist its rows through the same path. WSS-driven test prints
// (run_job in bridge_client/ws.rs) intentionally skip persistence — those
// are backend-fired diagnostic round-trips, not real fiscal events, and
// the backend already logs them server-side.

use std::sync::{Arc, Mutex, OnceLock};

use crate::fiscal::bridge_client::{
    claim::{claim, ClaimResponse},
    state::{BridgeState, SharedState},
    ws::{run_forever, WsClientConfig},
};
use crate::fiscal::config::{self, FiscalConfig};
use crate::fiscal::diagnostics::probe::{list_ports, probe_all, ProbeReport};
use crate::fiscal::dto::{
    CancelReceiptRequest, FiscalStatus, ReceiptRequest, ReceiptResponse, TestResult,
};
use crate::fiscal::persist::{
    self, AttemptContext, FiscalAttemptRow, PaymentAttemptRow, StationPairingRow,
};
use crate::fiscal::providers;
use std::time::{Duration, Instant};

static BRIDGE_STATE: OnceLock<SharedState> = OnceLock::new();

// Sprint 2 / Q7 — Z-report safety gate. A nonce is issued by
// `fiscal_request_z_confirm` and must accompany any `fiscal_print_z_report`
// call within 30 seconds. Single-use: consumed on success, also cleared on
// expiry. The mutex keeps issue/consume race-free across UI clicks.
static Z_CONFIRM: OnceLock<Mutex<Option<ZConfirm>>> = OnceLock::new();

#[derive(Clone)]
struct ZConfirm {
    token: String,
    expires_at: Instant,
}

const Z_CONFIRM_TTL_SECS: u64 = 30;

fn z_confirm_slot() -> &'static Mutex<Option<ZConfirm>> {
    Z_CONFIRM.get_or_init(|| Mutex::new(None))
}

fn shared_state() -> SharedState {
    BRIDGE_STATE
        .get_or_init(|| Arc::new(Mutex::new(BridgeState::default())))
        .clone()
}

fn provider_name() -> String {
    std::env::var("FISCAL_PROVIDER").unwrap_or_else(|_| "simulator".into())
}

fn use_rust_enabled() -> bool {
    matches!(
        std::env::var("FISCAL_USE_RUST").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn raw_logging_enabled() -> bool {
    matches!(
        std::env::var("FISCAL_ENABLE_RAW_LOGS").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

#[tauri::command]
pub fn fiscal_use_rust_enabled() -> bool {
    use_rust_enabled()
}

#[tauri::command]
pub fn fiscal_test_connection() -> Result<TestResult, String> {
    let p = providers::build(&provider_name()).map_err(|e| e.to_string())?;
    p.test_connection().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_get_status() -> Result<FiscalStatus, String> {
    let p = providers::build(&provider_name()).map_err(|e| e.to_string())?;
    p.get_status().map_err(|e| e.to_string())
}

/// Print a receipt + auto-persist a `fiscal_attempts` row.
///
/// `device_id` is supplied by the TS adapter — the desktop knows its own
/// `pos-desktop` device id from pairing. We accept it as a parameter rather
/// than baking it into `ReceiptRequest` so the wire shape stays identical to
/// what the Python bridge accepts; this keeps the WSS path (which forwards
/// raw `ReceiptRequest`) unchanged.
#[tauri::command]
pub fn fiscal_print_receipt(
    app: tauri::AppHandle,
    request: ReceiptRequest,
    device_id: Option<String>,
) -> Result<ReceiptResponse, String> {
    let provider_name = provider_name();
    let p = providers::build(&provider_name).map_err(|e| e.to_string())?;
    let res = p.print_receipt(request.clone()).map_err(|e| e.to_string())?;

    // Persist on a best-effort basis — a failed write must not mask a successful
    // print. Audit §5.5: never lose a fiscal event because of local I/O.
    if let Some(dev_id) = device_id.as_deref() {
        match persist::db_path(&app) {
            Ok(path) => {
                let paired = persist::read_paired_fiscal_device(&path, dev_id)
                    .ok()
                    .flatten();
                let env_printer_model = env_opt("FISCAL_PRINTER_MODEL");
                let env_serial_port = env_opt("FISCAL_SERIAL_PORT");
                let env_protocol_variant = env_opt("FISCAL_PROTOCOL_VARIANT");
                let printer_model_default: Option<&'static str> =
                    match provider_name.as_str() {
                        "datecs_dp25" => Some("Datecs DP-25"),
                        "simulator" => Some("Simulator"),
                        _ => None,
                    };
                let printer_model: Option<&str> = env_printer_model
                    .as_deref()
                    .or(printer_model_default);
                let serial_port: Option<&str> = env_serial_port.as_deref();
                let protocol_variant: Option<&str> = env_protocol_variant.as_deref();
                let baud = std::env::var("FISCAL_BAUD_RATE")
                    .ok()
                    .and_then(|s| s.parse().ok());
                let ctx = AttemptContext {
                    device_id: dev_id,
                    provider: &provider_name,
                    printer_model,
                    serial_port,
                    baud,
                    protocol_variant,
                    fiscal_device_id: paired,
                    raw_logging: raw_logging_enabled(),
                };
                let row = persist::attempt_row_from_response(&request, &res, &ctx);
                if let Err(e) = persist::record_fiscal_attempt(&path, &row) {
                    log::warn!("persist fiscal_attempt failed: {e}");
                }
            }
            Err(e) => log::warn!("persist db_path failed: {e}"),
        }
    } else {
        log::debug!(
            "fiscal_print_receipt invoked without device_id — persistence skipped (mutation_id={})",
            request.mutation_id
        );
    }

    Ok(res)
}

/// Storno — fiscal void of a previously printed receipt. Same auto-persist
/// behavior as `fiscal_print_receipt`: a row in `fiscal_attempts` is upserted
/// with the storno mutation_id so the operator can audit the void. The
/// original receipt's BF stays intact in its own row.
#[tauri::command]
pub fn fiscal_cancel_receipt(
    app: tauri::AppHandle,
    request: CancelReceiptRequest,
    device_id: Option<String>,
) -> Result<ReceiptResponse, String> {
    let provider_name = provider_name();
    let p = providers::build(&provider_name).map_err(|e| e.to_string())?;
    let res = p.cancel_receipt(request.clone()).map_err(|e| e.to_string())?;

    if let Some(dev_id) = device_id.as_deref() {
        if let Ok(path) = persist::db_path(&app) {
            let paired = persist::read_paired_fiscal_device(&path, dev_id).ok().flatten();
            // Reuse the print_receipt ReceiptRequest shape for the
            // attempt_row helper — the storno still produces a fiscal_attempts
            // row keyed on the storno's own mutation_id; no dedup with the
            // original print.
            let synthesized = ReceiptRequest {
                mutation_id: request.mutation_id.clone(),
                order_local_id: request.order_local_id.clone(),
                fiscal_attempt_id: request.fiscal_attempt_id.clone(),
                items: request.items.clone(),
                payments: request.payments.clone(),
                currency: request.currency.clone(),
                customer_cif: None,
                customer_name: None,
                footer_note: Some(format!("STORNO of {}", request.original_fiscal_number)),
            };
            let env_printer_model = env_opt("FISCAL_PRINTER_MODEL");
            let env_serial_port = env_opt("FISCAL_SERIAL_PORT");
            let env_protocol_variant = env_opt("FISCAL_PROTOCOL_VARIANT");
            let printer_model_default: Option<&'static str> =
                match provider_name.as_str() {
                    "datecs_dp25" => Some("Datecs DP-25 (storno)"),
                    "simulator" => Some("Simulator (storno)"),
                    _ => None,
                };
            let printer_model: Option<&str> = env_printer_model
                .as_deref()
                .or(printer_model_default);
            let baud = std::env::var("FISCAL_BAUD_RATE")
                .ok()
                .and_then(|s| s.parse().ok());
            let ctx = AttemptContext {
                device_id: dev_id,
                provider: &provider_name,
                printer_model,
                serial_port: env_serial_port.as_deref(),
                baud,
                protocol_variant: env_protocol_variant.as_deref(),
                fiscal_device_id: paired,
                raw_logging: raw_logging_enabled(),
            };
            let row = persist::attempt_row_from_response(&synthesized, &res, &ctx);
            if let Err(e) = persist::record_fiscal_attempt(&path, &row) {
                log::warn!("persist storno attempt failed: {e}");
            }
        }
    }

    Ok(res)
}

/// Issue a single-use Z-report confirmation token. Caller (UI) must surface
/// an explicit confirmation dialog before invoking this, then call
/// `fiscal_print_z_report` with the returned token within 30 seconds.
#[tauri::command]
pub fn fiscal_request_z_confirm() -> Result<String, String> {
    use std::time::SystemTime;
    let nonce = format!(
        "z-{:x}-{:x}",
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        std::process::id(),
    );
    if let Ok(mut slot) = z_confirm_slot().lock() {
        *slot = Some(ZConfirm {
            token: nonce.clone(),
            expires_at: Instant::now() + Duration::from_secs(Z_CONFIRM_TTL_SECS),
        });
    }
    Ok(nonce)
}

#[tauri::command]
pub fn fiscal_print_z_report(confirm_token: String) -> Result<ReceiptResponse, String> {
    // Validate + consume the nonce inside the mutex — single-use.
    let valid = if let Ok(mut slot) = z_confirm_slot().lock() {
        match slot.as_ref() {
            Some(c) if c.token == confirm_token && c.expires_at > Instant::now() => {
                *slot = None;
                true
            }
            Some(c) if c.expires_at <= Instant::now() => {
                *slot = None;
                false
            }
            _ => false,
        }
    } else {
        false
    };
    if !valid {
        return Err("Z-report rejected: confirm_token missing, expired, or already used".into());
    }
    let p = providers::build(&provider_name()).map_err(|e| e.to_string())?;
    p.print_z_report(&confirm_token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_record_payment_attempt(
    app: tauri::AppHandle,
    row: PaymentAttemptRow,
) -> Result<(), String> {
    let path = persist::db_path(&app).map_err(|e| e.to_string())?;
    persist::record_payment_attempt(&path, &row).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_list_attempts(
    app: tauri::AppHandle,
    order_local_id: String,
) -> Result<Vec<FiscalAttemptRow>, String> {
    let path = persist::db_path(&app).map_err(|e| e.to_string())?;
    persist::list_fiscal_attempts(&path, &order_local_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_list_payment_attempts(
    app: tauri::AppHandle,
    order_local_id: String,
) -> Result<Vec<PaymentAttemptRow>, String> {
    let path = persist::db_path(&app).map_err(|e| e.to_string())?;
    persist::list_payment_attempts(&path, &order_local_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_probe(port: Option<String>, baud: Option<u32>) -> Result<ProbeReport, String> {
    let port = port
        .or_else(|| std::env::var("FISCAL_SERIAL_PORT").ok())
        .ok_or_else(|| "FISCAL_SERIAL_PORT missing".to_string())?;
    let baud = baud
        .or_else(|| std::env::var("FISCAL_BAUD_RATE").ok().and_then(|s| s.parse().ok()))
        .unwrap_or(9600);
    Ok(probe_all(&port, baud))
}

#[tauri::command]
pub fn fiscal_list_ports() -> Vec<String> {
    list_ports()
}

#[tauri::command]
pub async fn fiscal_bridge_claim(
    app: tauri::AppHandle,
    server_base_url: String,
    code: String,
    printer_model: String,
    device_id: Option<String>,
) -> Result<ClaimResponse, String> {
    let response = claim(&server_base_url, &code, &printer_model)
        .await
        .map_err(|e| e.to_string())?;
    // B11 — auto-pair on a successful claim. Mirrors the audit Q2 1:1:1
    // rule: once the desktop owns this `bridge_id`, that's the fiscal device
    // for this station until the admin explicitly unpairs. Writes are
    // best-effort — pairing failure must not retract the claim.
    if let Some(dev_id) = device_id.as_deref() {
        match persist::db_path(&app) {
            Ok(path) => {
                let row = StationPairingRow {
                    device_id: dev_id.to_string(),
                    fiscal_device_id: Some(response.bridge_id.clone()),
                    payment_terminal_id: None,
                    fiscal_provider: Some(provider_name()),
                    payment_provider: None,
                };
                if let Err(e) = persist::upsert_station_pairing(&path, &row) {
                    log::warn!("auto-pair after claim failed: {e}");
                }
            }
            Err(e) => log::warn!("auto-pair db_path failed: {e}"),
        }
    }
    Ok(response)
}

#[tauri::command]
pub fn fiscal_get_station_pairing(
    app: tauri::AppHandle,
    device_id: String,
) -> Result<Option<StationPairingRow>, String> {
    let path = persist::db_path(&app).map_err(|e| e.to_string())?;
    persist::read_station_pairing(&path, &device_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_upsert_station_pairing(
    app: tauri::AppHandle,
    row: StationPairingRow,
) -> Result<(), String> {
    let path = persist::db_path(&app).map_err(|e| e.to_string())?;
    persist::upsert_station_pairing(&path, &row).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_clear_station_pairing(
    app: tauri::AppHandle,
    device_id: String,
) -> Result<(), String> {
    let path = persist::db_path(&app).map_err(|e| e.to_string())?;
    persist::clear_station_pairing(&path, &device_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_bridge_run(
    websocket_url: String,
    device_token: String,
    printer_model: String,
) -> Result<(), String> {
    let state = shared_state();
    if let Ok(mut s) = state.lock() {
        s.configured = true;
    }
    let cfg = WsClientConfig { websocket_url, device_token, printer_model };
    let st = state.clone();
    // Spawn a tokio runtime on a dedicated thread so the WSS loop survives
    // outside Tauri's command futures (commands return immediately; the loop
    // keeps reconnecting until shutdown).
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async move {
            if let Err(e) = run_forever(cfg, st.clone()).await {
                log::error!("bridge: terminated with error: {e}");
                if let Ok(mut s) = st.lock() {
                    s.connected = false;
                    s.last_error = Some(e.to_string());
                }
            }
        });
    });
    Ok(())
}

#[tauri::command]
pub fn fiscal_bridge_state() -> BridgeState {
    shared_state().lock().map(|s| s.clone()).unwrap_or_default()
}

/// C12: pull resolved protocol config from the backend, cache in memory + disk.
/// Sprint 1 invokes this on app boot (when a device_token exists) and from a
/// "Refresh" button in Settings → Casă de marcat. WSS hot-reload stays out per
/// audit Q9.
#[tauri::command]
pub async fn fiscal_pull_config(
    app: tauri::AppHandle,
    server_base_url: String,
    device_token: String,
) -> Result<FiscalConfig, String> {
    let cfg = config::pull_config(&server_base_url, &device_token)
        .await
        .map_err(|e| e.to_string())?;
    config::put_in_memory(cfg.clone());
    if let Err(e) = config::write_disk_cache(&app, &cfg) {
        log::warn!("fiscal_pull_config: disk cache write failed: {e}");
    }
    Ok(cfg)
}

/// Read the cached config (in-memory first, fall through to disk). Returns
/// None when nothing has been pulled yet — the caller can show a placeholder
/// or trigger `fiscal_pull_config`.
#[tauri::command]
pub fn fiscal_get_cached_config(
    app: tauri::AppHandle,
) -> Result<Option<FiscalConfig>, String> {
    if let Some(cfg) = config::get_in_memory() {
        return Ok(Some(cfg));
    }
    let from_disk = config::read_disk_cache(&app).map_err(|e| e.to_string())?;
    if let Some(cfg) = from_disk.clone() {
        config::put_in_memory(cfg);
    }
    Ok(from_disk)
}
