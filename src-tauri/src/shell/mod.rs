// Etapa 5 — desktop shell around the web POS.
//
//   * main window: loads https://<tenant>/admin/restaurant/pos (or the
//     bundled legacy UI / station setup / offline till, all local pages);
//   * `fiscal` window: the fiscal settings (local page, separate window);
//   * connectivity monitor: GET <tenant>/api/health every 5s;
//   * kiosk mode, start-with-Windows, navigation allow-list.
//
// Local pages are served from the app bundle and pick their screen from
// `?shell=<view>` (see src/main.tsx).

pub mod agent;
pub mod config;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

use config::ShellConfig;

pub const MAIN: &str = "main";
pub const FISCAL: &str = "fiscal";

const BRIDGE_JS: &str = include_str!("bridge.js");

static ONLINE: AtomicBool = AtomicBool::new(true);
static ONLINE_CHANGED_AT: AtomicU64 = AtomicU64::new(0);
static KIOSK: AtomicBool = AtomicBool::new(false);
static REMOTE_CAP_ADDED: AtomicBool = AtomicBool::new(false);

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn is_online() -> bool {
    ONLINE.load(Ordering::Relaxed)
}

pub fn online_changed_at() -> u64 {
    ONLINE_CHANGED_AT.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// URLs

/// Base URL of the bundled frontend, the same one Tauri uses for
/// `WebviewUrl::App` (dev server in `tauri dev`, http://tauri.localhost/ on
/// Windows release builds, tauri://localhost elsewhere).
pub fn local_base(app: &AppHandle) -> Url {
    if tauri::is_dev() {
        if let Some(u) = app.config().build.dev_url.clone() {
            return u;
        }
    }
    let s = if cfg!(windows) || cfg!(target_os = "android") {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    Url::parse(s).expect("static url")
}

pub fn local_view(app: &AppHandle, view: Option<&str>) -> Url {
    let mut u = local_base(app);
    match view {
        Some(v) => u.set_query(Some(&format!("shell={v}"))),
        None => u.set_query(None),
    }
    u
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

fn is_360booking_host(u: &Url) -> bool {
    match u.host_str() {
        Some(h) => u.scheme() == "https" && (h == "360booking.ro" || h.ends_with(".360booking.ro")),
        None => false,
    }
}

/// The main window may only show the tenant site, *.360booking.ro (login
/// redirects) and our own bundled pages. Anything else is opened in the
/// system browser instead, so a stray link can't strand a kiosk.
fn navigation_allowed(app: &AppHandle, target: &Url) -> bool {
    let local = local_base(app);
    if same_origin(target, &local) || target.scheme() == "tauri" {
        return true;
    }
    if matches!(target.scheme(), "about" | "data" | "blob") {
        return true;
    }
    if is_360booking_host(target) {
        return true;
    }
    if let Some(origin) = config::current().tenant_origin() {
        if same_origin(target, &origin) {
            return true;
        }
    }
    log::info!("shell: blocked navigation to {target} — opening in the system browser");
    open_in_system_browser(target.as_str());
    false
}

fn open_in_system_browser(url: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

/// `capabilities/remote-pos.json` covers https://360booking.ro and every
/// subdomain at build time. A tenant on its own domain gets the same (and
/// only that) `desktop:default` permission at runtime.
fn ensure_remote_capability(app: &AppHandle, cfg: &ShellConfig) {
    let Some(origin) = cfg.tenant_origin() else { return };
    if is_360booking_host(&origin) || REMOTE_CAP_ADDED.load(Ordering::Relaxed) {
        return;
    }
    let pattern = format!("{}://{}", origin.scheme(), origin.host_str().unwrap_or_default());
    let cap = CapabilityBuilder::new("remote-pos-custom-domain")
        .remote(pattern.clone())
        .window(MAIN)
        .permission("desktop:default");
    match app.add_capability(cap) {
        Ok(()) => {
            REMOTE_CAP_ADDED.store(true, Ordering::Relaxed);
            log::info!("shell: desktop bridge enabled for custom domain {pattern}");
        }
        Err(e) => log::warn!("shell: add_capability for {pattern} failed: {e}"),
    }
}

// ---------------------------------------------------------------------------
// Windows

/// Decides what the main window shows at start-up.
fn initial_main_url(app: &AppHandle, cfg: &ShellConfig) -> Url {
    if !cfg.is_web() {
        return local_view(app, None);
    }
    let Some(pos) = cfg.pos_url() else {
        return local_view(app, Some("setup"));
    };
    // A quick probe so a till that boots without internet lands directly
    // on the offline till instead of a browser error page.
    // Own thread: setup() must never end up nesting one runtime in another.
    let health = cfg.health_url();
    let online = std::thread::spawn(move || {
        tauri::async_runtime::block_on(probe(health, Duration::from_secs(4)))
    })
    .join()
    .unwrap_or(false);
    set_online(online);
    if online {
        pos
    } else {
        log::warn!("shell: tenant unreachable at start-up — opening the offline till");
        local_view(app, Some("offline"))
    }
}

pub fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let cfg = config::current();
    ensure_remote_capability(app, &cfg);
    let url = initial_main_url(app, &cfg);
    let nav_app = app.clone();
    // 2026-10-13 („nu e pe tot ecranul, jos pare tăiat, la tras se mișcă”):
    // the window used to open as a floating 1366×820 window. On a 1366×768
    // screen — or 1920×1080 at 150 % scaling (1280×720 logical) — that is
    // taller than the screen, so the bottom bar of the POS fell under the
    // taskbar, and dragging the title bar moved the whole POS around.
    // Now: kiosk → borderless full screen on the monitor the window opens
    // on (the primary one); kiosk off → maximised (fills the work area,
    // taskbar stays visible). The size below is only the "restore" size, and
    // the minimum fits a 1366×768 screen at 150 % (911×512 logical).
    let mut b = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
        .title("360restaurants POS")
        .inner_size(1280.0, 720.0)
        .min_inner_size(800.0, 500.0)
        .resizable(true)
        .center()
        .maximized(true)
        .initialization_script(BRIDGE_JS)
        .on_navigation(move |u| navigation_allowed(&nav_app, u));
    if cfg.kiosk {
        b = b.fullscreen(true).decorations(false);
    }
    KIOSK.store(cfg.kiosk, Ordering::Relaxed);
    b.build()
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn navigate_main(app: &AppHandle, url: Url) -> Result<(), String> {
    let w = main_window(app).ok_or_else(|| "fereastra principală lipsește".to_string())?;
    w.navigate(url).map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

pub fn open_pos(app: &AppHandle) -> Result<(), String> {
    let cfg = config::current();
    if !cfg.is_web() {
        return navigate_main(app, local_view(app, None));
    }
    match cfg.pos_url() {
        Some(u) => {
            ensure_remote_capability(app, &cfg);
            navigate_main(app, u)
        }
        None => navigate_main(app, local_view(app, Some("setup"))),
    }
}

pub fn open_offline_till(app: &AppHandle) -> Result<(), String> {
    navigate_main(app, local_view(app, Some("offline")))
}

pub fn open_fiscal_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(FISCAL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let kiosk = KIOSK.load(Ordering::Relaxed);
    WebviewWindowBuilder::new(app, FISCAL, WebviewUrl::External(local_view(app, Some("fiscal"))))
        .title("Casă de marcat și stație — setări")
        // Fits a 1024x768 / 1366x768 POS screen (taskbar included); the
        // guide scrolls inside the window when it needs more room.
        .inner_size(1000.0, 680.0)
        .min_inner_size(800.0, 540.0)
        .center()
        .resizable(true)
        // Over a fullscreen kiosk window it would otherwise open behind it.
        .always_on_top(kiosk)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn set_kiosk(app: &AppHandle, on: bool) -> Result<bool, String> {
    let w = main_window(app).ok_or_else(|| "fereastra principală lipsește".to_string())?;
    w.set_decorations(!on).map_err(|e| e.to_string())?;
    w.set_fullscreen(on).map_err(|e| e.to_string())?;
    if !on {
        // Leaving full screen restores the old window size; maximise so the
        // POS still fits the screen (bottom bar above the taskbar).
        let _ = w.maximize();
    }
    KIOSK.store(on, Ordering::Relaxed);
    Ok(on)
}

pub fn toggle_kiosk(app: &AppHandle) -> Result<bool, String> {
    let on = !KIOSK.load(Ordering::Relaxed);
    set_kiosk(app, on)?;
    let mut cfg = config::current();
    cfg.kiosk = on;
    cfg.kiosk_chosen = true;
    let _ = config::save(app, &cfg);
    Ok(on)
}

pub fn kiosk_on() -> bool {
    KIOSK.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// Start with Windows (per-user Run key — no admin rights needed).

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "360booking POS";

pub fn set_autostart(enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut cmd = std::process::Command::new("reg");
        if enable {
            let data = format!("\"{}\"", exe.display());
            cmd.args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &data, "/f"]);
        } else {
            cmd.args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
        }
        let out = cmd
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("reg: {e}"))?;
        // Deleting a value that is not there is fine.
        if !out.status.success() && enable {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (RUN_KEY, RUN_VALUE);
        log::info!("autostart({enable}) ignored: not on Windows");
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Connectivity

fn set_online(v: bool) {
    let prev = ONLINE.swap(v, Ordering::Relaxed);
    if prev != v || ONLINE_CHANGED_AT.load(Ordering::Relaxed) == 0 {
        ONLINE_CHANGED_AT.store(now_unix(), Ordering::Relaxed);
        if prev != v {
            log::info!("shell: connectivity → {}", if v { "online" } else { "OFFLINE" });
        }
    }
}

async fn probe(url: Url, timeout: Duration) -> bool {
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(url).send().await {
        Ok(r) => r.status().as_u16() < 500,
        Err(_) => false,
    }
}

/// Background probe every 5s. Two consecutive failures flip to offline so a
/// single dropped packet does not send the cashier to the offline till.
pub fn start_connectivity_monitor() {
    std::thread::Builder::new()
        .name("pos-connectivity".into())
        .spawn(|| {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!("connectivity runtime: {e}");
                    return;
                }
            };
            rt.block_on(async {
                let mut fails = 0u32;
                loop {
                    let url = config::current().health_url();
                    if probe(url, Duration::from_secs(4)).await {
                        fails = 0;
                        set_online(true);
                    } else {
                        fails += 1;
                        if fails >= 2 {
                            set_online(false);
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            });
        })
        .map(|_| ())
        .unwrap_or_else(|e| log::error!("connectivity thread: {e}"));
}

// ---------------------------------------------------------------------------
// App commands (local pages only — remote pages can't reach app commands).

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellState {
    pub config: ShellConfig,
    pub pos_url: Option<String>,
    pub online: bool,
    pub kiosk: bool,
    pub version: String,
    pub data_dir: Option<String>,
}

#[tauri::command]
pub fn shell_get_config(app: AppHandle) -> ShellState {
    let cfg = config::current();
    ShellState {
        pos_url: cfg.pos_url().map(|u| u.to_string()),
        online: is_online(),
        kiosk: kiosk_on(),
        version: app.package_info().version.to_string(),
        data_dir: app.path().app_data_dir().ok().map(|p| p.display().to_string()),
        config: cfg,
    }
}

#[tauri::command]
pub async fn shell_set_config(app: AppHandle, config: ShellConfig) -> Result<ShellState, String> {
    let mut next = config;
    if !next.tenant_url.trim().is_empty() {
        let origin = config::normalise_tenant_url(&next.tenant_url)?;
        next.tenant_url = origin.as_str().trim_end_matches('/').to_string();
    }
    if !(0.0..=0.3).contains(&next.offline_default_vat) {
        return Err("Cota TVA implicită trebuie să fie între 0 și 0.30 (ex. 0.21).".into());
    }
    // Only the integrated agent exists; older values are never kept.
    next.fiscal_agent = config::FISCAL_AGENT_AUTO.into();
    if !matches!(next.mode.as_str(), "web" | "legacy") {
        return Err("Mod necunoscut.".into());
    }
    let prev = config::current();
    // Saved from the settings form, where the kiosk checkbox is visible:
    // whatever it says now is a choice and survives restarts.
    next.kiosk_chosen = true;
    config::save(&app, &next)?;
    if prev.autostart != next.autostart {
        if let Err(e) = set_autostart(next.autostart) {
            log::warn!("autostart: {e}");
        }
    }
    if prev.kiosk != next.kiosk {
        let _ = set_kiosk(&app, next.kiosk);
    }
    ensure_remote_capability(&app, &next);
    Ok(shell_get_config(app))
}

/// Tests an address before saving it: reachable + looks like 360booking.
#[tauri::command]
pub async fn shell_test_tenant(tenant_url: String) -> Result<String, String> {
    let origin = config::normalise_tenant_url(&tenant_url)?;
    let health = origin.join("/api/health").map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    let r = client
        .get(health)
        .send()
        .await
        .map_err(|e| format!("Nu răspunde: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("Serverul a răspuns {}", r.status()));
    }
    Ok(origin.as_str().trim_end_matches('/').to_string())
}

#[tauri::command]
pub async fn shell_open_pos(app: AppHandle) -> Result<(), String> {
    open_pos(&app)
}

#[tauri::command]
pub async fn shell_open_offline(app: AppHandle) -> Result<(), String> {
    open_offline_till(&app)
}

#[tauri::command]
pub async fn shell_open_fiscal_settings(app: AppHandle) -> Result<(), String> {
    open_fiscal_settings(&app)
}

#[tauri::command]
pub async fn shell_set_kiosk(app: AppHandle, on: bool) -> Result<bool, String> {
    let r = set_kiosk(&app, on)?;
    let mut cfg = config::current();
    cfg.kiosk = on;
    cfg.kiosk_chosen = true;
    let _ = config::save(&app, &cfg);
    Ok(r)
}

#[tauri::command]
pub fn shell_quit(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_allow_list() {
        assert!(is_360booking_host(&Url::parse("https://360booking.ro/x").unwrap()));
        assert!(is_360booking_host(&Url::parse("https://pizza.360booking.ro/").unwrap()));
        assert!(!is_360booking_host(&Url::parse("https://evil360booking.ro/").unwrap()));
        assert!(!is_360booking_host(&Url::parse("http://pizza.360booking.ro/").unwrap()));
        assert!(!is_360booking_host(&Url::parse("https://360booking.ro.evil.com/").unwrap()));
    }

    #[test]
    fn origin_compare() {
        let a = Url::parse("https://x.ro/a").unwrap();
        let b = Url::parse("https://x.ro:443/b").unwrap();
        let c = Url::parse("http://x.ro/").unwrap();
        assert!(same_origin(&a, &b));
        assert!(!same_origin(&a, &c));
    }
}
