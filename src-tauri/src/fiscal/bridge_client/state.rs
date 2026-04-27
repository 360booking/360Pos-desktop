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
