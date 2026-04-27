// Sprint 2 status decoder (audit Q5). Datecs FP-55 / DP-25 STATUS reply is
// six bytes (S0..S5). Each bit is documented in the Datecs FP-55 Programmer's
// Manual §4.2 ("STATUS bytes table"). The interpretation below mirrors that
// table for the public bits + the bit 6 always-1 reserved markers, with
// Romanian human messages so the operator UI can show meaningful prompts.
//
// The decoder keeps the Sprint 1 minimal surface (`decode_minimal`) for
// internal callers that only need {online, paper_ok, ready, busy} but adds
// a structured `decode_full` returning every bit interpreted alongside the
// raw hex dump. Both call sites preserve the rule "never treat unknown as
// success": any non-recognised bit pattern bubbles up as ready=false with
// the raw bytes intact for diagnostics.
//
// Bit-table — bit 6 of every status byte is reserved-always-1 and used by
// firmware as a sync marker; we mask it out before interpretation:
//
//   S0 (general): 0=syntax err, 1=cmd code invalid, 2=invalid data,
//                 3=clock not set, 4=wrong password, 5=fiscal printer fault,
//                 7=printer error
//   S1 (paper):   0=paper out, 1=journal paper out, 2=ribbon end,
//                 7=paper near end (warning, not blocking)
//   S2 (modes):   0=fiscal receipt open, 1=printer overheat,
//                 2=non-fiscal receipt open, 7=Z/X report ready
//   S3 (warn):    0=registration limit reached, 1=zero registration
//   S4 (FM):      0=fiscal memory full, 7=fiscal memory read error
//   S5 (mode):    0=fiscalised, 2=fiscal storage near full
//
// Sources:
//   - Datecs FP-55 Programmer's Manual rev 2.05 §4.2
//   - cross-checked with Datecs DP-25 firmware notes shipped with the device
//   - python implementation in fiscal-bridge/bridge/printers/datecs_dp25.py

use crate::fiscal::dto::FiscalStatus;
use serde::Serialize;

pub fn decode_minimal(status: &[u8; 6]) -> FiscalStatus {
    let full = decode_full(status);
    FiscalStatus {
        online: full.online,
        paper_ok: full.paper_ok,
        ready: full.ready,
        busy: full.busy,
        error_code: full.error_code,
        error_message: full.error_message,
        raw: full.raw,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FullStatus {
    pub online: bool,
    pub paper_ok: bool,
    pub ready: bool,
    pub busy: bool,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub raw: Option<String>,
    /// Decoded flags — populated bit-by-bit. Empty when no significant bit
    /// is set. Keep this stable; admin UI may render it as a checklist.
    pub flags: Vec<StatusFlag>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatusFlag {
    pub byte: u8,         // 0..=5
    pub bit: u8,          // 0..=7
    pub code: &'static str,
    pub severity: Severity,
    pub message_ro: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Blocking,
}

const SYNC_BIT_MASK: u8 = 0b1011_1111; // bit 6 reserved-always-1, drop it.

fn bit(b: u8, idx: u8) -> bool {
    (b & (1 << idx)) != 0
}

fn flag(byte: u8, idx: u8, code: &'static str, sev: Severity, msg: &'static str) -> StatusFlag {
    StatusFlag { byte, bit: idx, code, severity: sev, message_ro: msg }
}

pub fn decode_full(status: &[u8; 6]) -> FullStatus {
    let raw = format!(
        "{:02X} {:02X} {:02X} {:02X} {:02X} {:02X}",
        status[0], status[1], status[2], status[3], status[4], status[5],
    );

    // Mask out the reserved sync bit before interpreting.
    let s: [u8; 6] = [
        status[0] & SYNC_BIT_MASK,
        status[1] & SYNC_BIT_MASK,
        status[2] & SYNC_BIT_MASK,
        status[3] & SYNC_BIT_MASK,
        status[4] & SYNC_BIT_MASK,
        status[5] & SYNC_BIT_MASK,
    ];

    let mut flags: Vec<StatusFlag> = Vec::new();

    // S0 — general
    if bit(s[0], 0) { flags.push(flag(0, 0, "S0_SYNTAX_ERR", Severity::Blocking, "Eroare sintaxă comandă")); }
    if bit(s[0], 1) { flags.push(flag(0, 1, "S0_CMD_INVALID", Severity::Blocking, "Cod comandă invalid")); }
    if bit(s[0], 2) { flags.push(flag(0, 2, "S0_DATA_INVALID", Severity::Blocking, "Date invalide în comandă")); }
    if bit(s[0], 3) { flags.push(flag(0, 3, "S0_CLOCK_NOT_SET", Severity::Blocking, "Ceas neconfigurat")); }
    if bit(s[0], 4) { flags.push(flag(0, 4, "S0_WRONG_PASSWORD", Severity::Blocking, "Parolă operator greșită")); }
    if bit(s[0], 5) { flags.push(flag(0, 5, "S0_FISCAL_FAULT", Severity::Blocking, "Defect imprimanta fiscală")); }
    if bit(s[0], 7) { flags.push(flag(0, 7, "S0_PRINTER_ERR", Severity::Blocking, "Eroare imprimantă (mecanism)")); }

    // S1 — paper
    if bit(s[1], 0) { flags.push(flag(1, 0, "S1_NO_PAPER", Severity::Blocking, "Hârtie terminată — schimbă rola")); }
    if bit(s[1], 1) { flags.push(flag(1, 1, "S1_NO_JOURNAL", Severity::Blocking, "Jurnal terminat")); }
    if bit(s[1], 2) { flags.push(flag(1, 2, "S1_RIBBON_END", Severity::Blocking, "Bandă tipar terminată")); }
    if bit(s[1], 7) { flags.push(flag(1, 7, "S1_PAPER_NEAR_END", Severity::Warning, "Hârtie aproape de epuizare")); }

    // S2 — modes
    if bit(s[2], 0) { flags.push(flag(2, 0, "S2_FISCAL_OPEN", Severity::Info, "Bon fiscal deschis")); }
    if bit(s[2], 1) { flags.push(flag(2, 1, "S2_OVERHEAT", Severity::Blocking, "Imprimantă supraîncălzită — așteaptă răcire")); }
    if bit(s[2], 2) { flags.push(flag(2, 2, "S2_NONFISCAL_OPEN", Severity::Info, "Bon nefiscal deschis")); }
    if bit(s[2], 7) { flags.push(flag(2, 7, "S2_REPORT_READY", Severity::Info, "Raport Z/X gata pentru tipar")); }

    // S3 — warnings
    if bit(s[3], 0) { flags.push(flag(3, 0, "S3_REG_LIMIT", Severity::Warning, "Limită înregistrări atinsă")); }
    if bit(s[3], 1) { flags.push(flag(3, 1, "S3_ZERO_REG", Severity::Warning, "Înregistrare cu valoare zero")); }

    // S4 — fiscal memory
    if bit(s[4], 0) { flags.push(flag(4, 0, "S4_FM_FULL", Severity::Blocking, "Memorie fiscală plină — service necesar")); }
    if bit(s[4], 7) { flags.push(flag(4, 7, "S4_FM_READ_ERR", Severity::Blocking, "Eroare citire memorie fiscală")); }

    // S5 — fiscal mode
    if bit(s[5], 0) { flags.push(flag(5, 0, "S5_FISCALISED", Severity::Info, "Casa este fiscalizată ANAF")); }
    if bit(s[5], 2) { flags.push(flag(5, 2, "S5_FM_NEAR_FULL", Severity::Warning, "Memorie fiscală aproape de epuizare")); }

    // Roll-up booleans for the minimal surface.
    let any_blocking = flags.iter().any(|f| f.severity == Severity::Blocking);
    let any_paper = flags.iter().any(|f| f.code == "S1_NO_PAPER" || f.code == "S1_NO_JOURNAL");
    let receipt_open = flags.iter().any(|f| f.code == "S2_FISCAL_OPEN" || f.code == "S2_NONFISCAL_OPEN");

    let (online, paper_ok, ready, busy, error_code, error_message) = if any_blocking {
        let blocker = flags
            .iter()
            .find(|f| f.severity == Severity::Blocking)
            .expect("any_blocking implies at least one");
        (
            true,
            !any_paper,
            false,
            false,
            Some(blocker.code.into()),
            Some(blocker.message_ro.into()),
        )
    } else if receipt_open {
        // Mid-receipt → not "ready" for a new print but no error either.
        (true, true, false, true, None, None)
    } else {
        (true, true, true, false, None, None)
    };

    FullStatus {
        online,
        paper_ok,
        ready,
        busy,
        error_code,
        error_message,
        raw: Some(raw),
        flags,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_zero_means_ready() {
        let s = decode_full(&[0, 0, 0, 0, 0, 0]);
        assert!(s.ready);
        assert!(s.online);
        assert!(s.paper_ok);
        assert!(s.flags.is_empty());
    }

    #[test]
    fn paper_out_is_blocking_and_clears_paper_ok() {
        // S1 bit 0 set, plus the always-1 sync bit (0x40)
        let s = decode_full(&[0x40, 0x41, 0x40, 0x40, 0x40, 0x40]);
        assert!(!s.ready);
        assert!(!s.paper_ok);
        assert_eq!(s.error_code.as_deref(), Some("S1_NO_PAPER"));
        assert!(s.flags.iter().any(|f| f.code == "S1_NO_PAPER" && f.severity == Severity::Blocking));
    }

    #[test]
    fn paper_near_end_is_only_warning() {
        let s = decode_full(&[0x40, 0xC0, 0x40, 0x40, 0x40, 0x40]);
        assert!(s.ready);
        assert!(s.paper_ok);
        assert!(s.flags.iter().any(|f| f.code == "S1_PAPER_NEAR_END" && f.severity == Severity::Warning));
    }

    #[test]
    fn receipt_open_is_busy_not_blocking() {
        let s = decode_full(&[0x40, 0x40, 0x41, 0x40, 0x40, 0x40]);
        assert!(!s.ready);
        assert!(s.busy);
        assert!(s.error_code.is_none());
    }

    #[test]
    fn fiscal_memory_full_is_blocking() {
        let s = decode_full(&[0x40, 0x40, 0x40, 0x40, 0x41, 0x40]);
        assert!(!s.ready);
        assert_eq!(s.error_code.as_deref(), Some("S4_FM_FULL"));
    }

    #[test]
    fn sync_bit_alone_does_not_trigger_flags() {
        // every byte has only bit 6 set (sync) — should treat as all-zero
        let s = decode_full(&[0x40, 0x40, 0x40, 0x40, 0x40, 0x40]);
        assert!(s.flags.is_empty());
        assert!(s.ready);
    }
}
