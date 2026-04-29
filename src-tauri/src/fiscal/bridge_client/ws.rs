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

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;

use crate::fiscal::bridge_client::state::{now_unix, SharedState};
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

pub async fn run_forever(cfg: WsClientConfig, state: SharedState) -> Result<(), FiscalError> {
    let mut backoff = Duration::from_secs(1);
    let mut auth_fail = 0u32;
    loop {
        match run_once(&cfg, &state).await {
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
        tokio::time::sleep(backoff).await;
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
    });
    write
        .send(Message::Text(hello.to_string()))
        .await
        .map_err(|e| WsExit::Transient(format!("send hello: {e}")))?;

    if let Ok(mut s) = state.lock() {
        s.connected = true;
        s.printer_model = Some(cfg.printer_model.clone());
        s.last_error = None;
        s.close_code = None;
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
                        if let Err(e) = handle_message(&mut write, &parsed, cfg).await {
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
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    W: SinkExt<Message> + Unpin + Send,
    <W as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let mtype = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match mtype {
        "welcome" => {
            log::info!("bridge: welcomed bridge_id={:?}", msg.get("bridge_id"));
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
            let result = run_job(kind, msg.get("payload").cloned().unwrap_or(Value::Null), cfg);
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
    let runtime_cfg: RuntimeConfig = cfg
        .db_path
        .as_deref()
        .and_then(|p| runtime_config::read(p).ok())
        .unwrap_or_default();
    let provider_name = runtime_config::effective_provider(&runtime_cfg);
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
