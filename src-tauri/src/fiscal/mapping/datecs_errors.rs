// Sprint 2 / Q6 — Datecs error code mapper.
//
// Datecs FP-55 / DP-25 returns errors as either a NAK byte (0x15 — "command
// rejected, no detail") or as `ER:NN` text inside the response data section,
// where NN is a two-digit decimal code documented in the FP-55 Programmer's
// Manual §6 ("Error codes"). The Python bridge collapsed all of this into a
// single "raw NAK" bucket; the Rust port maps the codes we know about into
// structured `FiscalError` variants with Romanian operator messages.
//
// Source: Datecs FP-55 manual rev 2.05 §6 + cross-checked against the
// firmware notes shipped with DP-25 units. Codes not in the table fall
// through to `UnknownFiscalError` with the raw text preserved.

use crate::fiscal::error::FiscalError;

/// Map an `ER:NN` payload (or just the `NN` digits) to a structured error.
/// Accepts both `ER:01`, `ER:1`, and bare `01`/`1` forms; whitespace is
/// trimmed.
pub fn map_er_code(raw: &str) -> FiscalError {
    let cleaned = raw.trim();
    let digits = cleaned.strip_prefix("ER:").unwrap_or(cleaned).trim();
    let code: u32 = digits.parse().unwrap_or(0);
    match code {
        // 01-09 — communication / syntax
        1 => FiscalError::CommunicationError {
            detail: "ER:01 — comandă lipsă sau greșit formatată".into(),
        },
        2 => FiscalError::InvalidCommand {
            detail: "ER:02 — date invalide în comandă".into(),
        },
        3 => FiscalError::InvalidCommand {
            detail: "ER:03 — comandă necunoscută în acest mod".into(),
        },
        4 => FiscalError::ConfigurationError {
            detail: "ER:04 — parolă operator greșită".into(),
        },
        5 => FiscalError::ConfigurationError {
            detail: "ER:05 — operator inactiv".into(),
        },
        6 => FiscalError::PrinterBusy,

        // 10-19 — paper / mechanism
        10 => FiscalError::PaperError { detail: "ER:10 — hârtie terminată".into() },
        11 => FiscalError::PaperError { detail: "ER:11 — jurnal terminat".into() },
        12 => FiscalError::PaperError { detail: "ER:12 — capac deschis".into() },
        13 => FiscalError::CommunicationError {
            detail: "ER:13 — temperatură imprimantă prea mare".into(),
        },

        // 20-29 — receipt state
        20 => FiscalError::InvalidCommand {
            detail: "ER:20 — bon fiscal deja deschis".into(),
        },
        21 => FiscalError::InvalidCommand {
            detail: "ER:21 — niciun bon fiscal deschis".into(),
        },
        22 => FiscalError::InvalidCommand {
            detail: "ER:22 — bon nefiscal deja deschis".into(),
        },
        23 => FiscalError::InvalidCommand {
            detail: "ER:23 — operațiune permisă doar în bon nefiscal".into(),
        },
        24 => FiscalError::InvalidCommand {
            detail: "ER:24 — articol cu cantitate sau preț invalid".into(),
        },
        25 => FiscalError::InvalidCommand {
            detail: "ER:25 — discount/majorare invalid".into(),
        },
        26 => FiscalError::InvalidCommand {
            detail: "ER:26 — total bon depășește limita".into(),
        },

        // 30-39 — fiscal memory
        30 => FiscalError::FiscalMemoryError {
            detail: "ER:30 — memorie fiscală plină".into(),
        },
        31 => FiscalError::FiscalMemoryError {
            detail: "ER:31 — memorie fiscală indisponibilă".into(),
        },
        32 => FiscalError::FiscalMemoryError {
            detail: "ER:32 — eroare scriere memorie fiscală".into(),
        },
        33 => FiscalError::NotFiscalized {
            detail: "ER:33 — casa nu este fiscalizată ANAF".into(),
        },

        // 40-49 — clock / mode
        40 => FiscalError::ConfigurationError {
            detail: "ER:40 — ceas neconfigurat".into(),
        },
        41 => FiscalError::ConfigurationError {
            detail: "ER:41 — dată/oră invalidă".into(),
        },
        42 => FiscalError::InvalidCommand {
            detail: "ER:42 — operațiune permisă doar înainte de Z".into(),
        },
        43 => FiscalError::InvalidCommand {
            detail: "ER:43 — operațiune permisă doar după Z".into(),
        },

        _ => FiscalError::UnknownFiscalError {
            detail: format!("Datecs raw error: {cleaned}"),
        },
    }
}

/// Inspect a raw response data buffer for an `ER:NN` marker and map it.
/// Returns None if no such marker is found, allowing callers to fall back
/// to a generic NAK error path. Accepts both ASCII and CP1250-decoded text.
pub fn try_map_response_text(text: &str) -> Option<FiscalError> {
    let upper = text.to_uppercase();
    let idx = upper.find("ER:")?;
    let tail = &text[idx..];
    // Pull at most 6 chars from the marker (ER:99) to avoid attaching the
    // whole receipt body to the error message.
    let slice: String = tail.chars().take(6).collect();
    Some(map_er_code(&slice))
}

// ---------------------------------------------------------------------------
// DP-25X / FP-700X ("X dialect") — ErrorCode in the first answer field.
//
// Every DP-25X reply DATA is `{ErrorCode}<SEP>{fields…}<SEP>` 0x04 S0..S7.
// ErrorCode 0 = command passed; a negative number = refused. The Datecs
// manual we have (FMP-350X/FMP-55X/FP-700X/DP-25X Programmer's Manual,
// shipped with ErpNet.FP) does NOT list the numeric codes, so the table below
// only holds codes we have actually seen on the owner's DP-25X (2026-10-14)
// and could tie to a cause from the command sequence:
//
//   -111024  open_fiscal refused on a register with no recent Z; every later
//            step then answered -111016 → "Z report required (24 h)".
//   -111016  register_item / payment / close after the refused open →
//            "no fiscal receipt open".
//   -112001  subtotal with an empty body and report 0x45 with "0" (both
//            violate the documented parameter syntax) → "syntax / invalid
//            parameter".
//
// Everything else is explained from the 8 STATUS bytes that come with the
// same answer (bit layout from ErpNet.FP BgDatecsXIslFiscalPrinter, which
// matches the owner's capture: S4=0x86 tax no.+FM serial set, S5=0x9a FM
// formatted + fiscalised + VAT set). Codes we can't explain are shown as
// „Casa a refuzat … (cod X)" — never guessed.

/// Reason + what to do, for one refusal. Reasons contain no '.' so the TS
/// side can split "reason. hint" reliably.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceErrorInfo {
    pub reason: &'static str,
    pub hint: &'static str,
}

/// Known DP-25X ErrorCodes (see the table comment above).
pub fn describe_device_code(code: i64) -> Option<DeviceErrorInfo> {
    match code {
        -111024 => Some(DeviceErrorInfo {
            reason: "Este necesar raportul Z (au trecut 24 de ore)",
            hint: "Fă raportul Z de la casă sau din Rapoarte fiscale → Z, apoi încearcă din nou.",
        }),
        -111016 => Some(DeviceErrorInfo {
            reason: "Nu este deschis niciun bon fiscal pe casă",
            hint: "Deschiderea bonului nu a reușit înainte. Încearcă din nou bonul întreg.",
        }),
        -112001 => Some(DeviceErrorInfo {
            reason: "Comanda are parametri pe care casa nu îi acceptă (eroare de sintaxă)",
            hint: "Trimite-ne diagnosticul din „Avansat (service)”: casa așteaptă alt format.",
        }),
        _ => None,
    }
}

fn bit(status: &[u8], byte: usize, bit: u8) -> bool {
    status.get(byte).map(|b| b & (1u8 << bit) != 0).unwrap_or(false)
}

/// Explain a refusal from the DP-25X status bytes (S0..S7 after 0x04).
/// `opening` = the refused command was the one that opens a receipt; only
/// then does "a receipt is already open" explain the refusal.
pub fn describe_status_bits(status: &[u8], opening: bool) -> Option<DeviceErrorInfo> {
    fn info(reason: &'static str, hint: &'static str) -> Option<DeviceErrorInfo> {
        Some(DeviceErrorInfo { reason, hint })
    }
    if bit(status, 0, 6) {
        return info("Capacul casei este deschis", "Închide capacul și încearcă din nou.");
    }
    if bit(status, 2, 0) {
        return info("Casa nu mai are hârtie", "Pune o rolă nouă, închide capacul și încearcă din nou.");
    }
    if bit(status, 4, 4) {
        return info("Memoria fiscală este plină", "Sună service-ul casei.");
    }
    if bit(status, 4, 6) || bit(status, 4, 0) {
        return info("Memoria fiscală nu poate fi citită", "Sună service-ul casei.");
    }
    if bit(status, 2, 2) {
        return info("Jurnalul electronic este plin", "Sună service-ul casei.");
    }
    if bit(status, 0, 4) {
        return info("Mecanismul de tipărire are o problemă", "Verifică rola și capacul, apoi oprește și pornește casa.");
    }
    if bit(status, 0, 2) {
        return info("Ceasul casei nu este setat", "Setează data și ora din meniul casei sau cere service-ului.");
    }
    if opening && bit(status, 2, 3) {
        return info(
            "Pe casă e deja deschis un bon fiscal",
            "Închide sau anulează bonul din meniul casei, apoi încearcă din nou.",
        );
    }
    if opening && bit(status, 2, 5) {
        return info(
            "Pe casă e deja deschis un bon nefiscal",
            "Închide bonul din meniul casei, apoi încearcă din nou.",
        );
    }
    if bit(status, 1, 1) {
        return info(
            "Comanda nu este permisă acum",
            "Verifică pe ecranul casei să nu fie un meniu sau un bon deschis.",
        );
    }
    None
}

/// Build the error for a refused command. `action` is what was refused, in
/// Romanian with article ("bonul", "raportul X", …).
pub fn device_error(code: i64, action: &str, status: &[u8], opening: bool) -> FiscalError {
    let info = describe_device_code(code).or_else(|| describe_status_bits(status, opening));
    let message = match info {
        Some(i) => format!("Casa a refuzat {action}: {}. {} (cod {code})", i.reason, i.hint),
        None => format!("Casa a refuzat {action} (cod {code})."),
    };
    FiscalError::Device { code, message }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER_STATUS: [u8; 8] = [0x80, 0x84, 0x80, 0x80, 0x86, 0x9a, 0x80, 0x80];

    #[test]
    fn z_required_message_is_romanian_and_has_code() {
        let e = device_error(-111024, "bonul", &OWNER_STATUS, true);
        assert_eq!(
            e.to_string(),
            "Casa a refuzat bonul: Este necesar raportul Z (au trecut 24 de ore). \
             Fă raportul Z de la casă sau din Rapoarte fiscale → Z, apoi încearcă din nou. (cod -111024)"
        );
        assert!(matches!(e, FiscalError::Device { code: -111024, .. }));
    }

    #[test]
    fn owner_status_bytes_explain_nothing_by_themselves() {
        // Fiscalised register, no paper/cover/FM problem.
        assert_eq!(describe_status_bits(&OWNER_STATUS, true), None);
    }

    #[test]
    fn unknown_code_is_shown_not_guessed() {
        let e = device_error(-100999, "comanda", &OWNER_STATUS, false);
        assert_eq!(e.to_string(), "Casa a refuzat comanda (cod -100999).");
    }

    #[test]
    fn status_bits_explain_unknown_codes() {
        let mut s = OWNER_STATUS;
        s[2] |= 0x01; // end of paper
        assert!(device_error(-100999, "bonul", &s, true).to_string().contains("hârtie"));
        let mut c = OWNER_STATUS;
        c[0] |= 0x40; // cover open
        assert!(device_error(-100999, "bonul", &c, true).to_string().contains("Capacul"));
        let mut o = OWNER_STATUS;
        o[2] |= 0x08; // fiscal receipt open
        assert!(device_error(-100999, "bonul", &o, true).to_string().contains("deja deschis"));
        // …but an open receipt does not explain a refused item line.
        assert_eq!(device_error(-100999, "bonul", &o, false).to_string(), "Casa a refuzat bonul (cod -100999).");
        let mut f = OWNER_STATUS;
        f[4] |= 0x10; // FM full
        assert!(device_error(-100999, "bonul", &f, false).to_string().contains("Memoria fiscală este plină"));
    }

    #[test]
    fn known_codes_have_dot_free_reasons() {
        for c in [-111024i64, -111016, -112001] {
            assert!(!describe_device_code(c).unwrap().reason.contains('.'));
        }
    }

    #[test]
    fn paper_out_maps_to_paper_error() {
        let e = map_er_code("ER:10");
        assert!(matches!(e, FiscalError::PaperError { .. }));
    }

    #[test]
    fn fiscal_memory_full_routes() {
        let e = map_er_code("30");
        assert!(matches!(e, FiscalError::FiscalMemoryError { .. }));
    }

    #[test]
    fn unknown_code_preserves_raw() {
        let e = map_er_code("ER:99");
        assert!(matches!(e, FiscalError::UnknownFiscalError { detail } if detail.contains("99")));
    }

    #[test]
    fn inline_marker_extracted() {
        let body = "Receipt rejected. ER:24 invalid item line.";
        let e = try_map_response_text(body).expect("should match");
        assert!(matches!(e, FiscalError::InvalidCommand { detail } if detail.contains("ER:24")));
    }

    #[test]
    fn no_marker_returns_none() {
        assert!(try_map_response_text("totally clean response").is_none());
    }
}
