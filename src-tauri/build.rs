fn main() {
    // Etapa 5 — the `desktop` plugin (src/desktop_plugin.rs) is inlined in
    // the app. Its commands get `desktop:allow-<command>` permissions; the
    // `desktop:default` set below is what the REMOTE web POS is granted
    // (capabilities/remote-pos.json). The till-only commands
    // (list/close/review/requeue) are granted to local pages only
    // (capabilities/default.json). Keep in sync with desktop_plugin.rs.
    const DESKTOP_COMMANDS: &[&str] = &[
        "bridge_info",
        "offline_cache_orders",
        "offline_list_orders",
        "offline_pending_sync",
        "offline_mark_synced",
        "offline_journal",
        "offline_mark_reviewed",
        "offline_requeue",
        "offline_resolve_unknown",
        "offline_close_order",
        "open_offline_till",
        "open_fiscal_settings",
        "open_pos",
        "toggle_kiosk",
    ];
    let remote_safe = [
        "allow-bridge-info",
        "allow-offline-cache-orders",
        "allow-offline-pending-sync",
        "allow-offline-mark-synced",
        "allow-offline-journal",
        "allow-open-offline-till",
        "allow-open-fiscal-settings",
        "allow-open-pos",
        "allow-toggle-kiosk",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect::<Vec<_>>();

    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "desktop",
            tauri_build::InlinedPlugin::new()
                .commands(DESKTOP_COMMANDS)
                .default_permission(tauri_build::DefaultPermissionRule::Allow(remote_safe)),
        ),
    )
    .expect("failed to run tauri-build");
}
