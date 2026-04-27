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

#[cfg(test)]
mod tests {
    use super::*;

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
