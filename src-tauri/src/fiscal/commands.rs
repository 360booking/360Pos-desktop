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

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::fiscal::bridge_client::{
    claim::{claim, ClaimResponse},
    state::{BridgeState, SharedState},
    ws::{run_forever, WsClientConfig},
};
use crate::fiscal::config::{self, FiscalConfig};
use crate::fiscal::credentials::{self, BridgeCredentials};
use crate::fiscal::diagnostics::detect;
use crate::fiscal::diagnostics::probe::{
    list_ports, list_ports_detailed, probe_all, PortDetail, ProbeReport,
};
use crate::fiscal::dto::{
    CancelReceiptRequest, FiscalStatus, ReceiptRequest, ReceiptResponse, TestResult,
};
use crate::fiscal::persist::{
    self, AttemptContext, FiscalAttemptRow, PaymentAttemptRow, StationPairingRow,
};
use crate::fiscal::providers;
use crate::fiscal::runtime_config::{self, RuntimeConfig};
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

fn load_runtime_config(app: &tauri::AppHandle) -> RuntimeConfig {
    // Best-effort. When the DB is missing or unreadable (first launch before
    // any migration ran, broken APPDATA), fall back to a default config so
    // env-var-only paths keep working.
    persist::db_path(app)
        .ok()
        .and_then(|p| runtime_config::read(&p).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn fiscal_use_rust_enabled(app: tauri::AppHandle) -> bool {
    runtime_config::effective_use_rust(&load_runtime_config(&app))
}

#[tauri::command]
pub fn fiscal_get_runtime_config(app: tauri::AppHandle) -> Result<RuntimeConfig, String> {
    let path = persist::db_path(&app).map_err(|e| e.to_string())?;
    let cfg = runtime_config::read(&path).map_err(|e| e.to_string())?;
    log::debug!(
        "fiscal_get_runtime_config: provider={:?} port={:?} use_rust={:?}",
        cfg.provider, cfg.serial_port, cfg.use_rust
    );
    Ok(cfg)
}

#[tauri::command]
pub fn fiscal_set_runtime_config(
    app: tauri::AppHandle,
    config: RuntimeConfig,
) -> Result<RuntimeConfig, String> {
    let path = persist::db_path(&app).map_err(|e| e.to_string())?;
    log::info!(
        "fiscal_set_runtime_config: provider={:?} port={:?} baud={:?} variant={:?} operator={:?} use_rust={:?} raw_logs={:?} has_password={}",
        config.provider, config.serial_port, config.baud, config.protocol_variant,
        config.operator, config.use_rust, config.enable_raw_logs,
        config.operator_password.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
    );
    runtime_config::write(&path, &config).map_err(|e| {
        log::error!("fiscal_set_runtime_config write failed: {e}");
        e.to_string()
    })?;
    runtime_config::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_test_connection(app: tauri::AppHandle) -> Result<TestResult, String> {
    let cfg = load_runtime_config(&app);
    // 2026-10-14: never "ok" on the simulator / an unconfigured station.
    let provider_name = runtime_config::usable_provider(&cfg).map_err(|e| {
        log::warn!("fiscal_test_connection refused: {e}");
        e.to_string()
    })?;
    log::info!(
        "fiscal_test_connection: provider={} port={:?} baud={}",
        provider_name,
        runtime_config::effective_serial_port(&cfg),
        runtime_config::effective_baud(&cfg)
    );
    let p = providers::build(&provider_name, &cfg).map_err(|e| {
        log::error!("fiscal_test_connection build failed: {e}");
        e.to_string()
    })?;
    match p.test_connection() {
        Ok(r) => {
            log::info!("fiscal_test_connection ok={} detail={}", r.ok, r.detail);
            Ok(r)
        }
        Err(e) => {
            log::error!("fiscal_test_connection failed: {e}");
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn fiscal_get_status(app: tauri::AppHandle) -> Result<FiscalStatus, String> {
    let cfg = load_runtime_config(&app);
    let provider_name = runtime_config::usable_provider(&cfg).map_err(|e| e.to_string())?;
    let p = providers::build(&provider_name, &cfg).map_err(|e| {
        log::error!("fiscal_get_status build failed: {e}");
        e.to_string()
    })?;
    match p.get_status() {
        Ok(s) => {
            log::debug!(
                "fiscal_get_status: online={} paper_ok={} ready={} busy={} err={:?}",
                s.online, s.paper_ok, s.ready, s.busy, s.error_code
            );
            Ok(s)
        }
        Err(e) => {
            log::warn!("fiscal_get_status failed: {e}");
            Err(e.to_string())
        }
    }
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
    let cfg = load_runtime_config(&app);
    let provider_name = runtime_config::usable_provider(&cfg).map_err(|e| e.to_string())?;
    let p = providers::build(&provider_name, &cfg).map_err(|e| e.to_string())?;
    let res = p.print_receipt(request.clone()).map_err(|e| e.to_string())?;

    // Persist on a best-effort basis — a failed write must not mask a successful
    // print. Audit §5.5: never lose a fiscal event because of local I/O.
    if let Some(dev_id) = device_id.as_deref() {
        match persist::db_path(&app) {
            Ok(path) => {
                let paired = persist::read_paired_fiscal_device(&path, dev_id)
                    .ok()
                    .flatten();
                let printer_model_default: Option<&'static str> =
                    match provider_name.as_str() {
                        "datecs_dp25" => Some("Datecs DP-25"),
                        "simulator" => Some("Simulator"),
                        _ => None,
                    };
                let pm_db = runtime_config::effective_printer_model(&cfg);
                let printer_model: Option<&str> = pm_db
                    .as_deref()
                    .or(printer_model_default);
                let serial_port = runtime_config::effective_serial_port(&cfg);
                let protocol_variant = runtime_config::effective_protocol_variant(&cfg);
                let baud_value = runtime_config::effective_baud(&cfg);
                let ctx = AttemptContext {
                    device_id: dev_id,
                    provider: &provider_name,
                    printer_model,
                    serial_port: serial_port.as_deref(),
                    baud: Some(baud_value),
                    protocol_variant: protocol_variant.as_deref(),
                    fiscal_device_id: paired,
                    raw_logging: runtime_config::effective_raw_logs(&cfg),
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
    let cfg = load_runtime_config(&app);
    let provider_name = runtime_config::usable_provider(&cfg).map_err(|e| e.to_string())?;
    let p = providers::build(&provider_name, &cfg).map_err(|e| e.to_string())?;
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
            let printer_model_default: Option<&'static str> =
                match provider_name.as_str() {
                    "datecs_dp25" => Some("Datecs DP-25 (storno)"),
                    "simulator" => Some("Simulator (storno)"),
                    _ => None,
                };
            let pm_db = runtime_config::effective_printer_model(&cfg);
            let printer_model: Option<&str> = pm_db
                .as_deref()
                .or(printer_model_default);
            let serial_port = runtime_config::effective_serial_port(&cfg);
            let protocol_variant = runtime_config::effective_protocol_variant(&cfg);
            let baud_value = runtime_config::effective_baud(&cfg);
            let ctx = AttemptContext {
                device_id: dev_id,
                provider: &provider_name,
                printer_model,
                serial_port: serial_port.as_deref(),
                baud: Some(baud_value),
                protocol_variant: protocol_variant.as_deref(),
                fiscal_device_id: paired,
                raw_logging: runtime_config::effective_raw_logs(&cfg),
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
pub fn fiscal_print_x_report(app: tauri::AppHandle) -> Result<ReceiptResponse, String> {
    let cfg = load_runtime_config(&app);
    let provider_name = runtime_config::usable_provider(&cfg).map_err(|e| e.to_string())?;
    let p = providers::build(&provider_name, &cfg).map_err(|e| e.to_string())?;
    p.print_x_report().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_open_drawer(app: tauri::AppHandle) -> Result<(), String> {
    let cfg = load_runtime_config(&app);
    let provider_name = runtime_config::usable_provider(&cfg).map_err(|e| e.to_string())?;
    let p = providers::build(&provider_name, &cfg).map_err(|e| e.to_string())?;
    p.open_cash_drawer().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_reprint_last(app: tauri::AppHandle) -> Result<ReceiptResponse, String> {
    let cfg = load_runtime_config(&app);
    let provider_name = runtime_config::usable_provider(&cfg).map_err(|e| e.to_string())?;
    let p = providers::build(&provider_name, &cfg).map_err(|e| e.to_string())?;
    p.reprint_last_receipt().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_print_periodic_memory(
    app: tauri::AppHandle,
    date_from: String,
    date_to: String,
) -> Result<ReceiptResponse, String> {
    let cfg = load_runtime_config(&app);
    let provider_name = runtime_config::usable_provider(&cfg).map_err(|e| e.to_string())?;
    let p = providers::build(&provider_name, &cfg).map_err(|e| e.to_string())?;
    p.print_periodic_memory(&date_from, &date_to)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_print_z_report(
    app: tauri::AppHandle,
    confirm_token: String,
) -> Result<ReceiptResponse, String> {
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
    let cfg = load_runtime_config(&app);
    let provider_name = runtime_config::usable_provider(&cfg).map_err(|e| e.to_string())?;
    let p = providers::build(&provider_name, &cfg).map_err(|e| e.to_string())?;
    log::info!("fiscal_print_z_report: provider={provider_name} — closing the fiscal day");
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

/// Etapa 5 (ghid casă de marcat) — async + spawn_blocking: the sweep takes
/// up to ~20 s per port and, as a plain sync command, ran on the main
/// thread (window frozen, Windows "Not responding" while "Caută casa
/// automat" walks the ports). Same body, same result, off the main thread.
#[tauri::command]
pub async fn fiscal_probe(
    app: tauri::AppHandle,
    port: Option<String>,
    baud: Option<u32>,
) -> Result<ProbeReport, String> {
    tauri::async_runtime::spawn_blocking(move || fiscal_probe_blocking(&app, port, baud))
        .await
        .map_err(|e| e.to_string())?
}

fn fiscal_probe_blocking(
    app: &tauri::AppHandle,
    port: Option<String>,
    baud: Option<u32>,
) -> Result<ProbeReport, String> {
    let cfg = load_runtime_config(app);
    let port = port
        .or_else(|| runtime_config::effective_serial_port(&cfg))
        .ok_or_else(|| "Port serial neconfigurat (Settings → Casă de marcat)".to_string())?;
    let baud = baud.unwrap_or_else(|| runtime_config::effective_baud(&cfg));
    log::info!("fiscal_probe: port={port} baud={baud} (sweep dialect × baud)");
    let report = probe_all(&port, baud);
    log::info!(
        "fiscal_probe done: tried={} all_nak_hint={} recommended_dialect={:?} recommended_baud={:?}",
        report.attempts.len(),
        report.all_nak_hint,
        report.recommended_dialect,
        report.recommended_baud,
    );
    Ok(report)
}

#[tauri::command]
pub fn fiscal_list_ports() -> Vec<String> {
    list_ports()
}

/// Same ports as `fiscal_list_ports`, with the USB product / manufacturer
/// Windows reports (the guide shows "COM4 — <produs>").
#[tauri::command]
pub fn fiscal_list_ports_detailed() -> Vec<PortDetail> {
    list_ports_detailed()
}

// ---------------------------------------------------------------------------
// „Caută casa de marcat” (2026-10-15) — see diagnostics/detect.rs.

static DETECT_RUNNING: AtomicBool = AtomicBool::new(false);
static DETECT_CANCEL: AtomicBool = AtomicBool::new(false);

/// Event with a `detect::Progress` payload, before every STATUS attempt.
pub const DETECT_PROGRESS_EVENT: &str = "fiscal-detect-progress";

struct DetectRunning;
impl Drop for DetectRunning {
    fn drop(&mut self) {
        DETECT_RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Finds the register: likely ports first (saved, Datecs, USB-serial),
/// `include_others` = the owner confirmed „Încearcă și celelalte porturi”.
/// STATUS (0x4A) only, one attempt at a time under the device lock. On
/// success (and `save` != false) writes port + baud + dialect to the
/// runtime config.
#[tauri::command]
pub async fn fiscal_detect_register(
    app: tauri::AppHandle,
    include_others: Option<bool>,
    save: Option<bool>,
) -> Result<detect::DetectReport, String> {
    if DETECT_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("Căutarea casei rulează deja.".into());
    }
    DETECT_CANCEL.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let _running = DetectRunning;
        detect_blocking(&app, include_others.unwrap_or(false), save.unwrap_or(true))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// „Oprește căutarea”: the search stops before its next attempt.
#[tauri::command]
pub fn fiscal_detect_cancel() {
    DETECT_CANCEL.store(true, Ordering::SeqCst);
}

fn detect_blocking(
    app: &tauri::AppHandle,
    include_others: bool,
    save: bool,
) -> Result<detect::DetectReport, String> {
    use tauri::Emitter;
    let cfg = load_runtime_config(app);
    let saved_port = runtime_config::effective_serial_port(&cfg);
    // The saved speed goes first only when it was really saved.
    let preferred_baud = cfg.baud.map(|b| b as u32).filter(|b| *b > 0);
    let candidates = detect::order_candidates(list_ports_detailed(), saved_port.as_deref());
    log::info!(
        "fiscal_detect: {} port(s), include_others={include_others}: {}",
        candidates.len(),
        candidates
            .iter()
            .map(|c| format!("{}={:?}", c.port.name, c.class))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let mut prober = detect::SerialProber;
    let mut report = detect::run_search(
        &candidates,
        include_others,
        preferred_baud,
        &mut prober,
        &mut |p| {
            let _ = app.emit(DETECT_PROGRESS_EVENT, p);
        },
        &|| DETECT_CANCEL.load(Ordering::SeqCst),
    );
    match report.found.as_ref() {
        Some(f) => {
            log::info!(
                "fiscal_detect: register on {} baud={} dialect={} vid={:?} pid={:?} product={:?} manufacturer={:?}",
                f.port, f.baud, f.dialect,
                f.vid.map(|v| format!("{v:04X}")), f.pid.map(|v| format!("{v:04X}")),
                f.product, f.manufacturer,
            );
            if save {
                let mut next = cfg.clone();
                next.serial_port = Some(f.port.clone());
                next.baud = Some(f.baud as i64);
                next.protocol_variant = Some(f.dialect.clone());
                let real = matches!(next.provider.as_deref(), Some("datecs_dp25") | Some("datecs_fp"));
                if !real {
                    next.provider = Some("datecs_dp25".into());
                    if next.printer_model.as_deref().map(str::trim).unwrap_or("").is_empty() {
                        next.printer_model = Some("Datecs DP-25X".into());
                    }
                }
                next.use_rust = Some(true);
                match persist::db_path(app)
                    .map_err(|e| e.to_string())
                    .and_then(|p| runtime_config::write(&p, &next).map_err(|e| e.to_string()))
                {
                    Ok(()) => report.saved = true,
                    Err(e) => {
                        log::error!("fiscal_detect: saving the found port failed: {e}");
                        report.save_error = Some(e);
                    }
                }
            }
        }
        None => log::info!(
            "fiscal_detect: no register (tried={} not_tried={} excluded={} cancelled={})",
            report.tried.len(),
            report.not_tried.len(),
            report.excluded.len(),
            report.cancelled
        ),
    }
    Ok(report)
}

/// Shows the operator + password the Rust side would actually use right now,
/// plus the exact bytes it would put on the open_fiscal payload. No serial
/// I/O — pure read of the runtime config + a build_open_fiscal call. Lets
/// the operator confirm "what I typed in the UI = what the wire would see".
#[derive(serde::Serialize)]
pub struct FiscalDebugCreds {
    pub provider_name: String,
    pub operator: String,
    pub operator_password: String,
    pub operator_password_length: usize,
    pub open_fiscal_payload_text: String,
    pub open_fiscal_payload_hex: String,
}

#[tauri::command]
pub fn fiscal_debug_credentials(app: tauri::AppHandle) -> Result<FiscalDebugCreds, String> {
    let cfg = load_runtime_config(&app);
    let provider_name = runtime_config::effective_provider(&cfg);
    let operator = runtime_config::effective_operator(&cfg);
    let password = runtime_config::effective_operator_password(&cfg);
    let payload_text = format!("{}\t{}\t1", operator, password);
    let payload_bytes = payload_text.as_bytes();
    let payload_hex = payload_bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(" ");
    log::info!(
        "fiscal_debug_credentials: provider={} operator='{}' password='{}' (length={})",
        provider_name,
        operator,
        password,
        password.chars().count(),
    );
    Ok(FiscalDebugCreds {
        provider_name,
        operator,
        operator_password: password.clone(),
        operator_password_length: password.chars().count(),
        open_fiscal_payload_text: payload_text.replace('\t', "\\t"),
        open_fiscal_payload_hex: payload_hex,
    })
}

/// Raw debug — open the port at the configured baud, send a STATUS (0x4A)
/// frame in BOTH FP-55 and FP-700 dialects, log every byte received as hex.
/// Lets us see what the register actually says when the high-level decode
/// reports "device NAK" — sometimes the byte is not 0x15 at all.
#[derive(serde::Serialize)]
pub struct RawDebugResult {
    pub dialect: String,
    pub baud: u32,
    pub frame_sent_hex: String,
    pub bytes_received_hex: String,
    pub byte_count: usize,
    pub interpretation: String,
}

#[tauri::command]
pub fn fiscal_raw_debug(app: tauri::AppHandle) -> Result<Vec<RawDebugResult>, String> {
    use serialport::SerialPort;
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};

    let cfg = load_runtime_config(&app);
    let port_name = runtime_config::effective_serial_port(&cfg)
        .ok_or_else(|| "Port serial neconfigurat".to_string())?;
    let baud = runtime_config::effective_baud(&cfg);

    let mut results: Vec<RawDebugResult> = Vec::new();

    for dialect in &["dp25x", "fp700"] {
        let frame = build_status_frame(dialect);
        let frame_hex = hex_dump(&frame);
        let mut bytes = Vec::<u8>::new();
        let interp;
        // Same device lock as every provider call (no interleaving).
        let _device = providers::device_lock();

        let opened: Result<Box<dyn SerialPort>, _> = serialport::new(&port_name, baud)
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .flow_control(serialport::FlowControl::None)
            .timeout(Duration::from_millis(200))
            .open();
        match opened {
            Err(e) => {
                interp = format!("open serial failed: {e}");
            }
            Ok(mut sp) => {
                if let Err(e) = sp.write_all(&frame) {
                    interp = format!("write failed: {e}");
                } else {
                    let deadline = Instant::now() + Duration::from_millis(2000);
                    let mut buf = [0u8; 1];
                    while Instant::now() < deadline {
                        match sp.read(&mut buf) {
                            Ok(0) => continue,
                            Ok(_) => bytes.push(buf[0]),
                            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                            Err(e) => {
                                log::warn!("raw_debug read err: {e}");
                                break;
                            }
                        }
                    }
                    interp = interpret_response(&bytes);
                }
                drop(sp);
            }
        }
        results.push(RawDebugResult {
            dialect: (*dialect).into(),
            baud,
            frame_sent_hex: frame_hex,
            bytes_received_hex: hex_dump(&bytes),
            byte_count: bytes.len(),
            interpretation: interp,
        });
    }

    Ok(results)
}

fn build_status_frame(dialect: &str) -> Vec<u8> {
    // dp25x  → DUDE-confirmed: offset 0x30, BCC = SUM over LEN..POST,
    //          CMD = 4 nibbles, LEN = body_len + 4 (LEN field included).
    // fp700  → legacy fallback: offset 0x30, BCC = XOR over body, CMD raw byte.
    let offset: u8 = 0x30;
    let xor: bool = dialect == "fp700";
    let cmd_width_4: bool = dialect != "fp700";
    let bcc_includes_len: bool = dialect == "dp25x";
    let seq: u8 = 0x20;
    let cmd: u16 = 0x4A;

    let cmd_bytes: Vec<u8> = if cmd_width_4 {
        vec![
            offset + ((cmd >> 12) & 0xF) as u8,
            offset + ((cmd >> 8) & 0xF) as u8,
            offset + ((cmd >> 4) & 0xF) as u8,
            offset + (cmd & 0xF) as u8,
        ]
    } else {
        vec![cmd as u8]
    };

    let mut body: Vec<u8> = Vec::new();
    body.push(seq);
    body.extend_from_slice(&cmd_bytes);
    body.push(0x05); // POST

    // LEN value = body_len + 0x24 (DP-25X firmware quirk, see transport).
    let len_val: u16 = (body.len() as u16) + 0x24;
    let length_enc: [u8; 4] = [
        offset + ((len_val >> 12) & 0xF) as u8,
        offset + ((len_val >> 8) & 0xF) as u8,
        offset + ((len_val >> 4) & 0xF) as u8,
        offset + (len_val & 0xF) as u8,
    ];

    // BCC coverage:
    //   dp25x → LEN..POST (length field included in the sum)
    //   fp700 → body only (legacy)
    let bcc_target: Vec<u8> = if bcc_includes_len {
        let mut v = length_enc.to_vec();
        v.extend_from_slice(&body);
        v
    } else {
        body.clone()
    };
    let bcc_value: u32 = if xor {
        bcc_target.iter().fold(0u32, |acc, b| acc ^ (*b as u32))
    } else {
        bcc_target.iter().map(|b| *b as u32).sum::<u32>() & 0xFFFF
    };
    let bcc_enc: [u8; 4] = [
        offset + ((bcc_value >> 12) & 0xF) as u8,
        offset + ((bcc_value >> 8) & 0xF) as u8,
        offset + ((bcc_value >> 4) & 0xF) as u8,
        offset + (bcc_value & 0xF) as u8,
    ];

    let mut frame: Vec<u8> = Vec::new();
    frame.push(0x01); // STX
    frame.extend_from_slice(&length_enc);
    frame.extend_from_slice(&body);
    frame.extend_from_slice(&bcc_enc);
    frame.push(0x03); // ETX
    frame
}

fn hex_dump(bytes: &[u8]) -> String {
    let mut s = String::new();
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        s.push_str(&format!("{:02X}", b));
    }
    s
}

fn interpret_response(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "no bytes received (timeout)".into();
    }
    let first = bytes[0];
    let label = match first {
        0x06 => "ACK",
        0x15 => "NAK",
        0x16 => "SYN (busy)",
        0x01 => "STX (start of frame)",
        0x03 => "ETX",
        _ => "unknown",
    };
    format!(
        "first byte: 0x{:02X} = {}; total {} bytes",
        first, label, bytes.len()
    )
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
    // Persist the bundle so the next app launch can re-attach the WSS
    // loop without forcing the operator to generate a fresh enrollment
    // code. Best-effort — write failures are logged but not fatal.
    if let Ok(path) = persist::db_path(&app) {
        let creds = BridgeCredentials {
            server_base_url: server_base_url.clone(),
            websocket_url: response.websocket_url.clone(),
            device_token: response.device_token.clone(),
            bridge_id: response.bridge_id.clone(),
            tenant_id: response.tenant_id.clone(),
            printer_model: Some(printer_model.clone()),
            device_id: device_id.clone(),
            claimed_at: None,
            updated_at: None,
        };
        if let Err(e) = credentials::write(&path, &creds) {
            log::warn!("persist fiscal_bridge_credentials failed: {e}");
        } else {
            log::info!(
                "fiscal_bridge_credentials persisted: bridge_id={} tenant_id={}",
                response.bridge_id, response.tenant_id
            );
        }
    }
    // B11 — auto-pair on a successful claim. Mirrors the audit Q2 1:1:1
    // rule: once the desktop owns this `bridge_id`, that's the fiscal device
    // for this station until the admin explicitly unpairs. Writes are
    // best-effort — pairing failure must not retract the claim.
    if let Some(dev_id) = device_id.as_deref() {
        match persist::db_path(&app) {
            Ok(path) => {
                let cfg = load_runtime_config(&app);
                let row = StationPairingRow {
                    device_id: dev_id.to_string(),
                    fiscal_device_id: Some(response.bridge_id.clone()),
                    payment_terminal_id: None,
                    fiscal_provider: Some(runtime_config::effective_provider(&cfg)),
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
pub fn fiscal_get_saved_bridge_credentials(
    app: tauri::AppHandle,
) -> Result<Option<BridgeCredentials>, String> {
    let path = persist::db_path(&app).map_err(|e| e.to_string())?;
    credentials::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fiscal_clear_saved_bridge_credentials(
    app: tauri::AppHandle,
) -> Result<(), String> {
    let path = persist::db_path(&app).map_err(|e| e.to_string())?;
    credentials::clear(&path).map_err(|e| e.to_string())
}

// 2026-10-14 — the running WSS loop, so new credentials REPLACE it instead
// of being ignored (the old loop kept the revoked token, failed 3× with 403
// and the supervisor then refused to restart: agent dead until a restart).
struct RunningLoop {
    generation: u64,
    websocket_url: String,
    token_hash: u64,
    stop: tokio::sync::watch::Sender<bool>,
}

static RUNNING: Mutex<Option<RunningLoop>> = Mutex::new(None);
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn is_current_loop(generation: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) == generation
}

/// Token fingerprint of the loop currently started (None before any).
pub fn running_token_hash() -> Option<u64> {
    RUNNING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|r| r.token_hash)
}

/// Clears `configured` when the loop thread ends for ANY reason — normal
/// exit, error, or a panic (before this, a panic left `configured = true`
/// forever: the supervisor and "Reconectează" never started anything again
/// and nothing reached the log). A replaced loop leaves the state alone.
struct LoopGuard {
    state: SharedState,
    generation: u64,
}

impl Drop for LoopGuard {
    fn drop(&mut self) {
        let panicking = std::thread::panicking();
        if panicking {
            log::error!(
                "bridge: WSS loop thread panicked (generation {}) — the supervisor will restart it",
                self.generation
            );
        }
        if !is_current_loop(self.generation) {
            return;
        }
        {
            let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            s.configured = false;
            s.connected = false;
            s.stopped_at = Some(crate::fiscal::bridge_client::state::now_unix());
            if panicking {
                s.last_error = Some("agentul fiscal s-a oprit neașteptat (panic) — vezi jurnalul".into());
            }
        }
        self.state.clear_poison();
    }
}

#[tauri::command]
pub fn fiscal_bridge_run(
    app: tauri::AppHandle,
    websocket_url: String,
    device_token: String,
    printer_model: String,
) -> Result<(), String> {
    let state = shared_state();
    let th = crate::fiscal::bridge_client::state::token_hash(&device_token);
    let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    let alive = state
        .lock()
        .map(|s| s.configured)
        .unwrap_or_else(|e| e.into_inner().configured);
    if let Some(r) = running.as_ref() {
        if alive && r.token_hash == th && r.websocket_url == websocket_url {
            // Same credentials, loop up: nothing to do (two loops on one
            // token = "replaced by another bridge" flapping on the server).
            log::info!(
                "fiscal_bridge_run: loop already running with these credentials (generation {}) — nothing to do",
                r.generation
            );
            return Ok(());
        }
        if alive {
            log::info!(
                "fiscal_bridge_run: new credentials — stopping loop generation {} and starting a new one",
                r.generation
            );
        }
        let _ = r.stop.send(true);
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    *running = Some(RunningLoop {
        generation,
        websocket_url: websocket_url.clone(),
        token_hash: th,
        stop: stop_tx,
    });
    drop(running);
    {
        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
        s.configured = true;
        s.connected = false;
        s.stopped_at = None;
        s.close_code = None;
        s.last_error = None;
        s.revoked = false;
        s.revoked_token_hash = None;
    }
    let db_path = persist::db_path(&app).ok();
    let cfg = WsClientConfig {
        websocket_url,
        device_token,
        printer_model,
        db_path,
    };
    let st = state.clone();
    log::info!("fiscal_bridge_run: starting WSS loop generation {generation}");
    // Spawn a tokio runtime on a dedicated thread so the WSS loop survives
    // outside Tauri's command futures (commands return immediately; the loop
    // keeps reconnecting until shutdown or until new credentials replace it).
    let spawned = std::thread::Builder::new()
        .name(format!("pos-fiscal-wss-{generation}"))
        .spawn(move || {
            let _guard = LoopGuard {
                state: st.clone(),
                generation,
            };
            let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!("bridge: tokio runtime failed: {e}");
                    if let Ok(mut s) = st.lock() {
                        s.last_error = Some(format!("tokio runtime: {e}"));
                    }
                    return;
                }
            };
            let st_loop = st.clone();
            rt.block_on(async move {
                if let Err(e) = run_forever(cfg, st_loop.clone(), stop_rx).await {
                    log::error!("bridge: terminated with error: {e}");
                    if is_current_loop(generation) {
                        if let Ok(mut s) = st_loop.lock() {
                            s.connected = false;
                            s.last_error = Some(e.to_string());
                        }
                    }
                }
            });
            // `_guard` drops here: `configured = false` (if still current)
            // so the agent supervisor in `shell::agent` can start it again.
        });
    if let Err(e) = spawned {
        log::error!("fiscal_bridge_run: thread spawn failed: {e}");
        if is_current_loop(generation) {
            let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
            s.configured = false;
            s.last_error = Some(format!("thread spawn: {e}"));
        }
        return Err(e.to_string());
    }
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
