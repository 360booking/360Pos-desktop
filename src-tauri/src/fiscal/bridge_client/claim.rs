// Enrollment — POST /api/fiscal-bridge/claim. Mirrors
// fiscal-bridge/bridge/main.py::_claim_code.

use serde::{Deserialize, Serialize};

use crate::fiscal::error::FiscalError;

#[derive(Debug, Serialize)]
struct ClaimRequest<'a> {
    code: &'a str,
    printer_model: &'a str,
    version: &'a str,
    os_info: String,
    /// C13 — declares this enrollment as the Tauri/Rust agent so the
    /// `fiscal_bridges.agent_type` column lands the right discriminator
    /// on the very first handshake. Backend defaults to the legacy
    /// `python_fiscal_bridge` value when absent.
    agent_type: &'static str,
}

pub const AGENT_TYPE: &str = "pos_desktop_tauri";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ClaimResponse {
    pub device_token: String,
    pub bridge_id: String,
    pub tenant_id: String,
    pub websocket_url: String,
}

pub async fn claim(
    server_base_url: &str,
    code: &str,
    printer_model: &str,
) -> Result<ClaimResponse, FiscalError> {
    let url = format!("{}/api/fiscal-bridge/claim", server_base_url.trim_end_matches('/'));
    let payload = ClaimRequest {
        code,
        printer_model,
        version: env!("CARGO_PKG_VERSION"),
        os_info: format!("{} (pos-desktop rust)", std::env::consts::OS),
        agent_type: AGENT_TYPE,
    };
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| FiscalError::CommunicationError {
            detail: format!("POST {url}: {e}"),
        })?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(match code {
            404 => FiscalError::ConfigurationError {
                detail: format!("enrollment code not found: {body}"),
            },
            410 => FiscalError::ConfigurationError {
                detail: format!("enrollment code expired: {body}"),
            },
            _ => FiscalError::CommunicationError {
                detail: format!("HTTP {code}: {body}"),
            },
        });
    }
    resp.json::<ClaimResponse>()
        .await
        .map_err(|e| FiscalError::CommunicationError {
            detail: format!("malformed claim response: {e}"),
        })
}
