// WSS loop — port of fiscal-bridge/bridge/ws_client.py.
// Backend wire format (unchanged):
//
//   client → server : {"type":"hello", ...}
//   server → client : {"type":"welcome", "bridge_id":"..."}
//   server → client : {"type":"config",  "protocol": {...}}     # cmd_codes etc.
//   client → server : {"type":"heartbeat"}                      # every 15s
//   server → client : {"type":"heartbeat_ack"}
//   server → client : {"type":"job", "job_id":"...", "kind":"print_receipt", "payload": {...}}
//   client → server : {"type":"job_result", "job_id":"...", "success":bool, "data":{...}, "error":null}
//
// Reconnect rules:
//   * close 4000 (replaced by another bridge) → exit (same as Python).
//   * 401/403 (token revoked) → exit after 3 failures.
//   * else: capped exponential backoff up to 60s.
//   * the `stop` channel ends the loop at once (new credentials replace it).
//
// 2026-10-14 („o singură cale”):
//   * `connected` is set on `welcome` (the server registered us), not after
//     sending `hello`;
//   * hello announces `capabilities: ["dedupe_mutation_id"]` — print and
//     storno jobs go through `agent_journal`, so a repeated mutation_id
//     returns the stored result instead of printing a second bon;
//   * jobs refuse the simulator / an unconfigured station and `test_mode`
//     unless this build allows the simulator (debug or demo build).

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;

use crate::fiscal::agent_journal::{self, Begin};
use crate::fiscal::bridge_client::state::{now_unix, token_hash, SharedState};
use crate::fiscal::dto::{ReceiptRequest, ReceiptResponse};
use crate::fiscal::error::FiscalError;
use crate::fiscal::providers;
use crate::fiscal::runtime_config::{self, RuntimeConfig};

pub struct WsClientConfig {
    pub websocket_url: String,
    pub device_token: String,
    pub printer_model: String,
    /// Path to the SQLite store so WSS-driven jobs read the same
    /// `fiscal_runtime_config` row the UI writes. None falls back to
    /// env-only resolution (parity with the pre-Sprint-3 behavior).
    pub db_path: Option<std::path::PathBuf>,
}

impl WsClientConfig {
    /// `fiscal-agent-journal.db`, next to the app database.
    fn journal_path(&self) -> Option<std::path::PathBuf> {
        self.db_path
            .as_ref()
            .and_then(|p| p.parent().map(|d| d.join(agent_journal::FILE_NAME)))
    }
}

/// What this agent can do beyond the base protocol (sent in `hello`).
pub const CAPABILITIES: &[&str] = &["dedupe_mutation_id"];

pub async fn run_forever(
    cfg: WsClientConfig,
    state: SharedState,
    mut stop: watch::Receiver<bool>,
) -> Result<(), FiscalError> {
    let mut backoff = Duration::from_secs(1);
    let mut auth_fail = 0u32;
    loop {
        if *stop.borrow() {
            log::info!("bridge: loop stopped before connecting");
            return Ok(());
        }
        let outcome = tokio::select! {
            r = run_once(&cfg, &state) => r,
            _ = stop.changed() => {
                log::info!("bridge: loop replaced/stopped — closing this connection");
                return Ok(());
            }
        };
        match outcome {
            Ok(_) => {
                backoff = Duration::from_secs(1);
                auth_fail = 0;
            }
            Err(WsExit::Replaced) => {
                log::warn!("bridge: replaced by another connection (close 4000) — exiting");
                if let Ok(mut s) = state.lock() {
                    s.connected = false;
                    s.close_code = Some(4000);
                    s.last_error = Some("replaced by another bridge".into());
                }
                return Ok(());
            }
            Err(WsExit::AuthRevoked(code)) => {
                auth_fail += 1;
                log::error!("bridge: auth rejected (HTTP {code}) — fail #{auth_fail}");
                if let Ok(mut s) = state.lock() {
                    s.connected = false;
                    s.last_error = Some(format!("auth rejected HTTP {code}"));
                    s.revoked = true;
                    s.revoked_token_hash = Some(token_hash(&cfg.device_token));
                }
                if auth_fail >= 3 {
                    return Err(FiscalError::ConfigurationError {
                        detail: "device_token revoked — re-enroll required".into(),
                    });
                }
            }
            Err(WsExit::Transient(detail)) => {
                log::warn!("bridge: transient error: {detail} — retrying in {:?}", backoff);
                if let Ok(mut s) = state.lock() {
                    s.connected = false;
                    s.last_error = Some(detail);
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = stop.changed() => {
                log::info!("bridge: loop replaced/stopped during backoff");
                return Ok(());
            }
        }
        backoff = (backoff * 17 / 10).min(Duration::from_secs(60));
    }
}

enum WsExit {
    Replaced,
    AuthRevoked(u16),
    Transient(String),
}

async fn run_once(cfg: &WsClientConfig, state: &SharedState) -> Result<(), WsExit> {
    let url = format!("{}?token={}", cfg.websocket_url, urlenc(&cfg.device_token));
    log::info!("bridge: connecting to {}", cfg.websocket_url);

    let (ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| classify_connect_error(e))?;

    let (mut write, mut read) = ws.split();

    // hello
    let hello = json!({
        "type": "hello",
        "version": env!("CARGO_PKG_VERSION"),
        "printer_model": cfg.printer_model,
        "os_info": format!("{} (pos-desktop rust)", std::env::consts::OS),
        // C13 — re-declares the runtime on every reconnect so a row that
        // existed before the migration can self-correct without an admin
        // touching the DB.
        "agent_type": crate::fiscal::bridge_client::claim::AGENT_TYPE,
        "capabilities": CAPABILITIES,
    });
    write
        .send(Message::Text(hello.to_string()))
        .await
        .map_err(|e| WsExit::Transient(format!("send hello: {e}")))?;

    // `connected` waits for the server's `welcome` (see handle_message).
    if let Ok(mut s) = state.lock() {
        s.printer_model = Some(cfg.printer_model.clone());
    }

    // heartbeat task — every 15s, mirrors ws_client.py:_heartbeat_loop.
    let (hb_tx, mut hb_rx) = mpsc::channel::<()>(1);
    let hb_state = state.clone();
    let hb_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(15)) => {
                    if hb_tx.send(()).await.is_err() { break; }
                    if let Ok(mut s) = hb_state.lock() {
                        s.last_heartbeat_at = Some(now_unix());
                    }
                }
            }
        }
    });

    loop {
        tokio::select! {
            _ = hb_rx.recv() => {
                if write.send(Message::Text(json!({"type":"heartbeat"}).to_string())).await.is_err() {
                    break;
                }
            }
            msg = read.next() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => { hb_handle.abort();
                        return Err(WsExit::Transient(format!("read: {e}"))); }
                    None => { hb_handle.abort(); break; }
                };
                if let Message::Close(close_frame) = &msg {
                    let code = close_frame.as_ref().map(|c| u16::from(c.code));
                    hb_handle.abort();
                    return match code {
                        Some(4000) => Err(WsExit::Replaced),
                        Some(c) if c == 4001 || c == 4403 => Err(WsExit::AuthRevoked(c)),
                        Some(c) => Err(WsExit::Transient(format!("server close {c}"))),
                        None => Err(WsExit::Transient("server close (no code)".into())),
                    };
                }
                if let Message::Text(raw) = msg {
                    if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                        if let Err(e) = handle_message(&mut write, &parsed, cfg, state).await {
                            hb_handle.abort();
                            return Err(WsExit::Transient(format!("handle: {e}")));
                        }
                    }
                }
            }
        }
    }
    hb_handle.abort();
    Err(WsExit::Transient("connection closed".into()))
}

async fn handle_message<W>(
    write: &mut W,
    msg: &Value,
    cfg: &WsClientConfig,
    state: &SharedState,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    W: SinkExt<Message> + Unpin + Send,
    <W as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let mtype = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match mtype {
        "welcome" => {
            log::info!("bridge: welcomed bridge_id={:?}", msg.get("bridge_id"));
            if let Ok(mut s) = state.lock() {
                s.connected = true;
                s.last_error = None;
                s.close_code = None;
                s.revoked = false;
                s.revoked_token_hash = None;
                s.last_heartbeat_at = Some(now_unix());
            }
        }
        "config" => {
            // Server-pushed protocol config. Sprint 1 logs it; the Datecs
            // provider already accepts cmd_codes from config — wiring the
            // hot-reload path lands in Sprint 2 (audit Q9).
            log::info!("bridge: server config push: {}", msg.get("protocol").unwrap_or(&Value::Null));
        }
        "heartbeat_ack" => {}
        "job" => {
            let job_id = msg.get("job_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let kind = msg.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            log::info!("bridge: job {job_id} kind={kind} mutation={:?}", msg.get("mutation_id"));
            let result = run_job(kind, msg.get("payload").cloned().unwrap_or(Value::Null), cfg);
            if let Err(e) = &result {
                log::warn!("bridge: job {job_id} kind={kind} failed: {e}");
            }
            let result_msg = match result {
                Ok(payload) => json!({
                    "type": "job_result",
                    "job_id": job_id,
                    "success": true,
                    "data": payload,
                    "error": null,
                }),
                Err(e) => json!({
                    "type": "job_result",
                    "job_id": job_id,
                    "success": false,
                    "data": {},
                    "error": e.to_string(),
                }),
            };
            write.send(Message::Text(result_msg.to_string())).await?;
        }
        "error" => {
            log::warn!("bridge: server error message: {:?}", msg.get("error"));
        }
        _ => {
            log::debug!("bridge: unknown message type {mtype}");
        }
    }
    Ok(())
}

fn run_job(kind: &str, payload: Value, cfg: &WsClientConfig) -> Result<Value, FiscalError> {
    // Tenant-side test_mode: the backend stamps `test_mode:true` when the
    // tenant is a demo (bridge_agent.py::_wrap_payload). It answers TEST-…
    // without touching COM — so it is honoured only on a build that allows
    // the simulator (debug/demo), never on the tenant installer.
    let test_mode = payload
        .get("test_mode")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if test_mode {
        if !runtime_config::simulator_allowed() {
            return Err(FiscalError::ConfigurationError {
                detail: "Modul de test nu e permis pe această stație: bonul nu s-a tipărit. \
                         Cere echipei 360booking să oprească modul de test."
                    .into(),
            });
        }
        return run_job_simulated(kind, &payload);
    }
    match kind {
        "print_receipt" | "cancel_receipt" => run_deduped(kind, payload, cfg),
        _ => run_on_device(kind, payload, cfg),
    }
}

/// Print / storno with the dedupe journal: one mutation_id ⇒ at most one
/// bon on paper, whatever the server re-sends after a timeout.
fn run_deduped(kind: &str, payload: Value, cfg: &WsClientConfig) -> Result<Value, FiscalError> {
    let mutation_id = payload
        .get("mutation_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let journal = if mutation_id.is_empty() {
        None
    } else {
        cfg.journal_path().and_then(|p| match agent_journal::open(&p) {
            Ok(c) => Some(c),
            Err(e) => {
                log::warn!("bridge: dedupe journal unavailable ({e}) — printing without it");
                None
            }
        })
    };
    if let Some(conn) = journal.as_ref() {
        match agent_journal::begin(conn, &mutation_id, kind) {
            Ok(Begin::AlreadyPrinted(mut stored)) => {
                log::info!("bridge: {kind} {mutation_id} already printed — returning the stored result, not printing again");
                if let Some(o) = stored.as_object_mut() {
                    o.insert("deduplicated".into(), Value::Bool(true));
                }
                return Ok(stored);
            }
            Ok(Begin::Unknown) => {
                log::warn!("bridge: {kind} {mutation_id} was interrupted while printing — not reprinting");
                return Err(FiscalError::UnknownFiscalError {
                    detail: "Bonul acestei note a început să se tipărească, dar aplicația nu a primit răspunsul casei \
                             (oprire în timpul tipăririi). Verifică rola de hârtie — nu îl retipăresc automat."
                        .into(),
                });
            }
            Ok(Begin::Proceed) => {}
            Err(e) => log::warn!("bridge: dedupe journal begin failed ({e}) — printing without it"),
        }
    }
    let outcome = run_on_device(kind, payload, cfg);
    if let Some(conn) = journal.as_ref() {
        let r = match &outcome {
            Ok(v) => agent_journal::finish_ok(conn, &mutation_id, v),
            Err(e) => agent_journal::finish_err(conn, &mutation_id, &e.to_string()),
        };
        if let Err(e) = r {
            log::warn!("bridge: dedupe journal finish failed for {mutation_id}: {e}");
        }
    }
    outcome
}

fn run_on_device(kind: &str, payload: Value, cfg: &WsClientConfig) -> Result<Value, FiscalError> {
    let runtime_cfg: RuntimeConfig = cfg
        .db_path
        .as_deref()
        .and_then(|p| runtime_config::read(p).ok())
        .unwrap_or_default();
    // Refuses the simulator / an unconfigured station on the tenant build:
    // "printed" without a register is never an answer.
    let provider_name = runtime_config::usable_provider(&runtime_cfg)?;
    let provider = providers::build(&provider_name, &runtime_cfg)?;
    match kind {
        "test_print" => {
            let r = provider.test_connection()?;
            Ok(json!({"ok": r.ok, "detail": r.detail}))
        }
        "print_receipt" => {
            let req: ReceiptRequest = serde_json::from_value(payload).map_err(|e| {
                FiscalError::InvalidCommand { detail: format!("bad payload: {e}") }
            })?;
            let r: ReceiptResponse = provider.print_receipt(req)?;
            Ok(serde_json::to_value(&r).unwrap_or(Value::Null))
        }
        "cancel_receipt" => {
            let req: crate::fiscal::dto::CancelReceiptRequest =
                serde_json::from_value(payload).map_err(|e| {
                    FiscalError::InvalidCommand { detail: format!("bad payload: {e}") }
                })?;
            let r: ReceiptResponse = provider.cancel_receipt(req)?;
            Ok(serde_json::to_value(&r).unwrap_or(Value::Null))
        }
        "x_report" => {
            let r: ReceiptResponse = provider.print_x_report()?;
            Ok(serde_json::to_value(&r).unwrap_or(Value::Null))
        }
        "z_report" => {
            // Backend may pass {confirm_token} or empty payload. Accept both:
            // pilot rollout uses empty payload (server-side gate is the only
            // gate); a future Sprint can move the gate into the agent itself.
            let confirm_token = payload
                .get("confirm_token")
                .and_then(|v| v.as_str())
                .unwrap_or("server-gated");
            let r: ReceiptResponse = provider.print_z_report(confirm_token)?;
            Ok(serde_json::to_value(&r).unwrap_or(Value::Null))
        }
        "open_drawer" => {
            provider.open_cash_drawer()?;
            Ok(json!({"ok": true}))
        }
        "reprint_last" => {
            let r: ReceiptResponse = provider.reprint_last_receipt()?;
            Ok(serde_json::to_value(&r).unwrap_or(Value::Null))
        }
        "periodic_memory" => {
            let date_from = payload
                .get("date_from")
                .and_then(|v| v.as_str())
                .ok_or_else(|| FiscalError::InvalidCommand {
                    detail: "periodic_memory: missing date_from".into(),
                })?;
            let date_to = payload
                .get("date_to")
                .and_then(|v| v.as_str())
                .ok_or_else(|| FiscalError::InvalidCommand {
                    detail: "periodic_memory: missing date_to".into(),
                })?;
            let r: ReceiptResponse = provider.print_periodic_memory(date_from, date_to)?;
            Ok(serde_json::to_value(&r).unwrap_or(Value::Null))
        }
        other => Err(FiscalError::InvalidCommand {
            detail: format!("unknown job kind: {other}"),
        }),
    }
}

/// Synthesize a successful response without touching the printer. Mirrors
/// the shape the real provider returns so the backend's BridgeAgentDriver
/// can deserialize without special-casing test mode. The fake fiscal
/// number carries a TEST- prefix so an operator skimming `fiscal_receipts`
/// can spot test rows immediately.
fn run_job_simulated(kind: &str, payload: &Value) -> Result<Value, FiscalError> {
    use crate::fiscal::dto::{ReceiptResponse, ReceiptStatus};
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let fake_bf = format!("TEST-{secs}");
    let now = format!("@unix:{secs}");
    match kind {
        "test_print" => Ok(serde_json::json!({"ok": true, "detail": "test_mode — no COM I/O"})),
        "open_drawer" => Ok(serde_json::json!({"ok": true})),
        "print_receipt" | "x_report" | "z_report" | "reprint_last" | "cancel_receipt"
        | "periodic_memory" => {
            let trace = format!("test_mode {kind} payload={}", payload);
            let resp = ReceiptResponse {
                status: ReceiptStatus::Printed,
                fiscal_number: Some(fake_bf),
                fiscal_date: Some(now),
                raw_trace: trace,
                error_code: None,
                error_message: None,
            };
            Ok(serde_json::to_value(&resp).unwrap_or(Value::Null))
        }
        other => Err(FiscalError::InvalidCommand {
            detail: format!("unknown job kind (test_mode): {other}"),
        }),
    }
}

fn urlenc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

fn classify_connect_error(e: tokio_tungstenite::tungstenite::Error) -> WsExit {
    use tokio_tungstenite::tungstenite::http::StatusCode;
    use tokio_tungstenite::tungstenite::Error as TE;
    match e {
        TE::Http(resp) => {
            let code = resp.status();
            if code == StatusCode::UNAUTHORIZED || code == StatusCode::FORBIDDEN {
                WsExit::AuthRevoked(code.as_u16())
            } else {
                WsExit::Transient(format!("HTTP {code}"))
            }
        }
        other => WsExit::Transient(other.to_string()),
    }
}

// Quiet unused-import warnings if the compiler decides CloseCode isn't needed
// directly (pulled in for symmetry with the Python flap fix).
#[allow(dead_code)]
fn _unused_close_code(_: CloseCode) {}

#[cfg(test)]
mod dedupe_tests {
    use super::*;

    fn cfg_in(dir: &std::path::Path) -> WsClientConfig {
        WsClientConfig {
            websocket_url: "wss://example.invalid/api/fiscal-bridge/agent".into(),
            device_token: "t".into(),
            printer_model: "simulator".into(),
            // Not created: runtime_config::read → defaults → simulator,
            // which debug builds (cargo test) allow.
            db_path: Some(dir.join("pos-desktop.db")),
        }
    }

    fn receipt(mutation_id: &str) -> Value {
        json!({
            "mutation_id": mutation_id,
            "order_local_id": "o-1",
            "fiscal_attempt_id": mutation_id,
            "items": [{"name": "Bere", "quantity": 1.0, "unit_price": 12.0, "vat_rate": 0.21}],
            "payments": [{"method": "cash", "amount": 12.0}],
            "currency": "RON",
        })
    }

    #[test]
    fn repeated_mutation_returns_stored_result_without_printing_again() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = cfg_in(dir.path());
        let first = run_job("print_receipt", receipt("order-42"), &cfg).unwrap();
        assert!(first.get("deduplicated").is_none());
        let second = run_job("print_receipt", receipt("order-42"), &cfg).unwrap();
        assert_eq!(second.get("deduplicated"), Some(&Value::Bool(true)));
        assert_eq!(second.get("fiscal_number"), first.get("fiscal_number"));
        // A different order prints normally.
        let other = run_job("print_receipt", receipt("order-43"), &cfg).unwrap();
        assert!(other.get("deduplicated").is_none());
    }

    #[test]
    fn interrupted_print_is_not_reprinted() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = cfg_in(dir.path());
        let conn = agent_journal::open(&cfg.journal_path().unwrap()).unwrap();
        assert_eq!(agent_journal::begin(&conn, "order-7", "print_receipt").unwrap(), Begin::Proceed);
        drop(conn); // "crash" before finish
        let err = run_job("print_receipt", receipt("order-7"), &cfg).unwrap_err();
        assert!(matches!(err, FiscalError::UnknownFiscalError { .. }));
    }

    #[test]
    fn capabilities_announce_dedupe() {
        assert!(CAPABILITIES.contains(&"dedupe_mutation_id"));
    }
}
