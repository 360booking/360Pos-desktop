// Datecs DP-25 driver — port of fiscal-bridge/bridge/printers/datecs_dp25.py.
// Default: the DP-25X / FP-700X "X dialect" (Datecs FMP-350X/FMP-55X/FP-700X/
// DP-25X/DP-150X Programmer's Manual v2.02): storno 0x2B, report by date
// 0x5E, free fiscal text 0x36, 8 status bytes inside every answer. The old
// FP-55/FP-700 frames stay behind `variant_fp700` (legacy, unverified).

use std::sync::Mutex;

use crate::fiscal::dto::{
    CancelReceiptRequest, FiscalStatus, ReceiptItem, ReceiptPayment, ReceiptRequest,
    ReceiptResponse, ReceiptStatus, TestResult,
};
use crate::fiscal::error::FiscalError;
use crate::fiscal::mapping::{datecs_errors, datecs_params, payment, status as status_dec, vat};
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

/// DP-25X ErrorCode for a frame whose parameters the firmware cannot parse.
const SYNTAX_ERROR: i64 = -112001;

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
    /// LEGACY `fp700` variant only: the old storno frame
    /// `<op>\t<pwd>\t1\tS\t<BF>[\t<DD-MM-YY>]` on 0x32. On the DP-25X 0x32
    /// is "Return the active VAT rates" — never a storno there; the X
    /// dialect uses `storno_open` (0x2B).
    pub cancel_fiscal: u16,
    /// DP-25X / FP-700X: "Opening of storno documents" (cmd 43, 2Bh).
    pub storno_open: u16,
    /// DP-25X / FP-700X: "Printing of a free fiscal text" (cmd 54, 36h) —
    /// the only text command allowed inside a fiscal / storno receipt
    /// (0x2A is for non-fiscal receipts).
    pub fiscal_text: u16,
    /// DP-25X / FP-700X: "Diagnostic information" (cmd 90, 5Ah) — its
    /// answer ends with the fiscal memory number a storno must name.
    pub device_info: u16,
    /// Pop the cash drawer pulse. Datecs FP-55/DP-25 maps this to 0x6A.
    /// Configurable so a tenant with a non-standard firmware can override
    /// without recompiling.
    pub open_drawer: u16,
    /// Reprint the LAST fiscal receipt as a duplicate copy. 0x6D on FP-55
    /// per programmer's manual §3.7. Body is empty.
    pub reprint_last: u16,
    /// LEGACY `fp700` variant only: periodic report 0x4F with
    /// `<from>\t<to>` (DDMMYY). On the DP-25X 0x4F is not a report.
    pub periodic_memory: u16,
    /// DP-25X / FP-700X: "Fiscal memory report by date" (cmd 94, 5Eh),
    /// `{Type}<SEP>{Start}<SEP>{End}<SEP>` with DD-MM-YY dates.
    pub periodic_by_date: u16,
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
            storno_open: 0x2B,
            fiscal_text: 0x36,
            device_info: 0x5A,
            open_drawer: 0x6A,
            reprint_last: 0x6D,
            periodic_memory: 0x4F,
            periodic_by_date: 0x5E,
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

    /// LEGACY `fp700` variant storno open (0x32): `<op>\t<pwd>\t1\tS\t<BF>`
    /// with an optional `\t<DD-MM-YY>` — the old FP-55 shape, unverified
    /// and unused on the DP-25X (see `build_storno_open`).
    fn build_cancel_open_legacy(&self, req: &CancelReceiptRequest) -> Vec<u8> {
        let mut frame = format!(
            "{}\t{}\t1\tS\t{}",
            self.cfg.operator, self.cfg.operator_password, req.original_fiscal_number,
        );
        if let Some(date) = req.original_fiscal_date.as_deref() {
            // ISO `YYYY-MM-DD[...]` → Datecs `DD-MM-YY`; anything else as is.
            let datecs = if date.is_ascii() && date.len() >= 10 && date.as_bytes().get(4) == Some(&b'-') {
                format!("{}-{}-{}", &date[8..10], &date[5..7], &date[2..4])
            } else {
                date.to_string()
            };
            frame.push('\t');
            frame.push_str(&datecs);
        }
        frame.into_bytes()
    }

    /// DP-25X storno open (cmd 43, 2Bh):
    ///   {OpCode}<SEP>{OpPwd}<SEP>{TillNmb}<SEP>{Storno}<SEP>{DocNum}<SEP>
    ///   {DateTime}<SEP>{FMNumber}<SEP>{Invoice}<SEP>{ToInvoice}<SEP>
    ///   {Reason}<SEP>[{NSale}<SEP>]
    /// Invoice / ToInvoice / Reason are only for invoice storno → empty.
    /// NSale (the Bulgarian unique sale number) does not exist in Romania;
    /// `with_nsale` adds it as an empty field, for a firmware that insists
    /// on the full 11-field form (tried only after a syntax refusal).
    fn build_storno_open(
        &self,
        reason_code: &str,
        doc_number: &str,
        datetime: &str,
        fm_number: &str,
        with_nsale: bool,
    ) -> Vec<u8> {
        let mut fields: Vec<&str> = vec![
            self.cfg.operator.as_str(),
            self.cfg.operator_password.as_str(),
            "1",
            reason_code,
            doc_number,
            datetime,
            fm_number,
            "",
            "",
            "",
        ];
        if with_nsale {
            fields.push("");
        }
        let mut out = String::new();
        for f in fields {
            out.push_str(f);
            out.push('\t');
        }
        out.into_bytes()
    }

    /// The register's fiscal memory number (cmd 90, 5Ah, param "1" — the
    /// form ErpNet.FP reads it with). The answer ends with {FMNumber}.
    fn read_fm_number(&self, t: &mut DatecsFpTransport) -> Result<String, FiscalError> {
        let reply = self.exec(t, self.cfg.cmd_codes.device_info, b"1", ACT_STORNO, false)?;
        let end = reply
            .data
            .iter()
            .position(|b| *b == crate::fiscal::transport::datecs_fp::STATUS_SEP)
            .unwrap_or(reply.data.len());
        let text = String::from_utf8_lossy(&reply.data[..end]).to_string();
        datecs_params::fm_number_from_device_info(&text).ok_or_else(|| {
            log::warn!("Datecs DP-25: no FM number in the 0x5A answer: {text:?}");
            FiscalError::InvalidCommand {
                detail: "Nu am putut citi numărul memoriei fiscale de pe casă — storno-ul nu s-a trimis. \
                         Trimite-ne diagnosticul din „Avansat (service)”."
                    .into(),
            }
        })
    }

    /// Payments of a storno: as sent, but never more than the storno total
    /// (a tip or a rounding on the original would make the register print
    /// "REST" on a refund). Trimmed from the last payment backwards.
    fn storno_payments(items: &[ReceiptItem], payments: &[ReceiptPayment]) -> Vec<ReceiptPayment> {
        let total_cents: i64 = items
            .iter()
            .map(|i| (i.unit_price.abs() * i.quantity.abs() * 100.0).round() as i64)
            .sum();
        let mut out = Self::payments_or_cash(items, payments);
        let mut paid: i64 = out.iter().map(|p| (p.amount.abs() * 100.0).round() as i64).sum();
        while paid > total_cents {
            let Some(last) = out.last_mut() else { break };
            let cents = (last.amount.abs() * 100.0).round() as i64;
            let excess = paid - total_cents;
            if cents > excess {
                last.amount = (cents - excess) as f64 / 100.0;
                paid = total_cents;
            } else {
                paid -= cents;
                out.pop();
            }
        }
        out
    }

    fn build_print_text(text: &str) -> Vec<u8> {
        Self::cp1250(&Self::truncate(text, 36))
    }

    /// Free fiscal text inside a fiscal / storno receipt (cmd 54, 36h):
    /// `{Text}<SEP>` — the optional Bold/Italic/… flags left out, as
    /// ErpNet.FP AddComment does. Text ≤ PrintColumns-2; 30 fits the
    /// DP-25X's 32-column paper.
    fn build_fiscal_text(text: &str) -> Vec<u8> {
        let mut line = Self::truncate(text, 30);
        line.push('\t');
        Self::cp1250(&line)
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
            // X dialect: free FISCAL text (0x36) — 0x2A is refused inside a
            // fiscal / storno receipt. Legacy: as before.
            if self.x_dialect() {
                let line = Self::build_fiscal_text(text);
                self.exec(t, c.fiscal_text, &line, action, false)?;
            } else {
                let line = Self::build_print_text(text);
                self.exec(t, c.print_text, &line, action, false)?;
            }
        }
        // Subtotal is optional before payment. The X dialect wants
        // `{Print}<SEP>{Display}<SEP>{DiscountType}<SEP>{DiscountValue}<SEP>`
        // and refused our empty body with -112001; ErpNet.FP never sends it
        // for a plain receipt, so the X dialect skips it. Legacy: as before.
        if !self.x_dialect() {
            self.exec(t, c.subtotal, b"", action, false)?;
        }
        for p in payments {
            let data = Self::build_payment(p);
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
    ///
    /// `open_payloads` are alternative forms of the open frame, tried in
    /// order ONLY while the register answers "syntax error" (-112001): a
    /// refused open prints nothing, so trying the next form is safe.
    #[allow(clippy::too_many_arguments)]
    fn run_document(
        &self,
        t: &mut DatecsFpTransport,
        open_cmd: u16,
        open_payloads: &[Vec<u8>],
        items: &[ReceiptItem],
        payments: &[ReceiptPayment],
        reason: Option<&str>,
        action: &str,
    ) -> Result<(FrameResponse, FrameResponse), FiscalError> {
        // A refused open leaves nothing on the register: stop, send no items.
        let mut opened: Option<Result<FrameResponse, FiscalError>> = None;
        for (i, payload) in open_payloads.iter().enumerate() {
            let r = self.exec(t, open_cmd, payload, action, true);
            let syntax = matches!(r, Err(FiscalError::Device { code: SYNTAX_ERROR, .. }));
            opened = Some(r);
            if !syntax {
                break;
            }
            if i + 1 < open_payloads.len() {
                log::warn!("Datecs DP-25: open form {} refused as syntax error — trying the next form", i + 1);
            }
        }
        let open = opened.unwrap_or_else(|| {
            Err(FiscalError::InvalidCommand { detail: "no open frame".into() })
        })?;
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

    /// LEGACY `fp700` variant storno — the pre-DP-25X path, kept unchanged
    /// (0x32 + `build_cancel_open_legacy`). Unverified on hardware.
    fn cancel_receipt_legacy(
        &self,
        req: &CancelReceiptRequest,
        reason: Option<&str>,
    ) -> Result<ReceiptResponse, FiscalError> {
        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let open_payload = self.build_cancel_open_legacy(req);
        let payments = Self::payments_or_cash(&req.items, &req.payments);
        let outcome = self.run_document(
            &mut t,
            self.cfg.cmd_codes.cancel_fiscal,
            &[open_payload],
            &req.items,
            &payments,
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
                "datecs_dp25 storno(legacy) mut={} order={} original={} new_bf={}",
                req.mutation_id,
                req.order_local_id,
                req.original_fiscal_number,
                bf.as_deref().unwrap_or("")
            ),
            error_code: None,
            error_message: None,
        })
    }

    /// Periodic report frame: (command, payload). X dialect: 0x5E
    /// `0\t<DD-MM-YY>\t<DD-MM-YY>\t` (Type 0 = short). Legacy: 0x4F
    /// `<from>\t<to>` exactly as received (DDMMYY), as before.
    fn periodic_frame(&self, date_from: &str, date_to: &str) -> Result<(u16, Vec<u8>), FiscalError> {
        if self.x_dialect() {
            let (from, to) = datecs_params::period_range(date_from, date_to)?;
            Ok((
                self.cfg.cmd_codes.periodic_by_date,
                format!("0\t{from}\t{to}\t").into_bytes(),
            ))
        } else {
            Ok((
                self.cfg.cmd_codes.periodic_memory,
                format!("{date_from}\t{date_to}").into_bytes(),
            ))
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
        let r = r?;
        // X dialect: the 8 status bytes travel inside DATA after 0x04; the
        // legacy 6-byte field after POST is absent (all zeros) on DP-25X.
        if self.x_dialect() {
            Ok(status_dec::decode_x_minimal(reply_status_bytes(&r.data)))
        } else {
            Ok(status_dec::decode_minimal(&r.status))
        }
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
        let payments = Self::payments_or_cash(&req.items, &req.payments);
        let outcome = self.run_document(
            &mut t,
            self.cfg.cmd_codes.open_fiscal,
            &[open_payload],
            &req.items,
            &payments,
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
        // Storno reason as a free-text line so the auditor sees it.
        let reason = if req.reason.trim().is_empty() {
            None
        } else {
            Some(req.reason.as_str())
        };
        if !self.x_dialect() {
            return self.cancel_receipt_legacy(&req, reason);
        }

        // Everything that can be checked without the register first: a bad
        // request never touches the COM port.
        let reason_code = datecs_params::storno_reason_code(req.storno_type.as_deref())?;
        let doc_number = datecs_params::storno_doc_number(&req.original_fiscal_number)?;
        let (datetime, date_only) =
            datecs_params::storno_datetime(req.original_fiscal_date.as_deref())?;
        if date_only {
            log::warn!(
                "Datecs DP-25 storno {}: original receipt has a date but no time — sending {datetime}",
                req.mutation_id
            );
        }
        let fm_from_server = req
            .original_fm_number
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(datecs_params::fm_number)
            .transpose()?;
        let payments = Self::storno_payments(&req.items, &req.payments);

        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let outcome = (|| {
            let fm = match fm_from_server.clone() {
                Some(fm) => fm,
                None => self.read_fm_number(&mut t)?,
            };
            log::info!(
                "Datecs DP-25 storno open: type={reason_code} doc={doc_number} date='{datetime}' fm={fm} (mutation {})",
                req.mutation_id
            );
            let forms = [
                self.build_storno_open(reason_code, &doc_number, &datetime, &fm, false),
                self.build_storno_open(reason_code, &doc_number, &datetime, &fm, true),
            ];
            self.run_document(
                &mut t,
                self.cfg.cmd_codes.storno_open,
                &forms,
                &req.items,
                &payments,
                reason,
                ACT_STORNO,
            )
        })();
        t.close();
        let (open, close) = outcome?;
        let bf = self.fiscal_number(&open, &close);

        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: bf.clone(),
            fiscal_date: Some(now_iso()),
            raw_trace: format!(
                "datecs_dp25 storno mut={} order={} original={} ({}) new_bf={}",
                req.mutation_id,
                req.order_local_id,
                doc_number,
                datetime,
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
        // Fiscal memory report between two dates — see periodic_frame().
        // Dates arrive as DDMMYY from the server (ISO / DD-MM-YY accepted
        // on the X dialect); bad dates are refused before the COM port.
        if date_from.is_empty() || date_to.is_empty() {
            return Err(FiscalError::InvalidCommand {
                detail: "periodic_memory: date_from and date_to are required".into(),
            });
        }
        let (cmd, payload) = self.periodic_frame(date_from, date_to)?;
        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let r = self.exec(&mut t, cmd, &payload, ACT_PERIODIC, false);
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

    fn storno_req(number: &str, date: Option<&str>) -> CancelReceiptRequest {
        CancelReceiptRequest {
            mutation_id: "storno-r1".into(), order_local_id: "o".into(),
            fiscal_attempt_id: "a".into(),
            original_fiscal_number: number.into(),
            original_fiscal_date: date.map(Into::into),
            original_fm_number: None,
            storno_type: None,
            items: vec![item("Cafea", 2.0, 5.0, 0.21)],
            payments: vec![ReceiptPayment { method: PaymentMethod::Cash, amount: 10.0 }],
            currency: "RON".into(), reason: "Retur client".into(),
        }
    }

    #[test]
    fn legacy_cancel_open_keeps_old_shape() {
        let p = provider(true);
        let bytes = p.build_cancel_open_legacy(&storno_req("BF000123", Some("2026-04-27")));
        assert_eq!(String::from_utf8_lossy(&bytes), "1\t0001\t1\tS\tBF000123\t27-04-26");
        let bytes = p.build_cancel_open_legacy(&storno_req("BF000123", None));
        assert_eq!(String::from_utf8_lossy(&bytes), "1\t0001\t1\tS\tBF000123");
    }

    #[test]
    fn storno_open_frame_matches_manual_cmd_43() {
        // {OpCode}{OpPwd}{TillNmb}{Storno}{DocNum}{DateTime}{FMNumber}
        // {Invoice}{ToInvoice}{Reason}[{NSale}], each followed by <SEP>.
        let p = provider(false);
        let ten = p.build_storno_open("1", "46", "14-10-26 18:05:09", "02123456", false);
        assert_eq!(
            String::from_utf8_lossy(&ten),
            "1\t0001\t1\t1\t46\t14-10-26 18:05:09\t02123456\t\t\t\t"
        );
        let eleven = p.build_storno_open("0", "46", "14-10-26 18:05:09", "02123456", true);
        assert_eq!(
            String::from_utf8_lossy(&eleven),
            "1\t0001\t1\t0\t46\t14-10-26 18:05:09\t02123456\t\t\t\t\t"
        );
        assert_eq!(CmdCodes::default().storno_open, 0x2B);
    }

    #[test]
    fn storno_lines_are_positive_like_a_sale() {
        // Inside a storno document the lines keep the sale shape; the
        // document type makes them negative (manual: '-' is for VOID
        // inside a receipt, not for storno).
        let bytes = DatecsDp25Provider::build_register_item(&item("Cafea", 2.0, 5.0, 0.19));
        assert_eq!(String::from_utf8_lossy(&bytes), "Cafea\t1\t5.00\t2.00\t0\t0.00\t0\tbuc\t");
    }

    #[test]
    fn fiscal_text_is_cmd_36_with_sep() {
        assert_eq!(CmdCodes::default().fiscal_text, 0x36);
        let b = DatecsDp25Provider::build_fiscal_text("Retur client");
        assert_eq!(b, b"Retur client\t");
        let long = DatecsDp25Provider::build_fiscal_text(&"x".repeat(60));
        let (s, _, _) = encoding_rs::WINDOWS_1250.decode(&long);
        assert_eq!(s.trim_end_matches('\t').chars().count(), 30);
    }

    #[test]
    fn storno_payments_never_exceed_the_storno_total() {
        let items = vec![item("Cafea", 2.0, 5.0, 0.21)]; // 10.00
        let pay = |m: PaymentMethod, a: f64| ReceiptPayment { method: m, amount: a };
        // Tip on the original: 12.00 paid by card → 10.00.
        let out = DatecsDp25Provider::storno_payments(&items, &[pay(PaymentMethod::Card, 12.0)]);
        assert_eq!(out.len(), 1);
        assert!((out[0].amount - 10.0).abs() < 1e-9);
        // Cash 8 + card 5 → cash 8 + card 2.
        let out = DatecsDp25Provider::storno_payments(
            &items,
            &[pay(PaymentMethod::Cash, 8.0), pay(PaymentMethod::Card, 5.0)],
        );
        assert_eq!(out.len(), 2);
        assert!((out[1].amount - 2.0).abs() < 1e-9);
        // Cash 10 + card 3 → card dropped.
        let out = DatecsDp25Provider::storno_payments(
            &items,
            &[pay(PaymentMethod::Cash, 10.0), pay(PaymentMethod::Card, 3.0)],
        );
        assert_eq!(out.len(), 1);
        // No payment → one cash payment for the total.
        let out = DatecsDp25Provider::storno_payments(&items, &[]);
        assert!(matches!(out[0].method, PaymentMethod::Cash));
        assert!((out[0].amount - 10.0).abs() < 1e-9);
    }

    #[test]
    fn periodic_report_is_0x5e_with_type_and_dashed_dates() {
        let (cmd, payload) = provider(false).periodic_frame("011026", "151026").unwrap();
        assert_eq!(cmd, 0x5E);
        assert_eq!(payload, b"0\t01-10-26\t15-10-26\t");
        // ISO accepted too; a reversed range is refused before the port.
        let (_, iso) = provider(false).periodic_frame("2026-09-01", "2026-09-30").unwrap();
        assert_eq!(iso, b"0\t01-09-26\t30-09-26\t");
        assert!(provider(false).periodic_frame("151026", "011026").is_err());
        // Legacy variant unchanged.
        let (lcmd, lpayload) = provider(true).periodic_frame("011026", "151026").unwrap();
        assert_eq!(lcmd, 0x4F);
        assert_eq!(lpayload, b"011026\t151026");
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

    // ---------------------------------------------------------------
    // Whole command sequences against a scripted fake DP-25X.

    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::sync::Arc;

    type Log = Arc<Mutex<Vec<(u16, String)>>>;
    type Responder = Box<dyn FnMut(u16, &str) -> String + Send>;

    /// Decodes each frame the driver writes (STX LEN SEQ CMD DATA POST BCC
    /// ETX, 0x30 nibble offset), logs (cmd, data) and answers with
    /// `respond(cmd, data)` + 0x04 + the 8 status bytes.
    struct FakeRegister {
        inbuf: Vec<u8>,
        out: VecDeque<u8>,
        log: Log,
        status: [u8; 8],
        respond: Responder,
    }

    impl Write for FakeRegister {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.inbuf.extend_from_slice(buf);
            if self.inbuf.last() == Some(&0x03) {
                let frame = std::mem::take(&mut self.inbuf);
                let seq = frame[5];
                let cmd = frame[6..10]
                    .iter()
                    .fold(0u16, |acc, b| (acc << 4) | (b.wrapping_sub(0x30) & 0x0F) as u16);
                let data = &frame[10..frame.len() - 6];
                let (text, _, _) = encoding_rs::WINDOWS_1250.decode(data);
                self.log.lock().unwrap().push((cmd, text.to_string()));
                let fields = (self.respond)(cmd, &text);
                let mut reply = vec![0x01, 0x30, 0x30, 0x30, 0x30, seq];
                reply.extend_from_slice(&frame[6..10]);
                reply.extend_from_slice(fields.as_bytes());
                reply.push(0x04);
                reply.extend_from_slice(&self.status);
                reply.extend_from_slice(&[0x05, 0x30, 0x30, 0x30, 0x30, 0x03]);
                self.out.extend(reply);
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Read for FakeRegister {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.out.pop_front() {
                Some(b) => {
                    buf[0] = b;
                    Ok(1)
                }
                None => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "no reply")),
            }
        }
    }

    fn on_fake(
        p: &DatecsDp25Provider,
        status: [u8; 8],
        respond: impl FnMut(u16, &str) -> String + Send + 'static,
    ) -> Log {
        let log: Log = Arc::new(Mutex::new(Vec::new()));
        let fake = FakeRegister {
            inbuf: Vec::new(),
            out: VecDeque::new(),
            log: log.clone(),
            status,
            respond: Box::new(respond),
        };
        p.transport.lock().unwrap().attach_for_test(Box::new(fake));
        log
    }

    fn cmds(log: &Log) -> Vec<u16> {
        log.lock().unwrap().iter().map(|(c, _)| *c).collect()
    }

    fn data_of(log: &Log, cmd: u16) -> Vec<String> {
        log.lock().unwrap().iter().filter(|(c, _)| *c == cmd).map(|(_, d)| d.clone()).collect()
    }

    const DEVICE_INFO: &str = "DP-25X,1.00RO 14Mar24 1200,ABCD,00000000,DT123456,02123456";

    fn happy(cmd: u16, _data: &str) -> String {
        match cmd {
            0x5A => DEVICE_INFO.into(),
            0x2B | 0x31 | 0x38 => "0\t47\t".into(),
            0x36 | 0x35 => "0\t".into(),
            _ => "-100999\t".into(),
        }
    }

    #[test]
    fn storno_sequence_open_2b_lines_text_payment_close() {
        let p = provider(false);
        let log = on_fake(&p, OWNER_STATUS, happy);
        let r = p
            .cancel_receipt(storno_req("000046", Some("2026-10-14T18:05:09")))
            .expect("storno printed");
        assert_eq!(cmds(&log), vec![0x5A, 0x2B, 0x31, 0x36, 0x35, 0x38]);
        assert_eq!(data_of(&log, 0x5A), vec!["1".to_string()]);
        assert_eq!(
            data_of(&log, 0x2B),
            vec!["1\t0001\t1\t1\t46\t14-10-26 18:05:09\t02123456\t\t\t\t".to_string()]
        );
        assert_eq!(data_of(&log, 0x31), vec!["Cafea\t1\t5.00\t2.00\t0\t0.00\t0\tbuc\t".to_string()]);
        assert_eq!(data_of(&log, 0x36), vec!["Retur client\t".to_string()]);
        assert_eq!(data_of(&log, 0x35), vec!["0\t10.00\t".to_string()]);
        assert_eq!(r.fiscal_number.as_deref(), Some("47"));
        // Never the old 0x32 (= "active VAT rates" on the DP-25X).
        assert!(!cmds(&log).contains(&0x32));
    }

    #[test]
    fn storno_uses_server_fm_number_and_reason_type() {
        let p = provider(false);
        let log = on_fake(&p, OWNER_STATUS, happy);
        let mut req = storno_req("46", Some("2026-10-14 09:00:00"));
        req.original_fm_number = Some("02999999".into());
        req.storno_type = Some("operator_error".into());
        req.reason = String::new();
        p.cancel_receipt(req).expect("storno printed");
        // No 0x5A read, no text line without a reason.
        assert_eq!(cmds(&log), vec![0x2B, 0x31, 0x35, 0x38]);
        assert_eq!(
            data_of(&log, 0x2B),
            vec!["1\t0001\t1\t0\t46\t14-10-26 09:00:00\t02999999\t\t\t\t".to_string()]
        );
    }

    #[test]
    fn storno_retries_open_with_nsale_field_only_on_syntax_error() {
        let p = provider(false);
        let mut opens = 0;
        let log = on_fake(&p, OWNER_STATUS, move |cmd, data| {
            if cmd == 0x2B {
                opens += 1;
                return if opens == 1 { "-112001\t".into() } else { "0\t47\t".into() };
            }
            happy(cmd, data)
        });
        p.cancel_receipt(storno_req("46", Some("2026-10-14T18:05:09"))).expect("second form accepted");
        assert_eq!(cmds(&log), vec![0x5A, 0x2B, 0x2B, 0x31, 0x36, 0x35, 0x38]);
        let forms = data_of(&log, 0x2B);
        assert!(forms[0].ends_with("02123456\t\t\t\t"));
        assert!(forms[1].ends_with("02123456\t\t\t\t\t"));
    }

    #[test]
    fn storno_open_refused_sends_nothing_else() {
        let p = provider(false);
        let log = on_fake(&p, OWNER_STATUS, |cmd, data| {
            if cmd == 0x2B { "-111024\t".into() } else { happy(cmd, data) }
        });
        let e = p.cancel_receipt(storno_req("46", Some("2026-10-14T18:05:09"))).unwrap_err();
        assert!(matches!(e, FiscalError::Device { code: -111024, .. }));
        assert!(e.to_string().starts_with("Casa a refuzat bonul de stornare: Este necesar raportul Z"));
        // Not a syntax error → no second form, no lines, no 0x3C.
        assert_eq!(cmds(&log), vec![0x5A, 0x2B]);
    }

    #[test]
    fn storno_line_refused_voids_the_open_document() {
        let p = provider(false);
        let log = on_fake(&p, OWNER_STATUS, |cmd, data| match cmd {
            0x31 => "-100999\t".into(),
            0x3C => "0\t".into(),
            _ => happy(cmd, data),
        });
        let e = p.cancel_receipt(storno_req("46", Some("2026-10-14T18:05:09"))).unwrap_err();
        assert!(matches!(e, FiscalError::Device { code: -100999, .. }));
        assert_eq!(cmds(&log), vec![0x5A, 0x2B, 0x31, 0x3C]);
    }

    #[test]
    fn storno_bad_request_never_touches_the_port() {
        // No fake attached: a COM access would fail with "open COMx".
        let p = provider(false);
        for req in [
            storno_req("46", None),
            storno_req("TEST-1760000000", Some("2026-10-14")),
            storno_req("46", Some("@unix:1760000000")),
        ] {
            let e = p.cancel_receipt(req).unwrap_err();
            assert!(matches!(e, FiscalError::InvalidCommand { .. }), "{e}");
        }
        let mut bad_type = storno_req("46", Some("2026-10-14"));
        bad_type.storno_type = Some("nimic".into());
        assert!(matches!(p.cancel_receipt(bad_type).unwrap_err(), FiscalError::InvalidCommand { .. }));
    }

    #[test]
    fn status_reads_the_x_status_bytes() {
        let p = provider(false);
        let mut st = OWNER_STATUS;
        st[2] |= 0x01; // end of paper
        let _log = on_fake(&p, st, |_, _| "0\t".into());
        let s = p.get_status().unwrap();
        assert!(!s.ready && !s.paper_ok);
        assert_eq!(s.error_code.as_deref(), Some("X_PAPER_OUT"));

        let p = provider(false);
        let mut st = OWNER_STATUS;
        st[0] |= 0x40; // cover open
        let _log = on_fake(&p, st, |_, _| "0\t".into());
        let s = p.get_status().unwrap();
        assert!(s.error_message.unwrap().starts_with("Capacul casei"));

        let p = provider(false);
        let _log = on_fake(&p, OWNER_STATUS, |_, _| "0\t".into());
        let s = p.get_status().unwrap();
        assert!(s.ready && s.paper_ok && s.error_message.is_none());
    }

    #[test]
    fn periodic_report_sequence() {
        let p = provider(false);
        let log = on_fake(&p, OWNER_STATUS, |_, _| "0\t".into());
        p.print_periodic_memory("011026", "151026").expect("printed");
        assert_eq!(cmds(&log), vec![0x5E]);
        assert_eq!(data_of(&log, 0x5E), vec!["0\t01-10-26\t15-10-26\t".to_string()]);
    }

    #[test]
    fn receipt_sequence_unchanged() {
        let p = provider(false);
        let log = on_fake(&p, OWNER_STATUS, |cmd, _| match cmd {
            0x30 | 0x31 | 0x38 => "0\t48\t".into(),
            _ => "0\t".into(),
        });
        let r = p
            .print_receipt(ReceiptRequest {
                mutation_id: "m".into(), order_local_id: "o".into(), fiscal_attempt_id: "a".into(),
                items: vec![item("Cafea", 1.0, 5.0, 0.21)], payments: vec![],
                currency: "RON".into(), customer_cif: None, customer_name: None, footer_note: None,
            })
            .unwrap();
        assert_eq!(cmds(&log), vec![0x30, 0x31, 0x35, 0x38]);
        assert_eq!(data_of(&log, 0x35), vec!["0\t5.00\t".to_string()]);
        assert_eq!(r.fiscal_number.as_deref(), Some("48"));
    }
}
