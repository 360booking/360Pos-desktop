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
    let provider_name = runtime_config::effective_provider(&cfg);
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
    let provider_name = runtime_config::effective_provider(&cfg);
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
    let provider_name = runtime_config::effective_provider(&cfg);
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
    let provider_name = runtime_config::effective_provider(&cfg);
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
    let provider_name = runtime_config::effective_provider(&cfg);
    let p = providers::build(&provider_name, &cfg).map_err(|e| e.to_string())?;
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
pub fn fiscal_probe(
    app: tauri::AppHandle,
    port: Option<String>,
    baud: Option<u32>,
) -> Result<ProbeReport, String> {
    let cfg = load_runtime_config(&app);
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

    for dialect in &["fp55", "fp700"] {
        let frame = build_status_frame(dialect);
        let frame_hex = hex_dump(&frame);
        let mut bytes = Vec::<u8>::new();
        let interp;

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
    let offset: u8 = if dialect == "fp700" { 0x30 } else { 0x20 };
    let xor: bool = dialect == "fp700";
    let cmd_width_4: bool = dialect != "fp700";
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

    let len_val: u16 = body.len() as u16;
    let length_enc: [u8; 4] = [
        offset + ((len_val >> 12) & 0xF) as u8,
        offset + ((len_val >> 8) & 0xF) as u8,
        offset + ((len_val >> 4) & 0xF) as u8,
        offset + (len_val & 0xF) as u8,
    ];

    let bcc_value: u32 = if xor {
        body.iter().fold(0u32, |acc, b| acc ^ (*b as u32))
    } else {
        body.iter().map(|b| *b as u32).sum::<u32>() & 0xFFFF
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
pub fn fiscal_bridge_run(
    app: tauri::AppHandle,
    websocket_url: String,
    device_token: String,
    printer_model: String,
) -> Result<(), String> {
    let state = shared_state();
    if let Ok(mut s) = state.lock() {
        s.configured = true;
    }
    let db_path = persist::db_path(&app).ok();
    let cfg = WsClientConfig {
        websocket_url,
        device_token,
        printer_model,
        db_path,
    };
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
