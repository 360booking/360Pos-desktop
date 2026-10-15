// „Caută casa de marcat” (2026-10-15) — automatic detection of the register.
//
//   1. Enumerate the COM ports (with what Windows knows: USB VID/PID,
//      product, manufacturer) and sort them into classes:
//        saved      the port already in the runtime config
//        datecs     product/manufacturer says Datecs
//        usb_serial a USB-serial bridge chip (FTDI, Prolific, WCH CH340/341,
//                   Silicon Labs CP210x) or a generic CDC "USB Serial
//                   Device" / Virtual COM port — how a register shows up
//        other      anything else (motherboard COM1, unknown USB device):
//                   probed ONLY after the owner confirms
//                   („Încearcă și celelalte porturi”)
//        excluded   Bluetooth, card/payment terminals, modems: never probed
//   2. Probe the candidates one port at a time with the non-fiscal STATUS
//      command (0x4A) only — nothing that prints or changes fiscal state —
//      with a short timeout, over the usual baud rates × the two Datecs
//      frame dialects. Each attempt holds the process-wide device lock
//      (providers::device_lock), so it never interleaves with a receipt
//      from the agent, the offline till or the watchdog.
//   3. Stop at the first port that answers with a valid STATUS frame.
//
// The Datecs USB VID/PID is not in the public USB ID list and could not be
// confirmed here; Datecs is recognised by the product/manufacturer text the
// driver reports, and the VID/PID of the port found is logged (and returned)
// so it can be added to DATECS_IDS once seen on the real DP-25X.

use std::time::Duration;

use serde::Serialize;

use crate::fiscal::diagnostics::probe::PortDetail;

/// Frame dialects tried, in order (names = runtime_config.protocol_variant).
pub const DIALECTS: &[&str] = &["fp55", "fp700"];
/// Baud rates tried after the preferred one. 115200 first: the DP-25X
/// default verified on the owner's register.
pub const SEARCH_BAUDS: &[u32] = &[115200, 9600, 19200, 38400, 57600];
/// How long one STATUS waits for an answer.
pub const ATTEMPT_TIMEOUT: Duration = Duration::from_millis(700);

/// Known Datecs USB VID/PID pairs. Empty on purpose until confirmed on a
/// real register (see the header).
pub const DATECS_IDS: &[(u16, u16)] = &[];

/// USB-serial bridge chips used in register cables / built into registers.
const BRIDGE_CHIPS: &[(u16, &str)] = &[
    (0x0403, "FTDI"),
    (0x067B, "Prolific"),
    (0x1A86, "WCH CH340/CH341"),
    (0x10C4, "Silicon Labs CP210x"),
];

/// Card / payment terminal vendors (Ingenico ×2, VeriFone, Castles,
/// Newland): never sent a byte by the search.
const PAYMENT_VIDS: &[u16] = &[0x0B00, 0x0F14, 0x11CA, 0x0CA6, 0x1EAB];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PortClass {
    Saved,
    Datecs,
    UsbSerial,
    Other,
    Excluded,
}

impl PortClass {
    /// Probed without asking.
    pub fn is_likely(self) -> bool {
        matches!(self, PortClass::Saved | PortClass::Datecs | PortClass::UsbSerial)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub port: PortDetail,
    pub class: PortClass,
    /// Short Romanian description: why it is in this class.
    pub reason: String,
}

fn text_of(p: &PortDetail) -> String {
    format!(
        "{} {}",
        p.product.as_deref().unwrap_or(""),
        p.manufacturer.as_deref().unwrap_or("")
    )
    .to_lowercase()
}

fn has_any(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| text.contains(w))
}

/// Class of one port, ignoring which port is saved.
pub fn classify(p: &PortDetail) -> (PortClass, String) {
    let t = text_of(p);
    if p.kind == "bluetooth" || t.contains("bluetooth") {
        return (PortClass::Excluded, "Bluetooth".into());
    }
    if p.vid.map(|v| PAYMENT_VIDS.contains(&v)).unwrap_or(false)
        || has_any(&t, &["ingenico", "verifone", "pax ", "pax-", "castles", "newland", "pinpad", "pin pad", "payment", "terminal de plat"])
    {
        return (PortClass::Excluded, "terminal de plată cu cardul".into());
    }
    if has_any(&t, &["modem", "gps", "gnss", "active management", "amt sol", "irda"]) {
        return (PortClass::Excluded, "modem sau alt dispozitiv".into());
    }
    if t.contains("datecs")
        || matches!((p.vid, p.pid), (Some(v), Some(d)) if DATECS_IDS.contains(&(v, d)))
    {
        return (PortClass::Datecs, "Datecs".into());
    }
    if let Some(v) = p.vid {
        if let Some((_, chip)) = BRIDGE_CHIPS.iter().find(|(id, _)| *id == v) {
            return (PortClass::UsbSerial, format!("adaptor USB-serial {chip}"));
        }
        if v == 0x0483 && p.pid == Some(0x5740) {
            return (PortClass::UsbSerial, "port USB-serial (Virtual COM)".into());
        }
    }
    if has_any(&t, &["usb serial device", "usb-serial", "usb serial port", "virtual com", "virtual serial", "cdc"]) {
        return (PortClass::UsbSerial, "port USB-serial".into());
    }
    if p.kind == "usb" {
        return (PortClass::Other, "dispozitiv USB necunoscut".into());
    }
    (PortClass::Other, "port COM al calculatorului".into())
}

/// Candidates in search order: saved port, Datecs, USB-serial, other,
/// excluded; enumeration order inside a class. The saved port is never
/// promoted out of `excluded`.
pub fn order_candidates(ports: Vec<PortDetail>, saved: Option<&str>) -> Vec<Candidate> {
    let mut out: Vec<(usize, Candidate)> = ports
        .into_iter()
        .enumerate()
        .map(|(i, port)| {
            let (mut class, mut reason) = classify(&port);
            let is_saved = saved.map(|s| s.eq_ignore_ascii_case(&port.name)).unwrap_or(false);
            if is_saved && class != PortClass::Excluded {
                class = PortClass::Saved;
                reason = format!("portul salvat ({reason})");
            }
            (i, Candidate { port, class, reason })
        })
        .collect();
    out.sort_by(|a, b| a.1.class.cmp(&b.1.class).then(a.0.cmp(&b.0)));
    out.into_iter().map(|(_, c)| c).collect()
}

/// Baud rates for one port: the preferred one first, no repeats.
pub fn bauds_for(preferred: Option<u32>) -> Vec<u32> {
    let mut v: Vec<u32> = Vec::new();
    if let Some(b) = preferred {
        v.push(b);
    }
    for b in SEARCH_BAUDS {
        if !v.contains(b) {
            v.push(*b);
        }
    }
    v
}

/// What one STATUS attempt got.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// A valid STATUS reply frame; the reply DATA (status bytes inside).
    Valid(Vec<u8>),
    /// The device sent NAK: something speaks the protocol but refused.
    Nak,
    /// Nothing valid came back (timeout, garbage, wrong command echo).
    NoAnswer(String),
    /// The port could not be opened (taken by another program, gone).
    CannotOpen(String),
}

/// One STATUS attempt. The app's implementation talks to the COM port
/// under the device lock; tests script it.
pub trait Prober {
    fn try_status(&mut self, port: &str, baud: u32, dialect: &str) -> Answer;
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub port: String,
    pub label: String,
    pub baud: u32,
    pub dialect: String,
    /// 1-based index of the port among those probed in this run.
    pub port_index: usize,
    pub port_total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TryOutcome {
    Found,
    /// Answered NAK on every combination (register not activated, a
    /// receipt/menu open on it, …).
    Refuses,
    Silent,
    /// Could not open: "access denied" = another program holds it.
    Busy,
    Missing,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
pub struct PortTry {
    pub port: String,
    pub label: String,
    pub class: PortClass,
    pub outcome: TryOutcome,
    pub attempts: u32,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkippedPort {
    pub port: String,
    pub label: String,
    pub class: PortClass,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectFound {
    pub port: String,
    pub label: String,
    pub baud: u32,
    /// runtime_config.protocol_variant: "fp55" (DP-25X frames) | "fp700".
    pub dialect: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub product: Option<String>,
    pub manufacturer: Option<String>,
    /// What the register reports right now (paper, cover, …), Romanian.
    pub notice: Option<String>,
    /// The STATUS reply DATA (hex) for support.
    pub reply_hex: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectReport {
    pub ports_seen: usize,
    pub found: Option<DetectFound>,
    /// Port/baud/dialect written to the runtime config.
    pub saved: bool,
    pub save_error: Option<String>,
    pub tried: Vec<PortTry>,
    /// Ports that do not look like a register and were not probed: offer
    /// „Încearcă și celelalte porturi”.
    pub not_tried: Vec<SkippedPort>,
    /// Never probed (Bluetooth, card terminals, modems).
    pub excluded: Vec<SkippedPort>,
    pub cancelled: bool,
    pub included_others: bool,
}

/// "COM4 — USB Serial Device" (Windows repeats "(COM4)" in the product).
pub fn port_label(p: &PortDetail) -> String {
    let raw = p
        .product
        .clone()
        .or_else(|| p.manufacturer.clone())
        .unwrap_or_default();
    let raw = raw.trim();
    let suffix = format!("({})", p.name);
    let raw = raw
        .strip_suffix(&suffix)
        .map(|s| s.trim())
        .unwrap_or(raw);
    if raw.is_empty() {
        p.name.clone()
    } else {
        format!("{} — {}", p.name, raw)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The search itself, I/O-free: `prober` does the attempts, `progress` is
/// told before each one, `cancelled` is polled between attempts.
pub fn run_search(
    candidates: &[Candidate],
    include_others: bool,
    preferred_baud: Option<u32>,
    prober: &mut dyn Prober,
    progress: &mut dyn FnMut(&Progress),
    cancelled: &dyn Fn() -> bool,
) -> DetectReport {
    let mut report = DetectReport {
        ports_seen: candidates.len(),
        found: None,
        saved: false,
        save_error: None,
        tried: Vec::new(),
        not_tried: Vec::new(),
        excluded: Vec::new(),
        cancelled: false,
        included_others: include_others,
    };
    let skipped = |c: &Candidate| SkippedPort {
        port: c.port.name.clone(),
        label: port_label(&c.port),
        class: c.class,
        reason: c.reason.clone(),
    };
    let mut to_probe: Vec<&Candidate> = Vec::new();
    for c in candidates {
        match c.class {
            PortClass::Excluded => report.excluded.push(skipped(c)),
            PortClass::Other if !include_others => report.not_tried.push(skipped(c)),
            _ => to_probe.push(c),
        }
    }
    let bauds = bauds_for(preferred_baud);
    let total = to_probe.len();
    'ports: for (i, c) in to_probe.iter().enumerate() {
        let label = port_label(&c.port);
        let mut attempts = 0u32;
        let mut naks = 0u32;
        let mut last_err: Option<String> = None;
        let mut outcome = TryOutcome::Silent;
        'combos: for &baud in &bauds {
            for dialect in DIALECTS {
                if cancelled() {
                    report.cancelled = true;
                    report.tried.push(PortTry {
                        port: c.port.name.clone(),
                        label,
                        class: c.class,
                        outcome: TryOutcome::Cancelled,
                        attempts,
                        detail: None,
                    });
                    break 'ports;
                }
                progress(&Progress {
                    port: c.port.name.clone(),
                    label: label.clone(),
                    baud,
                    dialect: (*dialect).to_string(),
                    port_index: i + 1,
                    port_total: total,
                });
                attempts += 1;
                match prober.try_status(&c.port.name, baud, dialect) {
                    Answer::Valid(data) => {
                        let notice = if *dialect == "fp55" {
                            let st = crate::fiscal::mapping::status::decode_x(
                                crate::fiscal::transport::datecs_fp::reply_status_bytes(&data),
                            );
                            st.error_message
                        } else {
                            None
                        };
                        report.tried.push(PortTry {
                            port: c.port.name.clone(),
                            label: label.clone(),
                            class: c.class,
                            outcome: TryOutcome::Found,
                            attempts,
                            detail: None,
                        });
                        report.found = Some(DetectFound {
                            port: c.port.name.clone(),
                            label,
                            baud,
                            dialect: (*dialect).to_string(),
                            vid: c.port.vid,
                            pid: c.port.pid,
                            product: c.port.product.clone(),
                            manufacturer: c.port.manufacturer.clone(),
                            notice,
                            reply_hex: hex(&data),
                        });
                        break 'ports;
                    }
                    Answer::Nak => {
                        naks += 1;
                        last_err = Some("NAK".into());
                    }
                    Answer::NoAnswer(e) => last_err = Some(e),
                    Answer::CannotOpen(e) => {
                        // Same answer at every speed: do not insist.
                        let t = e.to_lowercase();
                        outcome = if t.contains("denied") || t.contains("refuzat") || t.contains("busy") || t.contains("in use") || t.contains("os error 5") {
                            TryOutcome::Busy
                        } else {
                            TryOutcome::Missing
                        };
                        last_err = Some(e);
                        break 'combos;
                    }
                }
            }
        }
        if outcome == TryOutcome::Silent && naks > 0 && naks == attempts {
            outcome = TryOutcome::Refuses;
        }
        report.tried.push(PortTry {
            port: c.port.name.clone(),
            label,
            class: c.class,
            outcome,
            attempts,
            detail: last_err,
        });
    }
    report
}

// ---------------------------------------------------------------- the app

/// Talks to the COM port: one STATUS frame per attempt, under the device
/// lock, short timeout. Nothing else is ever sent.
pub struct SerialProber;

impl Prober for SerialProber {
    fn try_status(&mut self, port: &str, baud: u32, dialect: &str) -> Answer {
        use crate::fiscal::error::FiscalError;
        use crate::fiscal::transport::datecs_fp::{
            BccAlgo, BccCoverage, DatecsFpTransport, DatecsTransportConfig,
        };
        const CMD_STATUS: u16 = 0x4A;
        let base = DatecsTransportConfig {
            timeout: ATTEMPT_TIMEOUT,
            min_wait: Duration::ZERO,
            ..DatecsTransportConfig::fp55(port, baud)
        };
        // Same two frame variants as diagnostics::probe.
        let cfg = if dialect == "fp700" {
            DatecsTransportConfig {
                encoding_offset: 0x30,
                bcc_algo: BccAlgo::Xor,
                bcc_coverage: BccCoverage::Body,
                cmd_width: 1,
                ..base
            }
        } else {
            base
        };
        let _device = crate::fiscal::providers::device_lock();
        let mut t = DatecsFpTransport::new(cfg);
        if let Err(e) = t.open() {
            return Answer::CannotOpen(e.to_string());
        }
        let res = t.execute(CMD_STATUS, b"");
        t.close();
        match res {
            Ok(r) if r.cmd == CMD_STATUS => Answer::Valid(r.data),
            Ok(r) => Answer::NoAnswer(format!("răspuns la altă comandă (0x{:02X})", r.cmd)),
            Err(FiscalError::InvalidCommand { detail }) if detail == "device NAK" => Answer::Nak,
            Err(e) => Answer::NoAnswer(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn usb(name: &str, vid: u16, pid: u16, product: &str) -> PortDetail {
        PortDetail {
            name: name.into(),
            kind: "usb".into(),
            product: Some(product.into()),
            manufacturer: None,
            vid: Some(vid),
            pid: Some(pid),
        }
    }

    fn plain(name: &str, kind: &str) -> PortDetail {
        PortDetail {
            name: name.into(),
            kind: kind.into(),
            product: None,
            manufacturer: None,
            vid: None,
            pid: None,
        }
    }

    fn names(c: &[Candidate]) -> Vec<&str> {
        c.iter().map(|x| x.port.name.as_str()).collect()
    }

    #[test]
    fn classifies_known_devices() {
        let c = |p: PortDetail| classify(&p).0;
        assert_eq!(c(usb("COM3", 0x1234, 1, "Datecs Virtual Serial Port (COM3)")), PortClass::Datecs);
        assert_eq!(c(usb("COM4", 0x0403, 0x6001, "USB Serial Port")), PortClass::UsbSerial);
        assert_eq!(c(usb("COM5", 0x067B, 0x2303, "Prolific USB-to-Serial Comm Port")), PortClass::UsbSerial);
        assert_eq!(c(usb("COM6", 0x1A86, 0x7523, "USB-SERIAL CH340")), PortClass::UsbSerial);
        assert_eq!(c(usb("COM7", 0x10C4, 0xEA60, "Silicon Labs CP210x USB to UART Bridge")), PortClass::UsbSerial);
        assert_eq!(c(usb("COM8", 0x2222, 0x3333, "USB Serial Device (COM8)")), PortClass::UsbSerial);
        assert_eq!(c(usb("COM9", 0x0483, 0x5740, "")), PortClass::UsbSerial);
        assert_eq!(c(usb("COM10", 0x2222, 0x3333, "Gadget")), PortClass::Other);
        assert_eq!(c(plain("COM1", "pci")), PortClass::Other);
        assert_eq!(c(plain("COM2", "unknown")), PortClass::Other);
    }

    #[test]
    fn excludes_bluetooth_card_terminals_and_modems() {
        let c = |p: PortDetail| classify(&p).0;
        assert_eq!(c(plain("COM11", "bluetooth")), PortClass::Excluded);
        assert_eq!(c(usb("COM12", 0x2222, 1, "Standard Serial over Bluetooth link")), PortClass::Excluded);
        assert_eq!(c(usb("COM13", 0x0B00, 0x0084, "USB Serial Device")), PortClass::Excluded, "Ingenico VID wins over CDC text");
        assert_eq!(c(usb("COM14", 0x11CA, 0x0219, "Verifone USB Serial")), PortClass::Excluded);
        assert_eq!(c(usb("COM15", 0x2222, 1, "PAX Technology USB Serial")), PortClass::Excluded);
        assert_eq!(c(usb("COM16", 0x2222, 1, "Intel(R) Active Management Technology - SOL")), PortClass::Excluded);
        assert_eq!(c(usb("COM17", 0x2222, 1, "Sierra Wireless Modem")), PortClass::Excluded);
    }

    #[test]
    fn orders_saved_datecs_usbserial_other_excluded() {
        let ports = vec![
            plain("COM1", "pci"),
            plain("COM2", "bluetooth"),
            usb("COM5", 0x0403, 0x6001, "USB Serial Port"),
            usb("COM6", 0x2222, 1, "Gadget"),
            usb("COM7", 0x1234, 1, "Datecs DP-25X"),
            usb("COM8", 0x1A86, 0x7523, "USB-SERIAL CH340"),
        ];
        let o = order_candidates(ports.clone(), None);
        assert_eq!(names(&o), vec!["COM7", "COM5", "COM8", "COM1", "COM6", "COM2"]);
        // The saved port goes first, whatever it looks like…
        let o = order_candidates(ports.clone(), Some("com1"));
        assert_eq!(names(&o)[0], "COM1");
        assert_eq!(o[0].class, PortClass::Saved);
        assert!(o[0].class.is_likely());
        // …but a saved Bluetooth port stays excluded.
        let o = order_candidates(ports, Some("COM2"));
        assert_eq!(o.last().unwrap().port.name, "COM2");
        assert_eq!(o.last().unwrap().class, PortClass::Excluded);
    }

    #[test]
    fn bauds_preferred_first_without_repeats() {
        assert_eq!(bauds_for(None), vec![115200, 9600, 19200, 38400, 57600]);
        assert_eq!(bauds_for(Some(9600)), vec![9600, 115200, 19200, 38400, 57600]);
        assert_eq!(bauds_for(Some(4800))[0], 4800);
    }

    #[test]
    fn port_label_drops_repeated_name() {
        assert_eq!(port_label(&usb("COM4", 1, 1, "USB Serial Device (COM4)")), "COM4 — USB Serial Device");
        assert_eq!(port_label(&plain("COM1", "pci")), "COM1");
    }

    /// Scripted ports: (port, baud, dialect) → answer; anything else = silent.
    struct Fake {
        answers: HashMap<(String, u32, String), Answer>,
        cannot_open: HashMap<String, String>,
        calls: Vec<(String, u32, String)>,
    }

    impl Fake {
        fn new() -> Self {
            Self { answers: HashMap::new(), cannot_open: HashMap::new(), calls: Vec::new() }
        }
    }

    impl Prober for Fake {
        fn try_status(&mut self, port: &str, baud: u32, dialect: &str) -> Answer {
            self.calls.push((port.into(), baud, dialect.into()));
            if let Some(e) = self.cannot_open.get(port) {
                return Answer::CannotOpen(e.clone());
            }
            self.answers
                .get(&(port.to_string(), baud, dialect.to_string()))
                .cloned()
                .unwrap_or_else(|| Answer::NoAnswer("frame timeout".into()))
        }
    }

    fn owner_status_reply() -> Vec<u8> {
        let mut d = b"0\t".to_vec();
        d.push(0x04);
        // paper near end (S2 bit 1) on the owner's bytes
        d.extend_from_slice(&[0x80, 0x84, 0x82, 0x80, 0x86, 0x9a, 0x80, 0x80]);
        d
    }

    fn sample_ports() -> Vec<PortDetail> {
        vec![
            plain("COM1", "pci"),
            plain("COM2", "bluetooth"),
            usb("COM5", 0x0403, 0x6001, "USB Serial Port"),
            usb("COM8", 0x2222, 0x3333, "USB Serial Device (COM8)"),
            usb("COM9", 0x0B00, 0x0084, "Ingenico Telium"),
        ]
    }

    #[test]
    fn stops_at_first_valid_answer_and_never_touches_excluded_or_other() {
        let cands = order_candidates(sample_ports(), None);
        let mut fake = Fake::new();
        fake.answers.insert(("COM8".into(), 9600, "fp55".into()), Answer::Valid(owner_status_reply()));
        let mut seen: Vec<String> = Vec::new();
        let r = run_search(&cands, false, None, &mut fake, &mut |p| seen.push(format!("{}@{}", p.port, p.baud)), &|| false);
        let f = r.found.expect("found");
        assert_eq!((f.port.as_str(), f.baud, f.dialect.as_str()), ("COM8", 9600, "fp55"));
        assert_eq!(f.label, "COM8 — USB Serial Device");
        assert!(f.notice.unwrap().contains("pe terminate"));
        // COM5 fully swept (5 bauds × 2 dialects), then COM8 115200 ×2, 9600 fp55.
        assert_eq!(fake.calls.len(), 10 + 3);
        assert!(fake.calls.iter().all(|(p, _, _)| p == "COM5" || p == "COM8"));
        assert_eq!(seen.first().map(String::as_str), Some("COM5@115200"));
        assert_eq!(r.tried.len(), 2);
        assert_eq!(r.tried[0].outcome, TryOutcome::Silent);
        assert_eq!(r.tried[1].outcome, TryOutcome::Found);
        assert_eq!(r.not_tried.iter().map(|s| s.port.as_str()).collect::<Vec<_>>(), vec!["COM1"]);
        let mut ex: Vec<&str> = r.excluded.iter().map(|s| s.port.as_str()).collect();
        ex.sort();
        assert_eq!(ex, vec!["COM2", "COM9"]);
    }

    #[test]
    fn other_ports_only_after_confirmation() {
        let cands = order_candidates(sample_ports(), None);
        let mut fake = Fake::new();
        fake.answers.insert(("COM1".into(), 115200, "fp55".into()), Answer::Valid(b"0\t".to_vec()));
        let r = run_search(&cands, false, None, &mut fake, &mut |_| {}, &|| false);
        assert!(r.found.is_none());
        assert_eq!(r.not_tried.len(), 1);
        assert!(!fake.calls.iter().any(|(p, _, _)| p == "COM1"));

        let mut fake2 = Fake::new();
        fake2.answers.insert(("COM1".into(), 115200, "fp55".into()), Answer::Valid(b"0\t".to_vec()));
        let r = run_search(&cands, true, None, &mut fake2, &mut |_| {}, &|| false);
        assert_eq!(r.found.unwrap().port, "COM1");
        assert!(r.not_tried.is_empty());
        assert!(!fake2.calls.iter().any(|(p, _, _)| p == "COM2" || p == "COM9"), "excluded never probed");
    }

    #[test]
    fn busy_port_is_left_after_one_attempt_and_nak_everywhere_is_refuses() {
        let ports = vec![
            usb("COM5", 0x0403, 0x6001, "USB Serial Port"),
            usb("COM6", 0x1A86, 0x7523, "USB-SERIAL CH340"),
        ];
        let cands = order_candidates(ports, None);
        let mut fake = Fake::new();
        fake.cannot_open.insert("COM5".into(), "open COM5: Access is denied.".into());
        for b in SEARCH_BAUDS {
            for d in DIALECTS {
                fake.answers.insert(("COM6".into(), *b, (*d).into()), Answer::Nak);
            }
        }
        let r = run_search(&cands, false, None, &mut fake, &mut |_| {}, &|| false);
        assert!(r.found.is_none());
        assert_eq!(r.tried[0].outcome, TryOutcome::Busy);
        assert_eq!(r.tried[0].attempts, 1);
        assert_eq!(r.tried[1].outcome, TryOutcome::Refuses);
        let mut f2 = Fake::new();
        f2.cannot_open.insert("COM5".into(), "open COM5: The system cannot find the file specified.".into());
        let r = run_search(&cands[..1], false, None, &mut f2, &mut |_| {}, &|| false);
        assert_eq!(r.tried[0].outcome, TryOutcome::Missing);
    }

    #[test]
    fn preferred_baud_is_tried_first_and_cancel_stops() {
        let cands = order_candidates(vec![usb("COM5", 0x0403, 0x6001, "USB Serial Port")], Some("COM5"));
        let mut fake = Fake::new();
        let r = run_search(&cands, false, Some(19200), &mut fake, &mut |_| {}, &|| false);
        assert_eq!(fake.calls[0], ("COM5".into(), 19200, "fp55".into()));
        assert_eq!(r.tried[0].class, PortClass::Saved);

        let mut fake = Fake::new();
        let n = std::cell::Cell::new(0);
        let r = run_search(&cands, false, None, &mut fake, &mut |_| n.set(n.get() + 1), &|| n.get() >= 2);
        assert!(r.cancelled);
        assert_eq!(fake.calls.len(), 2);
        assert_eq!(r.tried[0].outcome, TryOutcome::Cancelled);
    }

    #[test]
    fn no_ports_at_all() {
        let r = run_search(&[], true, None, &mut Fake::new(), &mut |_| {}, &|| false);
        assert_eq!(r.ports_seen, 0);
        assert!(r.found.is_none() && r.tried.is_empty());
    }
}
