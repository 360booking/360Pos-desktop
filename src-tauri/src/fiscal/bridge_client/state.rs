use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct BridgeState {
    pub configured: bool,
    pub connected: bool,
    pub bridge_id: Option<String>,
    pub tenant_id: Option<String>,
    pub printer_model: Option<String>,
    pub last_heartbeat_at: Option<u64>,
    pub last_error: Option<String>,
    pub close_code: Option<u16>,
    /// Etapa 5 — unix time the WSS loop thread last exited (None while it
    /// runs or before it ever ran). The agent supervisor uses it to decide
    /// when to restart the loop.
    pub stopped_at: Option<u64>,
    /// 2026-10-14 — the server refused this station's token (HTTP 401/403,
    /// close 4001/4403): "Deconectează" in the admin, or a newer enrolment.
    /// The guide then shows "Legătura a fost anulată din admin".
    pub revoked: bool,
    /// Hash of the token that was refused (never the token itself). The
    /// supervisor restarts the agent only once different credentials are
    /// saved.
    #[serde(skip_serializing)]
    pub revoked_token_hash: Option<u64>,
}

impl Default for BridgeState {
    fn default() -> Self {
        Self {
            configured: false,
            connected: false,
            bridge_id: None,
            tenant_id: None,
            printer_model: None,
            last_heartbeat_at: None,
            last_error: None,
            close_code: None,
            stopped_at: None,
            revoked: false,
            revoked_token_hash: None,
        }
    }
}

pub type SharedState = Arc<Mutex<BridgeState>>;

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// In-process fingerprint of a device token (DefaultHasher: fixed keys, so
/// stable for the life of the process). Used to compare tokens without
/// keeping them around in the shared state.
pub fn token_hash(token: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut h);
    h.finish()
}
