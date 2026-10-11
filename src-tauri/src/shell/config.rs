// Station configuration for the desktop shell (Etapa 5).
//
// Stored as JSON next to the other app files
// (%APPDATA%\com.x360booking.pos\shell-config.json on Windows) so it is
// readable before any SQLite migration ran and survives a DB reset.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use url::Url;

pub const DEFAULT_POS_PATH: &str = "/admin/restaurant/pos";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellConfig {
    /// "web" = load the web POS from `tenant_url` (default since Etapa 5);
    /// "legacy" = the bundled React POS from Sprint 0–11.
    pub mode: String,
    /// e.g. "https://pizzeria.360booking.ro" (or a custom tenant domain).
    pub tenant_url: String,
    /// Path of the POS screen on the tenant site.
    pub pos_path: String,
    /// Fullscreen, no window frame. Ctrl+Shift+K toggles it.
    pub kiosk: bool,
    /// Start with Windows (HKCU Run key).
    pub autostart: bool,
    /// "auto" | "rust" | "sidecar" | "off" — which fiscal agent runs.
    ///   auto    → the Rust agent when this station was enrolled from the
    ///             fiscal window (saved credentials), else the bundled
    ///             fiscal-bridge sidecar (pre-Etapa-5 behaviour).
    pub fiscal_agent: String,
    /// VAT used on an offline receipt line when the web POS could not tell
    /// the rate of that product (fraction, 0.21 = 21%).
    pub offline_default_vat: f64,
    /// Test only: let the offline till "print" on the simulator. Off by
    /// default so an unconfigured station can never send a fake BF number
    /// to the server as a real offline receipt.
    pub offline_allow_simulator: bool,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            mode: "web".into(),
            tenant_url: String::new(),
            pos_path: DEFAULT_POS_PATH.into(),
            kiosk: false,
            autostart: false,
            fiscal_agent: "auto".into(),
            offline_default_vat: 0.21,
            offline_allow_simulator: false,
        }
    }
}

impl ShellConfig {
    pub fn is_web(&self) -> bool {
        self.mode != "legacy"
    }

    /// Normalised tenant origin ("https://x.360booking.ro"), None when unset
    /// or invalid.
    pub fn tenant_origin(&self) -> Option<Url> {
        normalise_tenant_url(&self.tenant_url).ok()
    }

    pub fn pos_url(&self) -> Option<Url> {
        let origin = self.tenant_origin()?;
        let path = if self.pos_path.trim().is_empty() {
            DEFAULT_POS_PATH
        } else {
            self.pos_path.trim()
        };
        origin.join(path).ok()
    }

    pub fn health_url(&self) -> Url {
        self.tenant_origin()
            .and_then(|o| o.join("/api/health").ok())
            .unwrap_or_else(|| Url::parse("https://360booking.ro/api/health").expect("static url"))
    }
}

/// Accepts "pizzeria.360booking.ro", "https://pizzeria.360booking.ro/",
/// "https://pizzeria.360booking.ro/admin/restaurant/pos" … and returns the
/// bare origin. Only https is accepted, except http on localhost for dev.
pub fn normalise_tenant_url(raw: &str) -> Result<Url, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("Adresa restaurantului este goală.".into());
    }
    let with_scheme = if t.contains("://") {
        t.to_string()
    } else {
        format!("https://{t}")
    };
    let u = Url::parse(&with_scheme).map_err(|e| format!("Adresă invalidă: {e}"))?;
    let host = u.host_str().unwrap_or("").to_string();
    if host.is_empty() {
        return Err("Adresa nu are domeniu.".into());
    }
    let local = host == "localhost" || host == "127.0.0.1";
    match u.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return Err("Adresa trebuie să înceapă cu https://".into()),
    }
    let mut origin = format!("{}://{}", u.scheme(), host);
    if let Some(p) = u.port() {
        origin.push_str(&format!(":{p}"));
    }
    origin.push('/');
    Url::parse(&origin).map_err(|e| format!("Adresă invalidă: {e}"))
}

static CURRENT: OnceLock<Mutex<ShellConfig>> = OnceLock::new();

fn slot() -> &'static Mutex<ShellConfig> {
    CURRENT.get_or_init(|| Mutex::new(ShellConfig::default()))
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("shell-config.json"))
}

/// Reads the file into the in-memory copy. Missing/broken file → defaults.
pub fn load(app: &AppHandle) -> ShellConfig {
    let cfg = config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<ShellConfig>(&s).ok())
        .unwrap_or_default();
    if let Ok(mut g) = slot().lock() {
        *g = cfg.clone();
    }
    cfg
}

pub fn current() -> ShellConfig {
    slot().lock().map(|g| g.clone()).unwrap_or_default()
}

pub fn save(app: &AppHandle, cfg: &ShellConfig) -> Result<(), String> {
    let path = config_path(app).ok_or_else(|| "app_config_dir indisponibil".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    // Write-then-rename so a power cut never leaves a half-written file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {}: {e}", path.display()))?;
    if let Ok(mut g) = slot().lock() {
        *g = cfg.clone();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_bare_domain_and_paths() {
        assert_eq!(
            normalise_tenant_url("pizzeria.360booking.ro").unwrap().as_str(),
            "https://pizzeria.360booking.ro/"
        );
        assert_eq!(
            normalise_tenant_url(" https://pizzeria.360booking.ro/admin/restaurant/pos ")
                .unwrap()
                .as_str(),
            "https://pizzeria.360booking.ro/"
        );
    }

    #[test]
    fn rejects_plain_http_outside_localhost() {
        assert!(normalise_tenant_url("http://pizzeria.360booking.ro").is_err());
        assert!(normalise_tenant_url("http://localhost:5173").is_ok());
        assert!(normalise_tenant_url("").is_err());
    }

    #[test]
    fn pos_url_joins_path() {
        let c = ShellConfig {
            tenant_url: "demo.360booking.ro".into(),
            ..Default::default()
        };
        assert_eq!(
            c.pos_url().unwrap().as_str(),
            "https://demo.360booking.ro/admin/restaurant/pos"
        );
        assert_eq!(
            c.health_url().as_str(),
            "https://demo.360booking.ro/api/health"
        );
    }

    #[test]
    fn old_file_without_new_fields_still_parses() {
        let c: ShellConfig = serde_json::from_str(r#"{"tenantUrl":"x.360booking.ro"}"#).unwrap();
        assert_eq!(c.mode, "web");
        assert_eq!(c.fiscal_agent, "auto");
        assert!((c.offline_default_vat - 0.21).abs() < 1e-9);
    }
}
