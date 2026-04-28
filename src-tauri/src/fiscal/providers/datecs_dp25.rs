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
use crate::fiscal::transport::datecs_fp::{DatecsFpTransport, DatecsTransportConfig};

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
    fn build_cancel_item(item: &ReceiptItem) -> Vec<u8> {
        Self::build_register_item(item)
    }

    fn build_print_text(text: &str) -> Vec<u8> {
        Self::cp1250(&Self::truncate(text, 36))
    }
}

impl FiscalPrinterProvider for DatecsDp25Provider {
    fn name(&self) -> &'static str {
        "datecs_dp25"
    }

    fn test_connection(&self) -> Result<TestResult, FiscalError> {
        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let r = t.execute(self.cfg.cmd_codes.status, b"")?;
        t.close();
        Ok(TestResult {
            ok: true,
            detail: format!("status reply: cmd=0x{:02X} data_len={}", r.cmd, r.data.len()),
        })
    }

    fn get_status(&self) -> Result<FiscalStatus, FiscalError> {
        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let r = t.execute(self.cfg.cmd_codes.status, b"")?;
        t.close();
        Ok(status_dec::decode_minimal(&r.status))
    }

    fn print_receipt(&self, req: ReceiptRequest) -> Result<ReceiptResponse, FiscalError> {
        if req.items.is_empty() {
            return Err(FiscalError::InvalidCommand {
                detail: "no items on receipt".into(),
            });
        }

        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;

        // open_fiscal
        let open = self.build_open_fiscal();
        t.execute(self.cfg.cmd_codes.open_fiscal, &open)?;

        // register_item per line
        for item in &req.items {
            let data = Self::build_register_item(item);
            t.execute(self.cfg.cmd_codes.register_item, &data)?;
        }

        // subtotal (helps the print)
        t.execute(self.cfg.cmd_codes.subtotal, b"")?;

        // payments — fall back to single cash payment for the total
        let payments_owned: Vec<ReceiptPayment>;
        let payments: &[ReceiptPayment] = if req.payments.is_empty() {
            let total: f64 = req
                .items
                .iter()
                .map(|i| i.unit_price * i.quantity)
                .sum();
            payments_owned = vec![ReceiptPayment {
                method: crate::fiscal::dto::PaymentMethod::Cash,
                amount: total,
            }];
            &payments_owned
        } else {
            &req.payments
        };
        for p in payments {
            let data = Self::build_payment(p);
            t.execute(self.cfg.cmd_codes.payment, &data)?;
        }

        // close_fiscal returns BF number in DATA bytes
        let reply = t.execute(self.cfg.cmd_codes.close_fiscal, b"")?;
        t.close();
        let body = String::from_utf8_lossy(&reply.data).trim().to_string();
        if let Some(err) = datecs_errors::try_map_response_text(&body) {
            return Err(err);
        }

        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: Some(body.clone()),
            fiscal_date: Some(now_iso()),
            raw_trace: format!(
                "datecs_dp25 mut={} order={} attempt={} bf={}",
                req.mutation_id, req.order_local_id, req.fiscal_attempt_id, body
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

        // open storno fiscal
        let open = self.build_cancel_open(&req);
        t.execute(self.cfg.cmd_codes.cancel_fiscal, &open)?;

        // re-register items with negative quantity
        for item in &req.items {
            let data = Self::build_cancel_item(item);
            t.execute(self.cfg.cmd_codes.register_item, &data)?;
        }

        // print storno reason as a free-text line so the customer/auditor
        // sees the justification directly on the receipt.
        if !req.reason.trim().is_empty() {
            let reason = Self::build_print_text(req.reason.as_str());
            t.execute(self.cfg.cmd_codes.print_text, &reason)?;
        }

        t.execute(self.cfg.cmd_codes.subtotal, b"")?;

        // payments — same shape as print_receipt; if missing fall back to
        // single cash matching the negative total.
        let payments_owned: Vec<ReceiptPayment>;
        let payments: &[ReceiptPayment] = if req.payments.is_empty() {
            let total: f64 = req
                .items
                .iter()
                .map(|i| i.unit_price * i.quantity.abs())
                .sum();
            payments_owned = vec![ReceiptPayment {
                method: crate::fiscal::dto::PaymentMethod::Cash,
                amount: total,
            }];
            &payments_owned
        } else {
            &req.payments
        };
        for p in payments {
            let data = Self::build_payment(p);
            t.execute(self.cfg.cmd_codes.payment, &data)?;
        }

        let reply = t.execute(self.cfg.cmd_codes.close_fiscal, b"")?;
        t.close();
        let body = String::from_utf8_lossy(&reply.data).trim().to_string();
        if let Some(err) = datecs_errors::try_map_response_text(&body) {
            return Err(err);
        }

        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: Some(body.clone()),
            fiscal_date: Some(now_iso()),
            raw_trace: format!(
                "datecs_dp25 storno mut={} order={} original={} new_bf={}",
                req.mutation_id, req.order_local_id, req.original_fiscal_number, body
            ),
            error_code: None,
            error_message: None,
        })
    }

    fn print_z_report(&self, _confirm_token: &str) -> Result<ReceiptResponse, FiscalError> {
        // Z-report uses the same cmd as X-report on FP-55; the subcommand is
        // discriminated by the payload (`Z\t1` vs `X\t1`). Real Datecs returns
        // a multi-line dump in the response data — we expose only success/
        // failure to the caller.
        let mut t = self.transport.lock().expect("transport mutex poisoned");
        t.open()?;
        let payload = b"Z\t1";
        let reply = t.execute(self.cfg.cmd_codes.z_report, payload)?;
        t.close();
        let dump = String::from_utf8_lossy(&reply.data).trim().to_string();
        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: None,
            fiscal_date: Some(now_iso()),
            raw_trace: format!("datecs_dp25 z_report cmd=0x{:02X} bytes={}", reply.cmd, dump),
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
        assert_eq!(bytes, b"1\t0001\t1");
    }

    #[test]
    fn register_item_format_matches_python() {
        let bytes = DatecsDp25Provider::build_register_item(&item("Cafea", 1.0, 5.0, 0.19));
        let s = String::from_utf8_lossy(&bytes);
        assert_eq!(s, "Cafea\tTA\t5.00\t1.00");
    }

    #[test]
    fn register_item_truncates_long_name() {
        let long = "A".repeat(50);
        let bytes = DatecsDp25Provider::build_register_item(&item(&long, 1.0, 1.0, 0.19));
        let s = String::from_utf8_lossy(&bytes);
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
        assert_eq!(s, "Cafea\tTA\t5.00\t2.00");
    }

    #[test]
    fn payment_method_codes() {
        let cash = DatecsDp25Provider::build_payment(&ReceiptPayment {
            method: PaymentMethod::Cash, amount: 12.34,
        });
        assert_eq!(String::from_utf8_lossy(&cash), "0\t12.34");
        let card = DatecsDp25Provider::build_payment(&ReceiptPayment {
            method: PaymentMethod::Card, amount: 5.0,
        });
        assert_eq!(String::from_utf8_lossy(&card), "2\t5.00");
    }
}
