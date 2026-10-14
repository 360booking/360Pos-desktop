// „Copiază diagnosticul” / „Deschide folderul de jurnale” — fiscal window
// (2026-10-14). One plain-text block the owner can paste in a message:
// app version, station + register settings (no password, token masked),
// agent state with its last error, printer watchdog, and the last ~200
// lines of the app log (`%LOCALAPPDATA%\com.x360booking.pos\logs`).

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::fiscal::{credentials, persist, runtime_config};

const TAIL_LINES: usize = 200;
const TAIL_BYTES: u64 = 256 * 1024;

fn mask(token: &str) -> String {
    let n = token.chars().count();
    if n <= 8 {
        return "****".into();
    }
    let head: String = token.chars().take(4).collect();
    let tail: String = token.chars().skip(n - 4).collect();
    format!("{head}…{tail} ({n} caractere)")
}

fn opt<T: std::fmt::Display>(v: &Option<T>) -> String {
    v.as_ref().map(|x| x.to_string()).unwrap_or_else(|| "—".into())
}

/// Newest `*.log` in the app log folder (the live file; rotated ones are
/// renamed with a date).
fn newest_log(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "log").unwrap_or(false))
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
}

/// Last `n` lines of a file, reading at most the last 256 KB.
pub fn tail_lines(path: &Path, n: usize) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.lines().collect();
    let from = lines.len().saturating_sub(n);
    Ok(lines[from..].join("\n"))
}

#[tauri::command]
pub fn fiscal_diagnostics(app: AppHandle) -> String {
    let mut out: Vec<String> = Vec::new();
    let info = app.package_info();
    out.push(format!("360restaurants POS — diagnostic casa de marcat (v{})", info.version));
    out.push(format!(
        "Generat: unix {} · build: {} · simulator permis: {}",
        crate::fiscal::bridge_client::state::now_unix(),
        option_env!("POS_BUILD_PROFILE").unwrap_or(if cfg!(debug_assertions) { "debug" } else { "release" }),
        if runtime_config::simulator_allowed() { "da" } else { "nu" },
    ));

    let station = crate::shell::config::current();
    out.push(String::new());
    out.push("== Stația".into());
    out.push(format!(
        "mod={} · restaurant={} · kiosk={}",
        station.mode,
        if station.tenant_url.is_empty() { "(nesetat)" } else { station.tenant_url.as_str() },
        station.kiosk
    ));

    let db = persist::db_path(&app).ok();
    let cfg = db
        .as_deref()
        .and_then(|p| runtime_config::read(p).ok())
        .unwrap_or_default();
    out.push(String::new());
    out.push("== Casa (pasul 1)".into());
    out.push(format!(
        "provider={} (salvat: {}) · port={} · baud={} · variantă={} · operator={} · parolă={} · model={} · salvat la {}",
        runtime_config::effective_provider(&cfg),
        opt(&cfg.provider),
        opt(&runtime_config::effective_serial_port(&cfg)),
        runtime_config::effective_baud(&cfg),
        opt(&runtime_config::effective_protocol_variant(&cfg)),
        runtime_config::effective_operator(&cfg),
        if cfg.operator_password.as_deref().map(|s| !s.is_empty()).unwrap_or(false) { "setată" } else { "implicită" },
        opt(&cfg.printer_model),
        opt(&cfg.updated_at),
    ));

    out.push(String::new());
    out.push("== Legătura cu serverul (pasul 2)".into());
    match db.as_deref().and_then(|p| credentials::read(p).ok().flatten()) {
        Some(c) => out.push(format!(
            "server={} · ws={} · bridge_id={} · tenant={} · token={} · legată la {}",
            c.server_base_url,
            c.websocket_url,
            c.bridge_id,
            c.tenant_id,
            mask(&c.device_token),
            opt(&c.claimed_at),
        )),
        None => out.push("stația nu e legată (nu există credențiale salvate)".into()),
    }
    let st = crate::fiscal::commands::fiscal_bridge_state();
    out.push(format!(
        "agent: pornit={} · conectat={} · revocat={} · cod închidere={} · ultimul semnal unix={} · ultima eroare={}",
        st.configured,
        st.connected,
        st.revoked,
        opt(&st.close_code),
        opt(&st.last_heartbeat_at),
        st.last_error.clone().unwrap_or_else(|| "—".into()),
    ));

    let h = crate::shell::agent::health();
    out.push(String::new());
    out.push("== Casa răspunde? (verificare la 20 s)".into());
    out.push(format!(
        "monitorizată={} · provider={} · port={} · port prezent={} · online={} · hârtie={} · ultimul OK unix={} · eșecuri la rând={} · ultima eroare={}",
        h.monitored,
        h.provider,
        opt(&h.port),
        opt(&h.port_present),
        opt(&h.online),
        opt(&h.paper_ok),
        opt(&h.last_ok_at),
        h.consecutive_failures,
        h.last_error.clone().unwrap_or_else(|| "—".into()),
    ));

    out.push(String::new());
    match app.path().app_log_dir() {
        Ok(dir) => {
            out.push(format!("== Jurnal: {}", dir.display()));
            match newest_log(&dir) {
                Some(f) => match tail_lines(&f, TAIL_LINES) {
                    Ok(t) => {
                        out.push(format!("(ultimele {TAIL_LINES} linii din {})", f.display()));
                        out.push(t);
                    }
                    Err(e) => out.push(format!("nu pot citi {}: {e}", f.display())),
                },
                None => out.push("niciun fișier .log încă".into()),
            }
        }
        Err(e) => out.push(format!("== Jurnal: dosar necunoscut ({e})")),
    }
    log::info!("fiscal_diagnostics: report generated");
    out.join("\n")
}

/// Opens the log folder in Explorer; returns its path (shown in the UI too).
#[tauri::command]
pub fn fiscal_open_log_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&dir).spawn();
    spawned.map_err(|e| format!("Nu am putut deschide {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_keeps_only_the_ends() {
        let m = mask("abcdefghijklmnopqrstuvwxyz");
        assert!(m.starts_with("abcd…wxyz"));
        assert!(!m.contains("efgh"));
        assert_eq!(mask("short"), "****");
    }

    #[test]
    fn tail_returns_last_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.log");
        let body: String = (1..=500).map(|i| format!("linia {i}\n")).collect();
        std::fs::write(&p, body).unwrap();
        let t = tail_lines(&p, 3).unwrap();
        assert_eq!(t, "linia 498\nlinia 499\nlinia 500");
        assert_eq!(newest_log(dir.path()).unwrap(), p);
    }
}
