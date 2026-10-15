// Starea casei de marcat (2026-10-15) — one small, stable summary of what the
// register reports, for the web POS indicator (window.desktopBridge), the
// fiscal window and the server (heartbeat).
//
// Built from the decoded status flags (mapping/status.rs: the 8 DP-25X
// status bytes, or the legacy 6) plus the one condition the DP-25X has no
// status bit for: „raport Z necesar” (24 h since the first sale after the
// last Z), which is learned when the register refuses a receipt with
// -111024 (providers::z_report_required).
//
// The watchdog (shell/agent.rs) refreshes it with a silent STATUS (0x4A)
// only when the device is idle; `latest()` is what the heartbeat sends.

use std::sync::Mutex;

use serde::Serialize;

use crate::fiscal::dto::FiscalStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RegisterState {
    /// Answers, nothing to report.
    Ok,
    /// Answers; prints, but someone should look (paper almost out, …).
    Warning,
    /// Answers, but cannot print until someone acts (paper out, cover
    /// open, Z report required, mechanism or fiscal memory fault).
    Blocked,
    /// Did not answer the last STATUS (off, cable, wrong port, port taken).
    NoAnswer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterStatus {
    pub state: RegisterState,
    /// The register answered the last STATUS.
    pub connected: bool,
    pub paper_out: bool,
    pub paper_near_end: bool,
    pub cover_open: bool,
    /// Fiscal memory / electronic journal almost full (service soon).
    pub fiscal_memory_near_full: bool,
    /// Fiscal memory / electronic journal full, missing or unreadable.
    pub fiscal_memory_error: bool,
    /// The register refused a receipt: Z report needed (24 h).
    pub z_report_required: bool,
    /// Printing mechanism fault / overheat / general printer error.
    pub printer_error: bool,
    /// A receipt was left open on the register.
    pub receipt_open: bool,
    /// The most important thing to tell the operator, in Romanian.
    pub message: Option<String>,
    /// Every decoded flag code (X_PAPER_OUT, …) — for support.
    pub codes: Vec<String>,
    /// Unix seconds of the check.
    pub checked_at: u64,
}

pub const Z_REQUIRED_RO: &str =
    "Casa cere raportul Z (au trecut 24 de ore de la primul bon al zilei) — fă raportul Z, apoi bonurile merg din nou.";

const PAPER_OUT: &[&str] = &["X_PAPER_OUT", "S1_NO_PAPER", "S1_NO_JOURNAL"];
const PAPER_NEAR_END: &[&str] = &["X_PAPER_NEAR_END", "S1_PAPER_NEAR_END"];
const COVER_OPEN: &[&str] = &["X_COVER_OPEN"];
const FM_NEAR_FULL: &[&str] = &["X_FM_NEAR_FULL", "X_EJ_NEAR_FULL", "S5_FM_NEAR_FULL"];
const FM_ERROR: &[&str] = &[
    "X_FM_FULL",
    "X_EJ_FULL",
    "X_FM_MISSING",
    "X_FM_ACCESS",
    "S4_FM_FULL",
    "S4_FM_READ_ERR",
];
const PRINTER_ERROR: &[&str] = &[
    "X_PRINTER_FAULT",
    "S0_PRINTER_ERR",
    "S0_FISCAL_FAULT",
    "S2_OVERHEAT",
    "S1_RIBBON_END",
];
const RECEIPT_OPEN: &[&str] = &[
    "X_FISCAL_RECEIPT_OPEN",
    "X_NONFISCAL_RECEIPT_OPEN",
    "S2_FISCAL_OPEN",
    "S2_NONFISCAL_OPEN",
];
/// Warnings that do not have their own boolean.
const OTHER_WARNINGS: &[&str] = &["X_NOT_FISCALISED", "X_CLOCK", "S0_CLOCK_NOT_SET"];

fn any(codes: &[String], set: &[&str]) -> bool {
    codes.iter().any(|c| set.contains(&c.as_str()))
}

/// Summary of an answered STATUS. `z_required` = providers::z_report_required().
pub fn from_status(s: &FiscalStatus, z_required: bool, now: u64) -> RegisterStatus {
    let codes = s.codes.clone();
    let paper_out = any(&codes, PAPER_OUT);
    let paper_near_end = any(&codes, PAPER_NEAR_END);
    let cover_open = any(&codes, COVER_OPEN);
    let fiscal_memory_near_full = any(&codes, FM_NEAR_FULL);
    let fiscal_memory_error = any(&codes, FM_ERROR);
    let printer_error = any(&codes, PRINTER_ERROR);
    let receipt_open = any(&codes, RECEIPT_OPEN);

    let hw_blocked = paper_out || cover_open || printer_error || fiscal_memory_error;
    let state = if hw_blocked || z_required {
        RegisterState::Blocked
    } else if paper_near_end || fiscal_memory_near_full || receipt_open || any(&codes, OTHER_WARNINGS) {
        RegisterState::Warning
    } else {
        RegisterState::Ok
    };
    // The decoder's message is the most important flag (blocking first);
    // „Z necesar” comes right after a hardware block.
    let message = if hw_blocked {
        s.error_message.clone()
    } else if z_required {
        Some(Z_REQUIRED_RO.to_string())
    } else {
        s.error_message.clone()
    };
    RegisterStatus {
        state,
        connected: true,
        paper_out,
        paper_near_end,
        cover_open,
        fiscal_memory_near_full,
        fiscal_memory_error,
        z_report_required: z_required,
        printer_error,
        receipt_open,
        message,
        codes,
        checked_at: now,
    }
}

/// Summary when the STATUS got no (valid) answer. `message` is the reason
/// already put in Romanian by the caller.
pub fn no_answer(message: String, z_required: bool, now: u64) -> RegisterStatus {
    RegisterStatus {
        state: RegisterState::NoAnswer,
        connected: false,
        paper_out: false,
        paper_near_end: false,
        cover_open: false,
        fiscal_memory_near_full: false,
        fiscal_memory_error: false,
        z_report_required: z_required,
        printer_error: false,
        receipt_open: false,
        message: Some(message),
        codes: Vec::new(),
        checked_at: now,
    }
}

static LATEST: Mutex<Option<RegisterStatus>> = Mutex::new(None);

/// Store the result of the last check (None = not monitored: no register
/// configured, or the simulator).
pub fn set_latest(s: Option<RegisterStatus>) {
    if let Ok(mut g) = LATEST.lock() {
        *g = s;
    }
}

pub fn latest() -> Option<RegisterStatus> {
    LATEST.lock().ok().and_then(|g| g.clone())
}

/// What the heartbeat carries as `printer` (null when not monitored). The
/// server ignores unknown heartbeat fields today, so this is safe to send.
pub fn heartbeat_payload() -> serde_json::Value {
    latest()
        .and_then(|s| serde_json::to_value(s).ok())
        .unwrap_or(serde_json::Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fiscal::mapping::status::decode_x_minimal;

    /// The owner's DP-25X, 2026-10-14 (fiscalised, no problem).
    const OWNER: [u8; 8] = [0x80, 0x84, 0x80, 0x80, 0x86, 0x9a, 0x80, 0x80];

    fn with(byte: usize, mask: u8) -> [u8; 8] {
        let mut s = OWNER;
        s[byte] |= mask;
        s
    }

    fn reg(bytes: &[u8], z: bool) -> RegisterStatus {
        from_status(&decode_x_minimal(bytes), z, 1000)
    }

    #[test]
    fn owner_register_is_ok() {
        let r = reg(&OWNER, false);
        assert_eq!(r.state, RegisterState::Ok);
        assert!(r.connected && r.message.is_none() && r.codes.is_empty());
        assert_eq!(r.checked_at, 1000);
    }

    #[test]
    fn paper_out_blocks() {
        let r = reg(&with(2, 0x01), false);
        assert_eq!(r.state, RegisterState::Blocked);
        assert!(r.paper_out && !r.paper_near_end);
        assert!(r.message.unwrap().contains("hârtie"));
    }

    #[test]
    fn paper_near_end_warns() {
        let r = reg(&with(2, 0x02), false);
        assert_eq!(r.state, RegisterState::Warning);
        assert!(r.paper_near_end && !r.paper_out);
    }

    #[test]
    fn cover_open_blocks() {
        let r = reg(&with(0, 0x40), false);
        assert_eq!(r.state, RegisterState::Blocked);
        assert!(r.cover_open);
        assert!(r.message.unwrap().starts_with("Capacul"));
    }

    #[test]
    fn fiscal_memory_near_full_warns_and_full_blocks() {
        let near = reg(&with(4, 0x08), false);
        assert_eq!(near.state, RegisterState::Warning);
        assert!(near.fiscal_memory_near_full && !near.fiscal_memory_error);
        let ej_near = reg(&with(2, 0x10), false);
        assert!(ej_near.fiscal_memory_near_full);
        let full = reg(&with(4, 0x10), false);
        assert_eq!(full.state, RegisterState::Blocked);
        assert!(full.fiscal_memory_error);
    }

    #[test]
    fn printer_fault_blocks() {
        let r = reg(&with(0, 0x30), false);
        assert_eq!(r.state, RegisterState::Blocked);
        assert!(r.printer_error);
    }

    #[test]
    fn receipt_left_open_warns() {
        let r = reg(&with(2, 0x08), false);
        assert_eq!(r.state, RegisterState::Warning);
        assert!(r.receipt_open);
    }

    #[test]
    fn z_required_blocks_with_its_own_message() {
        let r = reg(&OWNER, true);
        assert_eq!(r.state, RegisterState::Blocked);
        assert!(r.z_report_required);
        assert_eq!(r.message.as_deref(), Some(Z_REQUIRED_RO));
        // A hardware block is told first (it must be fixed before the Z).
        let both = reg(&with(2, 0x01), true);
        assert!(both.z_report_required && both.paper_out);
        assert!(both.message.unwrap().contains("hârtie"));
        // A warning does not hide the Z message.
        let warn = reg(&with(2, 0x02), true);
        assert_eq!(warn.message.as_deref(), Some(Z_REQUIRED_RO));
    }

    #[test]
    fn no_answer_is_not_connected() {
        let r = no_answer("Casa de marcat nu răspunde".into(), false, 5);
        assert_eq!(r.state, RegisterState::NoAnswer);
        assert!(!r.connected);
        assert_eq!(r.message.as_deref(), Some("Casa de marcat nu răspunde"));
    }

    #[test]
    fn serialises_camel_case_for_the_web_pos() {
        let v = serde_json::to_value(reg(&with(2, 0x01), false)).unwrap();
        assert_eq!(v["state"], "blocked");
        assert_eq!(v["paperOut"], true);
        assert_eq!(v["zReportRequired"], false);
        assert_eq!(v["fiscalMemoryNearFull"], false);
        assert!(v["codes"].as_array().unwrap().iter().any(|c| c == "X_PAPER_OUT"));
        let n = serde_json::to_value(no_answer("x".into(), false, 1)).unwrap();
        assert_eq!(n["state"], "no_answer");
    }

    #[test]
    fn latest_round_trip_and_heartbeat_payload() {
        set_latest(None);
        assert!(heartbeat_payload().is_null());
        set_latest(Some(reg(&OWNER, false)));
        assert_eq!(heartbeat_payload()["state"], "ok");
        set_latest(None);
    }
}
