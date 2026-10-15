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
    pub byte: u8,         // 0..=5 (legacy), 0..=7 (X dialect)
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

// ---------------------------------------------------------------------------
// DP-25X / FP-700X ("X dialect") — 8 status bytes after the 0x04 separator
// inside every answer's DATA (the legacy 6-byte field above does not exist
// there; decode_full would always see zeros = "ready").
//
// Bit table — Datecs FMP-350X/FMP-55X/FP-700X/DP-25X Programmer's Manual
// v2.02, "Status bits" (bit 7 of every byte is always 1; '#' bits are ORed
// into 0.5 "general error"):
//   S0: 6 cover open · 5 general error · 4# printing mechanism failure ·
//       2 clock not synchronized · 1# invalid command code · 0# syntax error
//   S1: 1# command not permitted · 0# overflow during execution
//   S2: 5 non-fiscal receipt open · 4 EJ nearly full · 3 fiscal receipt
//       open · 2 EJ full · 1 near paper end · 0# end of paper
//   S4: 6 FM not found/damaged · 5 OR of '*' · 4* FM full · 3 room for
//       less than 60 reports · 2 serial+FM number set · 1 tax number set ·
//       0* FM access error
//   S5: 4 VAT set · 3 fiscalised · 1 FM formatted
//   S3, S6, S7: unused.
// S0.0/0.1/1.0/1.1 describe the LAST command, not the register — kept as
// info only. The owner's register sends S1 = 0x84 (bit 2, documented as
// "always 0"): not interpreted, it stays visible in `raw`.

/// Decode the 8 X-dialect status bytes. Fewer than 6 bytes, or bytes
/// without the always-1 bit 7, are not a status field: returned as "no
/// information" (ready, no flags) with the raw dump, never as an error.
pub fn decode_x(status: &[u8]) -> FullStatus {
    let raw = status
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ");
    let valid = status.len() >= 6 && status.iter().take(6).all(|b| b & 0x80 != 0);
    let mut flags: Vec<StatusFlag> = Vec::new();
    if valid {
        let s = |byte: usize, idx: u8| status.get(byte).map(|b| bit(*b, idx)).unwrap_or(false);
        let mut push = |byte: u8, idx: u8, code: &'static str, sev: Severity, msg: &'static str| {
            if s(byte as usize, idx) {
                flags.push(flag(byte, idx, code, sev, msg));
            }
        };
        use Severity::{Blocking, Info, Warning};
        // Blocking — printing cannot work until someone fixes it.
        push(0, 6, "X_COVER_OPEN", Blocking, "Capacul casei este deschis — închide-l, apoi încearcă din nou.");
        push(2, 0, "X_PAPER_OUT", Blocking, "Casa nu mai are hârtie — pune o rolă nouă și închide capacul.");
        push(0, 4, "X_PRINTER_FAULT", Blocking, "Mecanismul de tipărire al casei are o problemă — verifică rola și capacul, apoi oprește și pornește casa.");
        push(2, 2, "X_EJ_FULL", Blocking, "Jurnalul electronic al casei este plin — sună service-ul casei.");
        push(4, 4, "X_FM_FULL", Blocking, "Memoria fiscală a casei este plină — sună service-ul casei.");
        push(4, 6, "X_FM_MISSING", Blocking, "Memoria fiscală a casei lipsește sau e defectă — sună service-ul casei.");
        push(4, 0, "X_FM_ACCESS", Blocking, "Memoria fiscală a casei nu poate fi citită — sună service-ul casei.");
        // A document left open: not an error, but a new bon cannot start.
        push(2, 3, "X_FISCAL_RECEIPT_OPEN", Info, "Pe casă a rămas deschis un bon fiscal — termină-l sau anulează-l din meniul casei.");
        push(2, 5, "X_NONFISCAL_RECEIPT_OPEN", Info, "Pe casă a rămas deschis un bon nefiscal — închide-l din meniul casei.");
        // Warnings — printing still works.
        push(2, 1, "X_PAPER_NEAR_END", Warning, "Hârtia din casă e pe terminate — pregătește o rolă nouă.");
        push(2, 4, "X_EJ_NEAR_FULL", Warning, "Jurnalul electronic al casei e aproape plin — anunță service-ul casei.");
        push(4, 3, "X_FM_NEAR_FULL", Warning, "Memoria fiscală mai are loc pentru mai puțin de 60 de rapoarte Z — anunță service-ul casei.");
        push(0, 2, "X_CLOCK", Warning, "Ceasul casei nu este sincronizat — verifică data și ora pe casă.");
        // Last-command bits: shown in diagnostics only.
        push(0, 0, "X_LAST_SYNTAX", Info, "Ultima comandă a avut o eroare de sintaxă.");
        push(0, 1, "X_LAST_INVALID", Info, "Ultima comandă nu e cunoscută de casă.");
        push(1, 0, "X_LAST_OVERFLOW", Info, "Ultima comandă a depășit o limită.");
        push(1, 1, "X_LAST_NOT_PERMITTED", Info, "Ultima comandă nu era permisă în starea casei.");
        if !s(5, 3) {
            flags.push(flag(5, 3, "X_NOT_FISCALISED", Warning, "Casa nu este fiscalizată — bonurile nu sunt fiscale. Cheamă service-ul casei."));
        }
    }

    let first = |sev: Severity| flags.iter().find(|f| f.severity == sev);
    let open = flags
        .iter()
        .find(|f| f.code == "X_FISCAL_RECEIPT_OPEN" || f.code == "X_NONFISCAL_RECEIPT_OPEN");
    let paper_ok = !flags.iter().any(|f| f.code == "X_PAPER_OUT");

    let (ready, busy, shown) = if let Some(b) = first(Severity::Blocking) {
        (false, false, Some(b))
    } else if let Some(o) = open {
        (false, true, Some(o))
    } else {
        (true, false, first(Severity::Warning))
    };

    FullStatus {
        online: true,
        paper_ok,
        ready,
        busy,
        error_code: shown.map(|f| f.code.to_string()),
        error_message: shown.map(|f| f.message_ro.to_string()),
        raw: Some(raw),
        flags,
    }
}

/// `FiscalStatus` from the X-dialect status bytes.
pub fn decode_x_minimal(status: &[u8]) -> FiscalStatus {
    let full = decode_x(status);
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

#[cfg(test)]
mod x_tests {
    use super::*;

    /// The owner's DP-25X, 2026-10-14 (fiscalised, no problem).
    const OWNER: [u8; 8] = [0x80, 0x84, 0x80, 0x80, 0x86, 0x9a, 0x80, 0x80];

    fn with(byte: usize, mask: u8) -> [u8; 8] {
        let mut s = OWNER;
        s[byte] |= mask;
        s
    }

    #[test]
    fn owner_register_is_ready_without_message() {
        let s = decode_x(&OWNER);
        assert!(s.online && s.ready && s.paper_ok && !s.busy);
        assert!(s.error_code.is_none() && s.error_message.is_none());
        assert!(s.flags.is_empty());
        assert_eq!(s.raw.as_deref(), Some("80 84 80 80 86 9A 80 80"));
    }

    #[test]
    fn paper_out_blocks_and_clears_paper_ok() {
        let s = decode_x(&with(2, 0x01));
        assert!(!s.ready && !s.paper_ok);
        assert_eq!(s.error_code.as_deref(), Some("X_PAPER_OUT"));
        assert!(s.error_message.unwrap().contains("hârtie"));
    }

    #[test]
    fn paper_near_end_is_a_warning_still_ready() {
        let s = decode_x(&with(2, 0x02));
        assert!(s.ready && s.paper_ok);
        assert_eq!(s.error_code.as_deref(), Some("X_PAPER_NEAR_END"));
        assert!(s.error_message.unwrap().contains("pe terminate"));
    }

    #[test]
    fn cover_open_blocks() {
        let s = decode_x(&with(0, 0x40));
        assert!(!s.ready);
        assert!(s.paper_ok);
        assert_eq!(s.error_code.as_deref(), Some("X_COVER_OPEN"));
        assert!(s.error_message.unwrap().starts_with("Capacul casei este deschis"));
    }

    #[test]
    fn printer_fault_blocks() {
        // 0.4 failure + 0.5 general error (OR of the '#' bits).
        let s = decode_x(&with(0, 0x30));
        assert!(!s.ready);
        assert_eq!(s.error_code.as_deref(), Some("X_PRINTER_FAULT"));
    }

    #[test]
    fn fiscal_receipt_open_is_busy_with_message() {
        let s = decode_x(&with(2, 0x08));
        assert!(!s.ready && s.busy);
        assert_eq!(s.error_code.as_deref(), Some("X_FISCAL_RECEIPT_OPEN"));
        assert!(s.error_message.unwrap().contains("bon fiscal"));
    }

    #[test]
    fn blocking_wins_over_open_receipt_and_warnings() {
        let mut st = with(2, 0x08 | 0x02); // receipt open + near paper end
        st[0] |= 0x40; // cover open
        let s = decode_x(&st);
        assert_eq!(s.error_code.as_deref(), Some("X_COVER_OPEN"));
        assert_eq!(s.flags.len(), 3);
    }

    #[test]
    fn fiscal_memory_problems_block() {
        assert_eq!(decode_x(&with(4, 0x10)).error_code.as_deref(), Some("X_FM_FULL"));
        assert_eq!(decode_x(&with(4, 0x40)).error_code.as_deref(), Some("X_FM_MISSING"));
        assert_eq!(decode_x(&with(2, 0x04)).error_code.as_deref(), Some("X_EJ_FULL"));
    }

    #[test]
    fn last_command_bits_do_not_block() {
        let s = decode_x(&with(0, 0x01));
        assert!(s.ready);
        assert!(s.error_code.is_none());
        assert!(s.flags.iter().any(|f| f.code == "X_LAST_SYNTAX"));
    }

    #[test]
    fn not_fiscalised_is_a_warning() {
        let mut st = OWNER;
        st[5] = 0x92; // fiscalised bit 3 cleared
        let s = decode_x(&st);
        assert!(s.ready);
        assert_eq!(s.error_code.as_deref(), Some("X_NOT_FISCALISED"));
    }

    #[test]
    fn missing_or_garbage_status_is_no_information() {
        for st in [&[][..], &[0x80, 0x80][..], &[0, 0, 0, 0, 0, 0, 0, 0][..]] {
            let s = decode_x(st);
            assert!(s.ready && s.flags.is_empty() && s.error_code.is_none());
        }
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
