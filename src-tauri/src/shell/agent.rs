// Etapa 5 — the fiscal agent runs by itself and the printer is watched.
//
// Agent: the Rust WSS agent (`agent_type = pos_desktop_tauri`, the module
// proven on the Datecs DP-25X) is started at boot from the credentials saved
// by the enrolment in the fiscal window, and restarted when its loop ends —
// except after "token revoked" (needs a new enrolment) and, for 5 minutes,
// after "replaced by another agent" (so two agents never ping-pong).
// It is the only fiscal agent: the separate fiscal-bridge program is gone.
// A station that was never enrolled simply runs no agent until the
// enrolment in the fiscal window (Ctrl+Shift+F) saves credentials.
//
// Printer watchdog: while the Rust agent owns the device, a STATUS poll
// (silent, non-fiscal) runs every 20s (60s after repeated failures). The
// transport opens the COM port per operation, so when the cable/USB comes
// back the next poll — and the next receipt — simply work again; the
// watchdog makes that state visible (pill in the POS, fiscal window).

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

use crate::fiscal::bridge_client::state::{now_unix, token_hash};
use crate::fiscal::commands::{fiscal_bridge_run, fiscal_bridge_state, running_token_hash};
use crate::fiscal::credentials;
use crate::fiscal::diagnostics::probe::list_ports;
use crate::fiscal::persist;
use crate::fiscal::providers;
use crate::fiscal::runtime_config;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FiscalHealth {
    /// False when the watchdog does not poll (station not enrolled,
    /// simulator) — `online` is then meaningless.
    pub monitored: bool,
    pub provider: String,
    pub port: Option<String>,
    pub port_present: Option<bool>,
    pub online: Option<bool>,
    pub paper_ok: Option<bool>,
    pub last_ok_at: Option<u64>,
    pub last_check_at: Option<u64>,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub has_saved_credentials: bool,
    pub running: bool,
    pub connected: bool,
    pub bridge_id: Option<String>,
    pub last_error: Option<String>,
    /// The server refused this station's token ("Deconectează" in the
    /// admin): a new code is needed (step 2 of the guide).
    pub revoked: bool,
    /// Restaurant (tenant) this app is linked to, from the saved enrolment.
    /// The admin page compares it with its own tenant: same → nothing to
    /// link; another → ask before linking again.
    pub tenant_id: Option<String>,
}

static HEALTH: Mutex<Option<FiscalHealth>> = Mutex::new(None);

pub fn health() -> FiscalHealth {
    HEALTH
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default()
}

fn set_health(h: FiscalHealth) {
    if let Ok(mut g) = HEALTH.lock() {
        *g = Some(h);
    }
}

fn has_saved_credentials(app: &AppHandle) -> bool {
    persist::db_path(app)
        .ok()
        .and_then(|p| credentials::read(&p).ok().flatten())
        .is_some()
}

pub fn summary(app: &AppHandle) -> AgentSummary {
    let st = fiscal_bridge_state();
    let saved = persist::db_path(app)
        .ok()
        .and_then(|p| credentials::read(&p).ok().flatten());
    AgentSummary {
        has_saved_credentials: saved.is_some(),
        tenant_id: saved.map(|c| c.tenant_id).filter(|t| !t.is_empty()),
        running: st.configured,
        connected: st.connected,
        bridge_id: st.bridge_id,
        last_error: st.last_error,
        revoked: st.revoked,
    }
}

/// Starts the Rust WSS agent from saved credentials. Returns true when it
/// is running afterwards. `fiscal_bridge_run` is a no-op when a loop with
/// the same credentials already runs, and replaces a loop that runs with
/// other (older) credentials.
fn start_rust_agent(app: &AppHandle) -> bool {
    let creds = match persist::db_path(app)
        .ok()
        .and_then(|p| credentials::read(&p).ok().flatten())
    {
        Some(c) => c,
        None => return fiscal_bridge_state().configured,
    };
    let model = creds
        .printer_model
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "datecs_dp25".into());
    match fiscal_bridge_run(app.clone(), creds.websocket_url, creds.device_token, model) {
        Ok(()) => {
            log::info!("agent: Rust fiscal agent running (bridge_id={})", creds.bridge_id);
            true
        }
        Err(e) => {
            log::warn!("agent: start failed: {e}");
            false
        }
    }
}

fn supervise_rust_agent(app: &AppHandle) {
    let st = fiscal_bridge_state();
    let creds = persist::db_path(app)
        .ok()
        .and_then(|p| credentials::read(&p).ok().flatten());
    let Some(creds) = creds else {
        return; // not enrolled: nothing to run
    };
    let saved = token_hash(&creds.device_token);
    if st.configured {
        // Running — but with the saved credentials? A new enrolment saved
        // without restarting the loop gets picked up here.
        if running_token_hash() != Some(saved) {
            log::info!("agent: saved credentials changed — replacing the running loop");
            start_rust_agent(app);
        }
        return;
    }
    if st.revoked && st.revoked_token_hash == Some(saved) {
        // This exact token was refused by the server: only a new enrolment
        // (a new code in step 2) helps. New credentials → start below.
        return;
    }
    if let (Some(4000), Some(stopped)) = (st.close_code, st.stopped_at) {
        if now_unix().saturating_sub(stopped) < 300 {
            return;
        }
    }
    if start_rust_agent(app) {
        log::info!("agent: supervisor (re)started the Rust fiscal agent");
    }
}

fn check_printer(app: &AppHandle) {
    let prev = health();
    let now = now_unix();
    let base = FiscalHealth {
        last_check_at: Some(now),
        ..prev.clone()
    };
    if !has_saved_credentials(app) {
        // Not enrolled yet: no agent runs, nothing to watch.
        set_health(FiscalHealth {
            monitored: false,
            provider: "neconfigurat".into(),
            ..base
        });
        return;
    }
    let cfg = persist::db_path(app)
        .ok()
        .and_then(|p| runtime_config::read(&p).ok())
        .unwrap_or_default();
    let provider = runtime_config::effective_provider(&cfg);
    let port = runtime_config::effective_serial_port(&cfg);
    if provider == "simulator" {
        // Simulator = no register. On the tenant build that is simply "not
        // configured" (never "online"); dev/demo builds keep the old view.
        let allowed = runtime_config::simulator_allowed();
        set_health(FiscalHealth {
            monitored: false,
            provider: if allowed { provider } else { "neconfigurat".into() },
            port,
            online: if allowed { Some(true) } else { None },
            last_error: if allowed { None } else { Some(runtime_config::NOT_CONFIGURED_RO.into()) },
            ..base
        });
        return;
    }
    if providers::device_busy() {
        return; // a receipt is printing — never queue a poll behind it
    }
    let port_present = port.as_ref().map(|p| {
        let ports = list_ports();
        ports.is_empty() || ports.iter().any(|x| x.eq_ignore_ascii_case(p))
    });
    let result = providers::build(&provider, &cfg).and_then(|p| p.get_status());
    match result {
        Ok(s) => {
            if prev.consecutive_failures >= 2 {
                log::info!("agent: fiscal printer is answering again on {:?}", port);
            }
            set_health(FiscalHealth {
                monitored: true,
                provider,
                port,
                port_present,
                online: Some(s.online),
                paper_ok: Some(s.paper_ok),
                last_ok_at: Some(now),
                last_check_at: Some(now),
                consecutive_failures: 0,
                last_error: s.error_message.or(s.error_code),
            });
        }
        Err(e) => {
            let failures = prev.consecutive_failures.saturating_add(1);
            if failures == 2 {
                log::warn!("agent: fiscal printer not answering on {:?}: {e}", port);
            }
            let hint = match port_present {
                Some(false) => format!("Portul {} nu mai există (cablu/USB?). {e}", port.clone().unwrap_or_default()),
                _ => e.to_string(),
            };
            set_health(FiscalHealth {
                monitored: true,
                provider,
                port,
                port_present,
                online: Some(false),
                paper_ok: prev.paper_ok,
                last_ok_at: prev.last_ok_at,
                last_check_at: Some(now),
                consecutive_failures: failures,
                last_error: Some(hint),
            });
        }
    }
}

/// Boot: start the agent when the station is enrolled, then supervise in
/// the background.
pub fn start(app: &AppHandle) {
    start_rust_agent(app);
    let app = app.clone();
    std::thread::Builder::new()
        .name("pos-fiscal-supervisor".into())
        .spawn(move || {
            // Let the UI and the WSS handshake settle first.
            std::thread::sleep(Duration::from_secs(8));
            let mut tick: u64 = 0;
            loop {
                if tick % 3 == 0 {
                    supervise_rust_agent(&app);
                }
                let failing = health().consecutive_failures >= 3;
                if !failing || tick % 3 == 0 {
                    check_printer(&app);
                }
                tick = tick.wrapping_add(1);
                std::thread::sleep(Duration::from_secs(20));
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| log::error!("supervisor thread: {e}"));
}

#[tauri::command]
pub fn shell_fiscal_health(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "printer": health(),
        "agent": summary(&app),
    })
}

/// (Re)starts the agent from the saved credentials and checks the printer
/// at once — „Reconectează acum”, and the end of an automatic link.
pub fn reconnect_now(app: &AppHandle) {
    start_rust_agent(app);
    check_printer(app);
}

/// "Reconnect now" button: (re)starts the agent and polls at once.
#[tauri::command]
pub async fn shell_fiscal_reconnect(app: AppHandle) -> Result<serde_json::Value, String> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        reconnect_now(&a);
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(shell_fiscal_health(app))
}
