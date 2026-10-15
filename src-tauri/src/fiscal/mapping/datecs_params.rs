// Parameter formats for the DP-25X ("X dialect") storno and periodic report
// frames. Pure functions — no I/O — shared by the Datecs provider and the
// simulator so both refuse the same bad input with the same message.
//
// Source: Datecs FMP-350X/FMP-55X/FP-700X/WP-500X/WP-50X/DP-25X/DP-150X
// Programmer's Manual v2.02 (2019):
//   cmd 43 (2Bh) Opening of storno documents
//     {OpCode}<SEP>{OpPwd}<SEP>{TillNmb}<SEP>{Storno}<SEP>{DocNum}<SEP>
//     {DateTime}<SEP>{FMNumber}<SEP>{Invoice}<SEP>{ToInvoice}<SEP>{Reason}<SEP>
//     {NSale}<SEP>
//     Storno: 0 operator error, 1 refund, 2 tax base reduction
//     DocNum: original document, 1…9999999
//     DateTime: original document, "DD-MM-YY hh:mm:ss DST"
//     FMNumber: fiscal memory number of the device that issued the original
//   cmd 94 (5Eh) Fiscal memory report by date
//     {Type}<SEP>{Start}<SEP>{End}<SEP>   Type 0 short / 1 detailed,
//     dates DD-MM-YY
//   cmd 90 (5Ah) Diagnostic information — answer ends with {FMNumber}
//     (8 digits).
// Cross-checked with ErpNet.FP BgDatecsXIslFiscalPrinter (OpenReversalReceipt
// sends DateTime as "dd-MM-yy HH:mm:ss"; PrintPeriodReport sends
// "<0|1>\tDD-MM-YY\tDD-MM-YY\t").

use crate::fiscal::error::FiscalError;

fn invalid(detail: impl Into<String>) -> FiscalError {
    FiscalError::InvalidCommand { detail: detail.into() }
}

/// `Storno` parameter of 0x2B. Accepts the backend names, the Romanian
/// words and the raw digit; empty / missing = refund (a guest return —
/// what the restaurant uses storno for).
pub fn storno_reason_code(kind: Option<&str>) -> Result<&'static str, FiscalError> {
    let k = kind.map(|s| s.trim().to_ascii_lowercase()).unwrap_or_default();
    match k.as_str() {
        "" | "1" | "refund" | "retur" | "returnare" => Ok("1"),
        "0" | "operator_error" | "eroare" | "eroare_operator" => Ok("0"),
        "2" | "tax_base_reduction" | "reducere" | "reducere_baza" => Ok("2"),
        other => Err(invalid(format!(
            "Tipul de storno „{other}” nu e cunoscut (refund / operator_error / tax_base_reduction)."
        ))),
    }
}

/// `DocNum` of 0x2B: the register's own number of the original receipt
/// (1…9999999), digits only ("000046" → "46"). A prefixed number such as
/// "BF-000123" is the SERVER's counter, not the register's — refused, so a
/// storno can never point at the wrong receipt.
pub fn storno_doc_number(raw: &str) -> Result<String, FiscalError> {
    let t = raw.trim();
    let not_register = || {
        invalid(format!(
            "„{t}” nu e numărul bonului de pe casa de marcat — storno-ul nu s-a trimis. \
             Fă storno-ul din meniul casei."
        ))
    };
    if t.is_empty() || !t.chars().all(|c| c.is_ascii_digit()) {
        return Err(not_register());
    }
    let n: u64 = t.parse().map_err(|_| not_register())?;
    if n == 0 || n > 9_999_999 {
        return Err(not_register());
    }
    Ok(n.to_string())
}

fn num(s: &str, min: u32, max: u32) -> Option<u32> {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let v: u32 = s.parse().ok()?;
    (min..=max).contains(&v).then_some(v)
}

/// `(DD, MM, YY)` from `YYYY-MM-DD`, `DD-MM-YY`, `DD-MM-YYYY` or `DDMMYY`.
fn parse_date(d: &str) -> Option<(u32, u32, u32)> {
    let d = d.trim();
    let parts: Vec<&str> = d.split(|c| c == '-' || c == '.' || c == '/').collect();
    let (dd, mm, yy) = match parts.as_slice() {
        [y, m, day] if y.len() == 4 => (*day, *m, &y[2..]),
        [day, m, y] if y.len() == 4 => (*day, *m, &y[2..]),
        [day, m, y] if y.len() == 2 => (*day, *m, *y),
        [compact] if compact.len() == 6 && compact.is_ascii() =>(&compact[0..2], &compact[2..4], &compact[4..6]),
        _ => return None,
    };
    Some((num(dd, 1, 31)?, num(mm, 1, 12)?, num(yy, 0, 99)?))
}

/// `(hh, mm, ss)` from `hh:mm` or `hh:mm:ss[.fff]`, ignoring a trailing
/// zone suffix (`Z`, `+03:00`). The backend sends Romanian local time.
fn parse_time(t: &str) -> Option<(u32, u32, u32)> {
    let t = t.trim();
    let t = t.split(|c| c == 'Z' || c == '+').next().unwrap_or(t);
    let parts: Vec<&str> = t.split(':').collect();
    let (h, m, s) = match parts.as_slice() {
        [h, m] => (*h, *m, "0"),
        [h, m, s] => (*h, *m, s.split('.').next().unwrap_or("0")),
        _ => return None,
    };
    Some((num(h, 0, 23)?, num(m, 0, 59)?, num(s, 0, 59)?))
}

/// `DateTime` of 0x2B: "DD-MM-YY hh:mm:ss". Accepts ISO
/// (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS]`, with ' ' or 'T') or the Datecs
/// form. A date without a time (older server) becomes 00:00:00 — the
/// returned flag says so, for the log.
pub fn storno_datetime(raw: Option<&str>) -> Result<(String, bool), FiscalError> {
    let raw = raw.map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| {
        invalid("Lipsește data bonului original — storno-ul nu s-a trimis.")
    })?;
    let bad = || invalid(format!("Data bonului original („{raw}”) nu e validă — storno-ul nu s-a trimis."));
    let (date_part, time_part) = match raw.split_once(|c| c == 'T' || c == ' ') {
        Some((d, t)) => (d, Some(t)),
        None => (raw, None),
    };
    let (dd, mm, yy) = parse_date(date_part).ok_or_else(bad)?;
    let (h, mi, s, date_only) = match time_part.map(str::trim).filter(|t| !t.is_empty()) {
        // Datecs echoes "DST" after the time in summer; drop it.
        Some(t) => {
            let t = t.trim_end_matches("DST").trim();
            let (h, mi, s) = parse_time(t).ok_or_else(bad)?;
            (h, mi, s, false)
        }
        None => (0, 0, 0, true),
    };
    Ok((format!("{dd:02}-{mm:02}-{yy:02} {h:02}:{mi:02}:{s:02}"), date_only))
}

/// `FMNumber` of 0x2B when the server sent one: digits only, as is.
pub fn fm_number(raw: &str) -> Result<String, FiscalError> {
    let t = raw.trim();
    if t.is_empty() || !t.chars().all(|c| c.is_ascii_digit()) {
        return Err(invalid(format!(
            "Numărul memoriei fiscale („{t}”) nu e valid — storno-ul nu s-a trimis."
        )));
    }
    Ok(t.to_string())
}

/// The fiscal memory number from a 0x5A answer. Both answer shapes end with
/// it: `{ErrorCode}\t{Name}\t…\t{SerialNumber}\t{FMNumber}\t` and
/// `{Name},{FwRev} {FwDate} {FwTime},{Checksum},{Sw},{SerialNumber},{FMNumber}`.
/// Takes the last field made only of digits (the serial number has
/// letters), at least 6 long so a bare ErrorCode "0" never matches.
pub fn fm_number_from_device_info(answer_text: &str) -> Option<String> {
    answer_text
        .split(|c| c == '\t' || c == ',')
        .map(str::trim)
        .filter(|f| f.len() >= 6 && f.chars().all(|c| c.is_ascii_digit()))
        .last()
        .map(str::to_string)
}

/// Start / End of 0x5E: "DD-MM-YY". Accepts the `DDMMYY` the server sends
/// today, `DD-MM-YY` and ISO `YYYY-MM-DD`.
pub fn period_date(raw: &str) -> Result<String, FiscalError> {
    let (dd, mm, yy) = parse_date(raw).ok_or_else(|| {
        invalid(format!("Data „{}” a raportului periodic nu e validă.", raw.trim()))
    })?;
    Ok(format!("{dd:02}-{mm:02}-{yy:02}"))
}

/// Comparable key (YYMMDD) of a normalised `DD-MM-YY`.
fn period_key(d: &str) -> u32 {
    let p: Vec<u32> = d.split('-').filter_map(|x| x.parse().ok()).collect();
    match p.as_slice() {
        [dd, mm, yy] => yy * 10_000 + mm * 100 + dd,
        _ => 0,
    }
}

/// Both dates normalised; refuses a range that ends before it starts.
pub fn period_range(from: &str, to: &str) -> Result<(String, String), FiscalError> {
    let f = period_date(from)?;
    let t = period_date(to)?;
    if period_key(&f) > period_key(&t) {
        return Err(invalid(format!(
            "Raportul periodic: data de început ({f}) e după data de sfârșit ({t})."
        )));
    }
    Ok((f, t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reason_codes() {
        assert_eq!(storno_reason_code(None).unwrap(), "1");
        assert_eq!(storno_reason_code(Some("")).unwrap(), "1");
        assert_eq!(storno_reason_code(Some("refund")).unwrap(), "1");
        assert_eq!(storno_reason_code(Some("operator_error")).unwrap(), "0");
        assert_eq!(storno_reason_code(Some("TAX_BASE_REDUCTION")).unwrap(), "2");
        assert_eq!(storno_reason_code(Some("2")).unwrap(), "2");
        assert!(storno_reason_code(Some("altceva")).is_err());
    }

    #[test]
    fn doc_number_is_the_registers_digits_only() {
        assert_eq!(storno_doc_number("000046").unwrap(), "46");
        assert_eq!(storno_doc_number(" 46 ").unwrap(), "46");
        assert_eq!(storno_doc_number("9999999").unwrap(), "9999999");
        // The server's own BF counter is not a register number.
        assert!(storno_doc_number("BF-000123").is_err());
        assert!(storno_doc_number("").is_err());
        assert!(storno_doc_number("BF-").is_err());
        assert!(storno_doc_number("0000").is_err());
        assert!(storno_doc_number("10000000").is_err());
        // Simulator / test-mode numbers are not register numbers.
        assert!(storno_doc_number("TEST-1760000000").is_err());
    }

    #[test]
    fn datetime_formats() {
        assert_eq!(
            storno_datetime(Some("2026-10-14T18:05:09")).unwrap(),
            ("14-10-26 18:05:09".to_string(), false)
        );
        assert_eq!(
            storno_datetime(Some("2026-10-14 18:05")).unwrap(),
            ("14-10-26 18:05:00".to_string(), false)
        );
        assert_eq!(
            storno_datetime(Some("2026-10-14T18:05:09.123456")).unwrap().0,
            "14-10-26 18:05:09"
        );
        assert_eq!(storno_datetime(Some("14-10-26 18:05:09 DST")).unwrap().0, "14-10-26 18:05:09");
        assert_eq!(
            storno_datetime(Some("2026-04-27")).unwrap(),
            ("27-04-26 00:00:00".to_string(), true)
        );
        assert!(storno_datetime(None).is_err());
        assert!(storno_datetime(Some("  ")).is_err());
        assert!(storno_datetime(Some("2026-13-01")).is_err());
        assert!(storno_datetime(Some("2026-10-14T25:00")).is_err());
        assert!(storno_datetime(Some("@unix:1760000000")).is_err());
    }

    #[test]
    fn fm_number_from_both_answer_shapes() {
        // Answer(1): {ErrorCode}\t{Name}\t{FwRev}\t{FwDate}\t{FwTime}\t{Checksum}\t{Sw}\t{Serial}\t{FM}\t
        let tabbed = "0\tDP-25X\t1.00RO\t14Mar24\t1200\tABCD\t00000000\tDT123456\t02123456\t";
        assert_eq!(fm_number_from_device_info(tabbed).as_deref(), Some("02123456"));
        // Answer(2): comma separated, no ErrorCode.
        let commas = "DP-25X,1.00RO 14Mar24 1200,ABCD,00000000,DT123456,02123456";
        assert_eq!(fm_number_from_device_info(commas).as_deref(), Some("02123456"));
        assert_eq!(fm_number_from_device_info("0\t"), None);
        assert_eq!(fm_number_from_device_info("-112001\t"), None);
    }

    #[test]
    fn fm_number_from_server_must_be_digits() {
        assert_eq!(fm_number(" 02123456 ").unwrap(), "02123456");
        assert!(fm_number("DT123456").is_err());
        assert!(fm_number("").is_err());
    }

    #[test]
    fn period_dates() {
        assert_eq!(period_date("011026").unwrap(), "01-10-26");
        assert_eq!(period_date("01-10-26").unwrap(), "01-10-26");
        assert_eq!(period_date("2026-10-01").unwrap(), "01-10-26");
        assert!(period_date("321026").is_err());
        assert!(period_date("2026/10").is_err());
        assert_eq!(
            period_range("010926", "300926").unwrap(),
            ("01-09-26".to_string(), "30-09-26".to_string())
        );
        // Across a year boundary.
        assert!(period_range("151225", "150126").is_ok());
        assert!(period_range("300926", "010926").is_err());
    }
}
