// Datecs DP-25 driver — port of fiscal-bridge/bridge/printers/datecs_dp25.py.
// Speaks FP-55 dialect by default; FP-700 selectable via DatecsConfig.

use std::sync::Mutex;

use crate::fiscal::dto::{
    CancelReceiptRequest, FiscalStatus, ReceiptItem, ReceiptPayment, ReceiptRequest,
    ReceiptResponse, ReceiptStatus, TestResult,
};
use crate::fiscal::error::FiscalError;
use crate::fiscal::mapping::{datecs_errors, payment, status as status_dec, vat};
use crate::fiscal::provider::FiscalPrinterProvider;
use crate::fiscal::transport::datecs_fp::{
    parse_error_code, reply_fields, reply_status_bytes, DatecsFpTransport, DatecsTransportConfig,
    FrameResponse,
};

/// What the operator is told was refused (Romanian, with article).
const ACT_RECEIPT: &str = "bonul";
const ACT_STORNO: &str = "bonul de stornare";
const ACT_X: &str = "raportul X";
const ACT_Z: &str = "raportul Z";
const ACT_DRAWER: &str = "deschiderea sertarului";
const ACT_REPRINT: &str = "duplicatul bonului";
const ACT_PERIODIC: &str = "raportul periodic";
const ACT_STATUS: &str = "citirea stării";

/// Turn a framed reply into an error when the register refused the command
/// (DP-25X ErrorCode < 0). A reply without an ErrorCode (legacy dialect,
/// empty DATA) passes — the legacy `ER:NN` text check stays where it was.
fn check_reply(reply: FrameResponse, action: &str, opening: bool) -> Result<FrameResponse, FiscalError> {
    match parse_error_code(&reply.data) {
        Some(code) if code < 0 => {
            let err = datecs_errors::device_error(
                code,
                action,
                reply_status_bytes(&reply.data),
                opening,
            );
            log::warn!(
                "Datecs DP-25 refused cmd=0x{:02X} ({action}): code {code} → {err}",
                reply.cmd
            );
            Err(err)
        }
        _ => Ok(reply),
    }
}

/// Answer field `idx` (0 = ErrorCode), if present and non-empty.
fn reply_field(reply: &FrameResponse, idx: usize) -> Option<String> {
    reply_fields(&reply.data)
        .into_iter()
        .nth(idx)
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Clone)]
pub struct DatecsConfig {
    pub serial_port: String,
    pub baud: u32,
    pub operator: String,
    pub operator_password: String,
    pub variant_fp700: bool,
    pub cmd_codes: CmdCodes,
}

#[derive(Debug, Clone)]
pub struct CmdCodes {
    pub open_fiscal: u16,
    pub register_item: u16,
    pub subtotal: u16,
    pub payment: u16,
    pub close_fiscal: u16,
    pub open_nonfiscal: u16,
    pub print_text: u16,
    pub close_nonfiscal: u16,
    pub x_report: u16,
    pub z_report: u16,
    pub status: u16,
    /// Sprint 2 / Q3 — Datecs FP-55/DP-25 storno cmd. Per programmer's manual
    /// §3.5 the storno frame opens with `<op>\t<pwd>\t1\tS\t<original_BF>` and
    /// re-registers the items being voided. Wire format is firmware-dependent
    /// — verify on real hardware before going live (see fiscal-port-status §A2).
    pub cancel_fiscal: u16,
    /// Pop the cash drawer pulse. Datecs FP-55/DP-25 maps this to 0x6A.
    /// Configurable so a tenant with a non-standard firmware can override
    /// without recompiling.
    pub open_drawer: u16,
    /// Reprint the LAST fiscal receipt as a duplicate copy. 0x6D on FP-55
    /// per programmer's manual §3.7. Body is empty.
    pub reprint_last: u16,
    /// Print a periodic-memory report between two dates. 0x4F on FP-55.
    /// Payload is `<from>\t<to>` with dates DDMMYY (no separators).
    pub periodic_memory: u16,
    /// Cancel (void) the fiscal receipt that is open right now — 0x3C
    /// "Cancel fiscal receipt" (no parameters) on DP-25X / FP-700X and on
    /// the older FP-55/FP-700 protocol alike. Sent when a step fails after
    /// the receipt was opened, so the register is not left with a half bon.
    pub void_open_receipt: u16,
}

impl Default for CmdCodes {
    fn default() -> Self {
        // Defaults from fiscal-bridge/bridge/printers/datecs_dp25.py:90-102 +
        // backend/src/api/fiscal_bridge.py:_DEFAULT_PROTOCOL_CONFIGS.
        Self {
            open_fiscal: 0x30,
            register_item: 0x31,
            subtotal: 0x33,
            payment: 0x35,
            close_fiscal: 0x38,
            open_nonfiscal: 0x26,
            print_text: 0x2A,
            close_nonfiscal: 0x27,
            x_report: 0x45,
            z_report: 0x45,
            status: 0x4A,
            cancel_fiscal: 0x32,
            open_drawer: 0x6A,
            reprint_last: 0x6D,
            periodic_memory: 0x4F,
            void_open_receipt: 0x3C,
        }
    }
}

pub struct DatecsDp25Provider {
    cfg: DatecsConfig,
    transport: Mutex<DatecsFpTransport>,
}

impl DatecsDp25Provider {
    pub fn new(cfg: DatecsConfig) -> Self {
        // DEBUG (pilot only) — log the exact credentials this provider was
        // instantiated with so we can prove what reaches the wire vs what was
        // typed in the UI. Operator password is logged in clear because the
        // pilot operator is the same person reading the log; remove this log
        // (or hash) once we ship to multiple tenants.
        log::info!(
            "Datecs DP-25 provider built: port={} baud={} variant={} operator='{}' password='{}' (length={})",
            cfg.serial_port,
            cfg.baud,
            if cfg.variant_fp700 { "fp700" } else { "fp55" },
            cfg.operator,
            cfg.operator_password,
            cfg.operator_password.chars().count(),
        );
        let tcfg = if cfg.variant_fp700 {
            DatecsTransportConfig::fp700(&cfg.serial_port, cfg.baud)
        } else {
            DatecsTransportConfig::fp55(&cfg.serial_port, cfg.baud)
        };
        Self {
            cfg,
            transport: Mutex::new(DatecsFpTransport::new(tcfg)),
        }
    }

    /// DEBUG (pilot only) — return the exact bytes that would be sent as the
    /// open_fiscal payload. Lets the operator confirm "the password I see in
    /// the UI is the password the wire sees" without printing a real receipt.
    pub fn debug_open_fiscal_payload(&self) -> Vec<u8> {
        self.build_open_fiscal()
    }

    pub fn debug_credentials(&self) -> (String, String) {
        (self.cfg.operator.clone(), self.cfg.operator_password.clone())
    }

    fn cp1250(text: &str) -> Vec<u8> {
        let (out, _, _) = encoding_rs::WINDOWS_1250.encode(text);
        out.into_owned()
    }

    fn truncate(text: &str, max: usize) -> String {
        let trimmed = text.trim();
        if trimmed.chars().count() <= max {
            return trimmed.to_string();
        }
        let mut out: String = trimmed.chars().take(max - 1).collect();
        out.push('…');
        out
    }

    fn fmt_amount(value: f64) -> String {
        format!("{:.2}", value.abs())
    }

    fn build_open_fiscal(&self) -> Vec<u8> {
        // DUDE capture (2026-04-28) showed the real payload is six TAB-
        // separated fields, not three:
        //   <op>\t<pwd>\t<till>\t\t\t
        // The trailing three empty fields appear to be reserved for invoice
        // number / customer info / EJ. Sending just three fields makes the
        // firmware return error -111016 ("printed" status from our side
        // because a frame echoes back, but no paper comes out).
        let payload = format!(
            "{}\t{}\t1\t\t\t",
            self.cfg.operator, self.cfg.operator_password
        );
        log::info!(
            "Datecs DP-25 open_fiscal payload: '{}' (operator='{}' password='{}' till='1' + 3 reserved empty)",
            payload.replace('\t', "\\t"),
            self.cfg.operator,
            self.cfg.operator_password,
        );
        payload.into_bytes()
    }

    fn build_register_item(item: &ReceiptItem) -> Vec<u8> {
        // DUDE capture (TX 528) shape:
        //   <name>\t<vat_id>\t<price>\t<qty>\t<dept>\t<discount>\t<disc_type>\t<unit>\t
        // - vat_id is a NUMBER (1..5), NOT the legacy "T<A..D>" letter.
        // - dept/discount/disc_type are populated by DUDE with `4`, `0.01`,
        //   `2` for the test sale; the `4` looks like a department-id
        //   placeholder that the firmware accepts as "default", and the
        //   discount fields can be zero. We use safe defaults: dept=0
        //   (firmware default), discount=0.00, disc_type=0 (no discount).
        // - unit defaults to "buc" when the receipt line doesn't specify.
        // - trailing TAB is required (firmware expects 9 fields, last empty).
        let name = Self::truncate(item.name.as_str(), 36);
        let vat_id = vat::rate_to_dp25x_id(item.vat_rate);
        let price = Self::fmt_amount(item.unit_price);
        let qty = Self::fmt_amount(item.quantity);
        let dept = "0";
        let discount = "0.00";
        let disc_type = "0";
        let unit = "buc";
        let line = format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t",
            name, vat_id, price, qty, dept, discount, disc_type, unit
        );
        log::info!(
            "Datecs DP-25 register_item payload: '{}'",
            line.replace('\t', "\\t")
        );
        Self::cp1250(&line)
    }

    fn build_payment(p: &ReceiptPayment) -> Vec<u8> {
        // DUDE capture (TX 608) shape: `<code>\t<amount>\t` (3 fields,
        // trailing one empty/reserved). Empty amount → firmware uses the
        // bon total automatically; we still send it explicitly so the
        // operator sees the exact amount they typed.
        let code = payment::method_to_code(&p.method);
        let amount = Self::fmt_amount(p.amount);
        let line = format!("{}\t{}\t", code, amount);
        log::info!(
            "Datecs DP-25 payment payload: '{}'",
            line.replace('\t', "\\t")
        );
        line.into_bytes()
    }

    /// Storno open payload — Datecs FP-55 §3.5: `<op>\t<pwd>\t1\tS\t<BF>` with
    /// optional `\t<DATE>` suffix on firmwares that require the original
    /// fiscal-memory date. Date is `DD-MM-YY` per the manual; we accept
    /// `YYYY-MM-DD` from the caller and reformat. Reason text is appended on
    /// a print_text line later — keeps the open frame minimal.
    fn build_cancel_open(&self, req: &CancelReceiptRequest) -> Vec<u8> {
        let mut frame = format!(
            "{}\t{}\t1\tS\t{}",
            self.cfg.operator, self.cfg.operator_password, req.original_fiscal_number,
        );
        if let Some(date) = req.original_fiscal_date.as_deref() {
            // ISO `YYYY-MM-DD` → Datecs `DD-MM-YY`. If the input is already in
            // Datecs format we leave it alone (length 8, hyphens at 3+6).
            let datecs = if date.len() == 10 && date.as_bytes().get(4) == Some(&b'-') {
                let yyyy = &date[0..4];
                let mm = &date[5..7];
                let dd = &date[8..10];
                format!("{}-{}-{}", dd, mm, &yyyy[2..])
            } else {
                date.to_string()
            };
            frame.push('\t');
            frame.push_str(&datecs);
        }
        frame.into_bytes()
    }

    /// Storno line — Datecs FP-55 §3.5: storno frames re-use the same
    /// register_item shape; the firmware infers the sign from the `S`
    /// discriminator in the storno open frame, NOT from the item line.
    /// `fmt_amount` strips signs anyway, so this is a pass-through. Kept
    /// as a separate helper for the call-site clarity (and to give us a
    /// single hook if firmware variants ever require a different shape).
    #[allow(dead_code)] // storno lines go through sell_after_open → build_register_item today
    fn build_cancel_item(item: &ReceiptItem) -> Vec<u8> {
        Self::build_register_item(item)
    }

    fn build_print_text(text: &str) -> Vec<u8> {
        Self::cp1250(&Self::truncate(text, 36))
    }
}

impl DatecsDp25Provider {
    /// DP-25X / DP-150X / FP-700X protocol ("X dialect": 4-nibble CMD,
    /// TAB-separated parameters each followed by <SEP>, ErrorCode first in
    /// every answer). Everything except the explicit `fp700` legacy variant.
    fn x_dialect(&self) -> bool {
        !self.cfg.variant_fp700
    }

    /// Command 0x45 parameter. X dialect: `{ReportType}<SEP>` with 'X' / 'Z'
    /// (Programmer's Manual FMP-350X/FMP-55X/FP-700X/DP-25X, cmd 69 (45h);
    /// ErpNet.FP BgDatecsXIslFiscalPrinter.PrintDailyReport sends "X\t" /
    /// "Z\t"). The owner's DP-25X answered "0" with -112001 (syntax).
    /// The legacy `fp700` variant keeps the old "0" (X) / "1" (Z) subcommand.
    fn report_payload(&self, z: bool) -> &'static [u8] {
        match (self.x_dialect(), z) {
            (true, false) => &b"X\t"[..],
            (true, true) => &b"Z\t"[..],
            (false, false) => &b"0"[..],
            (false, true) => &b"1"[..],
        }
    }

    /// Drawer 0x6A. X dialect: `{mSec}<SEP>` — optional, "can be left blank
    /// but separator must exist" (manual §general syntax) → "\t" = default
    /// pulse. Legacy: empty body as before.
    fn drawer_payload(&self) -> &'static [u8] {
        if self.x_dialect() {
            &b"\t"[..]
        } else {
            &b""[..]
        }
    }

    /// Execute one command and fail on a refusal (ErrorCode < 0).
    fn exec(
        &self,
        t: &mut DatecsFpTransport,
        cmd: u16,
        data: &[u8],
        action: &str,
        opening: bool,
    ) -> Result<FrameResponse, FiscalError> {
        let reply = t.execute(cmd, data)?;
        check_reply(reply, action, opening)
    }

    /// Best effort: void the receipt left open by a failed step. Its own
    /// outcome is only logged — the caller returns the ORIGINAL error.
    fn void_open_receipt(&self, t: &mut DatecsFpTransport) {
        match t.execute(self.cfg.cmd_codes.void_open_receipt, b"") {
            Ok(r) => match parse_error_code(&r.data) {
                Some(code) if code < 0 => {
                    log::warn!("Datecs DP-25: cancel of the open receipt refused (code {code})")
                }
                _ => log::info!("Datecs DP-25: open receipt cancelled after a failed step"),
            },
            Err(e) => log::warn!("Datecs DP-25: cancel of the open receipt failed: {e}"),
        }
    }

    /// Payments for a receipt: as sent, or one cash payment for the total.
    fn payments_or_cash(items: &[ReceiptItem], payments: &[ReceiptPayment]) -> Vec<ReceiptPayment> {
        if payments.is_empty() {
            let total: f64 = items.iter().map(|i| i.unit_price * i.quantity.abs()).sum();
            vec![ReceiptPayment {
                method: crate::fiscal::dto::PaymentMethod::Cash,
                amount: total,
            }]
        } else {
            payments.to_vec()
        }
    }

    /// Steps after a successful open: items, (subtotal), payments, close.
    /// Returns the close reply. `reason` is the storno text line, if any.
    fn sell_after_open(
        &self,
        t: &mut DatecsFpTransport,
        items: &[ReceiptItem],
        payments: &[ReceiptPayment],
        reason: Option<&str>,
        action: &str,
    ) -> Result<FrameResponse, FiscalError> {
        let c = &self.cfg.cmd_codes;
        for item in items {
            let data = Self::build_register_item(item);
            self.exec(t, c.register_item, &data, action, false)?;
        }
        if let Some(text) = reason {
            let line = Self::build_print_text(text);
            self.exec(t, c.print_text, &line, action, false)?;
        }
        // Subtotal is optional before payment. The X dialect wants
        // `{Print}<SEP>{Display}<SEP>{DiscountType}<SEP>{DiscountValue}<SEP>`
        // and refused our empty body with -112001; ErpNet.FP never sends it
        // for a plain receipt, so the X dialect skips it. Legacy: as before.
        if !self.x_dialect() {
            self.exec(t, c.subtotal, b"", action, false)?;
        }
        for p in Self::payments_or_cash(items, payments) {
            let data = Self::build_payment(&p);
            self.exec(t, c.payment, &data, action, false)?;
        }
        self.exec(t, c.close_fiscal, b"", action, false)
    }

    /// The fiscal number to report for a closed receipt. X dialect: the
    /// close answer is `{ErrorCode}<SEP>{SlipNumber}<SEP>` (open answers the
    /// same) → field 1 of close, else of open. Legacy: the whole DATA text,
    /// as before.
    fn fiscal_number(&self, open: &FrameResponse, close: &FrameResponse) -> Option<String> {
        if self.x_dialect() {
            reply_field(close, 1).or_else(|| reply_field(open, 1))
        } else {
            let body = String::from_utf8_lossy(&close.data).trim().to_string();
            Some(body)
        }
    }

    /// One whole fiscal document: open → (stop on refusal) → lines →
    /// payments → close; any failure after the open voids the receipt (0x3C)
    /// and returns the original error.
    #[allow(clippy::too_many_arguments)]
    fn run_document(
        &self,
        t: &mut DatecsFpTransport,
        open_cmd: u16,
        open_payload: &[u8],
        items: &[ReceiptItem],
        payments: &[ReceiptPayment],
        reason: Option<&str>,
        action: &str,
    ) -> Result<(FrameResponse, FrameResponse), FiscalError> {
        // A refused open leaves nothing on the register: stop, send no items.
        let open = self.exec(t, open_cmd, open_payload, action, true)?;
        match self.sell_after_open(t, items, payments, reason, action) {
            Ok(close) => {
                // Legacy FP-55 `ER:NN` text marker, kept from the old path.
                let body = String::from_utf8_lossy(&close.data).trim().to_string();
                if let Some(err) = datecs_errors::try_map_response_text(&body) {
                    self.void_open_receipt(t);
                    return Err(err);
                }
                Ok((open, close))
            }
            Err(e) => {
                self.void_open_receipt(t);
                Err(e)
            }
        }
    }

    fn report_response(kind: &str, reply: &FrameResponse) -> ReceiptResponse {
        let dump = String::from_utf8_lossy(&reply.data).trim().to_string();
        ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: None,
            fiscal_date: Some(now_iso()),
            raw_trace: format!("datecs_dp25 {kind} cmd=0x{:02X} bytes={}", reply.cmd, dump),
            error_code: None,
            error_message: None,
        }
    }
}

impl FiscalPrinterProvider for DatecsDp25Provider {
    fn name(&self) -> &'static str {
        "datecs_dp25"
    }

    fn test_connection(&self) -> Result<TestResult, FiscalError> {
        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let r = self.exec(&mut t, self.cfg.cmd_codes.status, b"", ACT_STATUS, false);
        t.close();
        let r = r?;
        Ok(TestResult {
            ok: true,
            detail: format!("status reply: cmd=0x{:02X} data_len={}", r.cmd, r.data.len()),
        })
    }

    fn get_status(&self) -> Result<FiscalStatus, FiscalError> {
        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let r = self.exec(&mut t, self.cfg.cmd_codes.status, b"", ACT_STATUS, false);
        t.close();
        Ok(status_dec::decode_minimal(&r?.status))
    }

    fn print_receipt(&self, req: ReceiptRequest) -> Result<ReceiptResponse, FiscalError> {
        if req.items.is_empty() {
            return Err(FiscalError::InvalidCommand {
                detail: "no items on receipt".into(),
            });
        }

        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let open_payload = self.build_open_fiscal();
        let outcome = self.run_document(
            &mut t,
            self.cfg.cmd_codes.open_fiscal,
            &open_payload,
            &req.items,
            &req.payments,
            None,
            ACT_RECEIPT,
        );
        t.close();
        let (open, close) = outcome?;
        let bf = self.fiscal_number(&open, &close);

        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: bf.clone(),
            fiscal_date: Some(now_iso()),
            raw_trace: format!(
                "datecs_dp25 mut={} order={} attempt={} bf={}",
                req.mutation_id,
                req.order_local_id,
                req.fiscal_attempt_id,
                bf.as_deref().unwrap_or("")
            ),
            error_code: None,
            error_message: None,
        })
    }

    fn cancel_receipt(&self, req: CancelReceiptRequest) -> Result<ReceiptResponse, FiscalError> {
        if req.items.is_empty() {
            return Err(FiscalError::InvalidCommand {
                detail: "no items on storno".into(),
            });
        }

        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let open_payload = self.build_cancel_open(&req);
        // Storno reason as a free-text line so the auditor sees it.
        let reason = if req.reason.trim().is_empty() {
            None
        } else {
            Some(req.reason.as_str())
        };
        let outcome = self.run_document(
            &mut t,
            self.cfg.cmd_codes.cancel_fiscal,
            &open_payload,
            &req.items,
            &req.payments,
            reason,
            ACT_STORNO,
        );
        t.close();
        let (open, close) = outcome?;
        let bf = self.fiscal_number(&open, &close);

        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: bf.clone(),
            fiscal_date: Some(now_iso()),
            raw_trace: format!(
                "datecs_dp25 storno mut={} order={} original={} new_bf={}",
                req.mutation_id,
                req.order_local_id,
                req.original_fiscal_number,
                bf.as_deref().unwrap_or("")
            ),
            error_code: None,
            error_message: None,
        })
    }

    fn print_z_report(&self, _confirm_token: &str) -> Result<ReceiptResponse, FiscalError> {
        // Z-report (closes the fiscal day). Cmd 0x45, payload per dialect —
        // see report_payload().
        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let payload = self.report_payload(true);
        let r = self.exec(&mut t, self.cfg.cmd_codes.z_report, payload, ACT_Z, false);
        t.close();
        Ok(Self::report_response("z_report", &r?))
    }

    fn print_x_report(&self) -> Result<ReceiptResponse, FiscalError> {
        // X-report — readout only, daily counters untouched.
        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let payload = self.report_payload(false);
        let r = self.exec(&mut t, self.cfg.cmd_codes.x_report, payload, ACT_X, false);
        t.close();
        Ok(Self::report_response("x_report", &r?))
    }

    fn open_cash_drawer(&self) -> Result<(), FiscalError> {
        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let payload = self.drawer_payload();
        let r = self.exec(&mut t, self.cfg.cmd_codes.open_drawer, payload, ACT_DRAWER, false);
        t.close();
        r.map(|_| ())
    }

    fn reprint_last_receipt(&self) -> Result<ReceiptResponse, FiscalError> {
        // Cmd 0x6D: print a DUPLICATE of the last fiscal receipt. No params.
        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let r = self.exec(&mut t, self.cfg.cmd_codes.reprint_last, b"", ACT_REPRINT, false);
        t.close();
        Ok(Self::report_response("reprint_last", &r?))
    }

    fn print_periodic_memory(
        &self,
        date_from: &str,
        date_to: &str,
    ) -> Result<ReceiptResponse, FiscalError> {
        // Periodic memory readout between two dates. FP-55 cmd 0x4F with
        // payload `<from>\t<to>` where each date is DDMMYY (no separators).
        // NOTE: the X dialect documents this report as 0x5E
        // `{Type}<SEP>{Start}<SEP>{End}<SEP>` (DD-MM-YY) — not switched here
        // (unverified on the register); a refusal now surfaces as an error.
        if date_from.is_empty() || date_to.is_empty() {
            return Err(FiscalError::InvalidCommand {
                detail: "periodic_memory: date_from and date_to are required".into(),
            });
        }
        let payload = format!("{date_from}\t{date_to}");
        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let r = self.exec(
            &mut t,
            self.cfg.cmd_codes.periodic_memory,
            payload.as_bytes(),
            ACT_PERIODIC,
            false,
        );
        t.close();
        let reply = r?;
        let dump = String::from_utf8_lossy(&reply.data).trim().to_string();
        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: None,
            fiscal_date: Some(now_iso()),
            raw_trace: format!(
                "datecs_dp25 periodic_memory cmd=0x{:02X} {}..{} bytes={}",
                reply.cmd, date_from, date_to, dump
            ),
            error_code: None,
            error_message: None,
        })
    }
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("@unix:{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fiscal::dto::{PaymentMethod, ReceiptItem, ReceiptPayment};

    fn item(name: &str, qty: f64, price: f64, vat: f64) -> ReceiptItem {
        ReceiptItem { name: name.into(), quantity: qty, unit_price: price, vat_rate: vat }
    }

    #[test]
    fn open_fiscal_uses_tab_separator() {
        let p = DatecsDp25Provider::new(DatecsConfig {
            serial_port: "COMx".into(),
            baud: 9600,
            operator: "1".into(),
            operator_password: "0001".into(),
            variant_fp700: false,
            cmd_codes: CmdCodes::default(),
        });
        let bytes = p.build_open_fiscal();
        // DUDE capture 2026-04-28: op, password, till + 3 reserved fields.
        assert_eq!(bytes, b"1\t0001\t1\t\t\t");
    }

    #[test]
    fn register_item_format_matches_python() {
        // DP-25X shape from the DUDE capture (TX 528): numeric VAT id,
        // dept/discount/disc_type/unit + trailing TAB. (The FP-55 "TA"
        // letter format this test used to expect is gone since 5bc28d5.)
        let bytes = DatecsDp25Provider::build_register_item(&item("Cafea", 1.0, 5.0, 0.21));
        let s = String::from_utf8_lossy(&bytes);
        assert_eq!(s, "Cafea\t1\t5.00\t1.00\t0\t0.00\t0\tbuc\t");
        let food = DatecsDp25Provider::build_register_item(&item("Ciorba", 1.0, 5.0, 0.11));
        assert_eq!(String::from_utf8_lossy(&food), "Ciorba\t2\t5.00\t1.00\t0\t0.00\t0\tbuc\t");
    }

    #[test]
    fn register_item_truncates_long_name() {
        let long = "A".repeat(50);
        let bytes = DatecsDp25Provider::build_register_item(&item(&long, 1.0, 1.0, 0.19));
        // The frame is CP1250 ('…' = 0x85), not UTF-8.
        let (s, _, _) = encoding_rs::WINDOWS_1250.decode(&bytes);
        let parts: Vec<&str> = s.split('\t').collect();
        assert!(parts[0].chars().count() <= 36);
        assert!(parts[0].ends_with('…'));
    }

    #[test]
    fn cancel_open_iso_to_datecs_date() {
        let p = DatecsDp25Provider::new(DatecsConfig {
            serial_port: "COMx".into(), baud: 9600,
            operator: "1".into(), operator_password: "0001".into(),
            variant_fp700: false, cmd_codes: CmdCodes::default(),
        });
        let req = CancelReceiptRequest {
            mutation_id: "m".into(), order_local_id: "o".into(),
            fiscal_attempt_id: "a".into(),
            original_fiscal_number: "BF000123".into(),
            original_fiscal_date: Some("2026-04-27".into()),
            items: vec![], payments: vec![],
            currency: "RON".into(), reason: "".into(),
        };
        let bytes = p.build_cancel_open(&req);
        assert_eq!(
            String::from_utf8_lossy(&bytes),
            "1\t0001\t1\tS\tBF000123\t27-04-26",
        );
    }

    #[test]
    fn cancel_open_without_date() {
        let p = DatecsDp25Provider::new(DatecsConfig {
            serial_port: "COMx".into(), baud: 9600,
            operator: "1".into(), operator_password: "0001".into(),
            variant_fp700: false, cmd_codes: CmdCodes::default(),
        });
        let req = CancelReceiptRequest {
            mutation_id: "m".into(), order_local_id: "o".into(),
            fiscal_attempt_id: "a".into(),
            original_fiscal_number: "BF000123".into(),
            original_fiscal_date: None,
            items: vec![], payments: vec![],
            currency: "RON".into(), reason: "".into(),
        };
        let bytes = p.build_cancel_open(&req);
        assert_eq!(String::from_utf8_lossy(&bytes), "1\t0001\t1\tS\tBF000123");
    }

    #[test]
    fn cancel_item_uses_negative_quantity() {
        let bytes = DatecsDp25Provider::build_cancel_item(&item("Cafea", 2.0, 5.0, 0.19));
        let s = String::from_utf8_lossy(&bytes);
        // build_register_item uses fmt_amount which always uses .abs(); the
        // sign is in the storno open frame, not the item line itself. Datecs
        // firmware infers the negative based on the storno discriminator.
        // Confirm parity with the positive register_item.
        assert_eq!(s, "Cafea\t1\t5.00\t2.00\t0\t0.00\t0\tbuc\t");
    }

    #[test]
    fn payment_method_codes() {
        let cash = DatecsDp25Provider::build_payment(&ReceiptPayment {
            method: PaymentMethod::Cash, amount: 12.34,
        });
        // DUDE capture (TX 608): `<code>\t<amount>\t`.
        assert_eq!(String::from_utf8_lossy(&cash), "0\t12.34\t");
        let card = DatecsDp25Provider::build_payment(&ReceiptPayment {
            method: PaymentMethod::Card, amount: 5.0,
        });
        assert_eq!(String::from_utf8_lossy(&card), "2\t5.00\t");
    }

    fn provider(variant_fp700: bool) -> DatecsDp25Provider {
        DatecsDp25Provider::new(DatecsConfig {
            serial_port: "COMx".into(), baud: 115200,
            operator: "1".into(), operator_password: "0001".into(),
            variant_fp700, cmd_codes: CmdCodes::default(),
        })
    }

    const OWNER_STATUS: [u8; 8] = [0x80, 0x84, 0x80, 0x80, 0x86, 0x9a, 0x80, 0x80];

    /// DATA of a DP-25X reply: `<fields>` + 0x04 + the 8 status bytes the
    /// owner's register sent (2026-10-14 log).
    fn reply(cmd: u16, fields: &str) -> FrameResponse {
        let mut data = fields.as_bytes().to_vec();
        data.push(0x04);
        data.extend_from_slice(&OWNER_STATUS);
        FrameResponse { cmd, data, status: [0u8; 6], raw: Vec::new() }
    }

    #[test]
    fn owner_capture_replies_are_refusals() {
        // open_fiscal 0x30 → -111024, then items/payment/close → -111016,
        // subtotal and X report "0" → -112001 (owner's DP-25X, DEBUG log).
        let e = check_reply(reply(0x30, "-111024\t"), ACT_RECEIPT, true).unwrap_err();
        assert!(matches!(e, FiscalError::Device { code: -111024, .. }));
        assert!(e.to_string().starts_with("Casa a refuzat bonul: Este necesar raportul Z"));
        for cmd in [0x31u16, 0x35, 0x38] {
            let e = check_reply(reply(cmd, "-111016\t"), ACT_RECEIPT, false).unwrap_err();
            assert!(matches!(e, FiscalError::Device { code: -111016, .. }));
        }
        let e = check_reply(reply(0x45, "-112001\t"), ACT_X, false).unwrap_err();
        assert!(matches!(e, FiscalError::Device { code: -112001, .. }));
        assert!(e.to_string().starts_with("Casa a refuzat raportul X:"));
    }

    #[test]
    fn ok_replies_pass() {
        assert!(check_reply(reply(0x4A, "0\t"), ACT_STATUS, false).is_ok());
        assert!(check_reply(reply(0x30, "0\t000045\t"), ACT_RECEIPT, true).is_ok());
        // No ErrorCode at all (legacy dialect / empty DATA) is not a refusal.
        let legacy = FrameResponse { cmd: 0x38, data: b"1234,56".to_vec(), status: [0u8; 6], raw: Vec::new() };
        assert!(check_reply(legacy, ACT_RECEIPT, false).is_ok());
    }

    #[test]
    fn fiscal_number_comes_from_close_reply() {
        let p = provider(false);
        let open = reply(0x30, "0\t000045\t");
        let close = reply(0x38, "0\t000046\t");
        assert_eq!(p.fiscal_number(&open, &close).as_deref(), Some("000046"));
        // Close without a slip number → fall back to the open answer.
        let bare = reply(0x38, "0\t");
        assert_eq!(p.fiscal_number(&open, &bare).as_deref(), Some("000045"));
    }

    #[test]
    fn xz_report_payload_depends_on_dialect() {
        let x = provider(false);
        assert_eq!(x.report_payload(false), b"X\t");
        assert_eq!(x.report_payload(true), b"Z\t");
        let legacy = provider(true);
        assert_eq!(legacy.report_payload(false), b"0");
        assert_eq!(legacy.report_payload(true), b"1");
    }

    #[test]
    fn drawer_payload_keeps_separator_on_x_dialect() {
        assert_eq!(provider(false).drawer_payload(), b"\t");
        assert_eq!(provider(true).drawer_payload(), b"");
    }

    #[test]
    fn cancel_open_receipt_is_0x3c() {
        assert_eq!(CmdCodes::default().void_open_receipt, 0x3C);
    }
}
