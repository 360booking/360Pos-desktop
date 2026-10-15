use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::fiscal::dto::{
    CancelReceiptRequest, FiscalStatus, ReceiptRequest, ReceiptResponse, ReceiptStatus,
    TestResult,
};
use crate::fiscal::error::FiscalError;
use crate::fiscal::mapping::datecs_params;
use crate::fiscal::provider::FiscalPrinterProvider;

#[derive(Default)]
pub struct SimulatorProvider {
    counter: AtomicU64,
}

impl FiscalPrinterProvider for SimulatorProvider {
    fn name(&self) -> &'static str {
        "simulator"
    }

    fn test_connection(&self) -> Result<TestResult, FiscalError> {
        Ok(TestResult {
            ok: true,
            detail: "simulator".into(),
        })
    }

    fn get_status(&self) -> Result<FiscalStatus, FiscalError> {
        Ok(FiscalStatus {
            online: true,
            paper_ok: true,
            ready: true,
            busy: false,
            error_code: None,
            error_message: None,
            raw: Some("SIM_STATUS_OK".into()),
            codes: Vec::new(),
        })
    }

    fn print_receipt(&self, req: ReceiptRequest) -> Result<ReceiptResponse, FiscalError> {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: Some(format!("SIM-{unix}-{n:06}")),
            fiscal_date: None,
            raw_trace: format!(
                "SIM print mutation={} order={} attempt={} items={} payments={}",
                req.mutation_id,
                req.order_local_id,
                req.fiscal_attempt_id,
                req.items.len(),
                req.payments.len()
            ),
            error_code: None,
            error_message: None,
        })
    }

    fn cancel_receipt(&self, req: CancelReceiptRequest) -> Result<ReceiptResponse, FiscalError> {
        // Same checks as the DP-25X driver (mapping/datecs_params), so a
        // storno the register would refuse is refused here too — but the
        // simulator's own SIM-… numbers are accepted as originals.
        if req.items.is_empty() {
            return Err(FiscalError::InvalidCommand { detail: "no items on storno".into() });
        }
        datecs_params::storno_reason_code(req.storno_type.as_deref())?;
        if !req.original_fiscal_number.starts_with("SIM-") {
            datecs_params::storno_doc_number(&req.original_fiscal_number)?;
        }
        let (datetime, _) = datecs_params::storno_datetime(req.original_fiscal_date.as_deref())?;
        if let Some(fm) = req.original_fm_number.as_deref().filter(|s| !s.trim().is_empty()) {
            datecs_params::fm_number(fm)?;
        }
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: Some(format!("SIM-STORNO-{unix}-{n:06}")),
            fiscal_date: None,
            raw_trace: format!(
                "SIM storno mutation={} order={} original_bf={} original_date={} reason={:?}",
                req.mutation_id, req.order_local_id, req.original_fiscal_number, datetime, req.reason
            ),
            error_code: None,
            error_message: None,
        })
    }

    fn print_z_report(&self, confirm_token: &str) -> Result<ReceiptResponse, FiscalError> {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: Some(format!("SIM-Z-{n:06}")),
            fiscal_date: None,
            raw_trace: format!("SIM z_report token_prefix={}", confirm_token.get(..6).unwrap_or("")),
            error_code: None,
            error_message: None,
        })
    }

    fn print_x_report(&self) -> Result<ReceiptResponse, FiscalError> {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: Some(format!("SIM-X-{n:06}")),
            fiscal_date: None,
            raw_trace: "SIM x_report".into(),
            error_code: None,
            error_message: None,
        })
    }

    fn open_cash_drawer(&self) -> Result<(), FiscalError> {
        Ok(())
    }

    fn reprint_last_receipt(&self) -> Result<ReceiptResponse, FiscalError> {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: Some(format!("SIM-DUP-{n:06}")),
            fiscal_date: None,
            raw_trace: "SIM reprint_last".into(),
            error_code: None,
            error_message: None,
        })
    }

    fn print_periodic_memory(
        &self,
        date_from: &str,
        date_to: &str,
    ) -> Result<ReceiptResponse, FiscalError> {
        // Same date rules as the DP-25X (0x5E): DDMMYY / DD-MM-YY / ISO,
        // start not after end.
        let (from, to) = datecs_params::period_range(date_from, date_to)?;
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: Some(format!("SIM-PER-{n:06}")),
            fiscal_date: None,
            raw_trace: format!("SIM periodic_memory {from}..{to}"),
            error_code: None,
            error_message: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fiscal::dto::{PaymentMethod, ReceiptItem, ReceiptPayment};

    fn req(number: &str, date: Option<&str>) -> CancelReceiptRequest {
        CancelReceiptRequest {
            mutation_id: "m".into(), order_local_id: "o".into(), fiscal_attempt_id: "a".into(),
            original_fiscal_number: number.into(),
            original_fiscal_date: date.map(Into::into),
            original_fm_number: None, storno_type: None,
            items: vec![ReceiptItem { name: "Cafea".into(), quantity: 1.0, unit_price: 5.0, vat_rate: 0.21 }],
            payments: vec![ReceiptPayment { method: PaymentMethod::Cash, amount: 5.0 }],
            currency: "RON".into(), reason: "".into(),
        }
    }

    #[test]
    fn storno_checks_match_the_register() {
        let sim = SimulatorProvider::default();
        assert!(sim.cancel_receipt(req("46", Some("2026-10-14T18:05:09"))).is_ok());
        assert!(sim.cancel_receipt(req("SIM-1760000000-000001", Some("2026-10-14"))).is_ok());
        assert!(sim.cancel_receipt(req("46", None)).is_err());
        assert!(sim.cancel_receipt(req("BF-", Some("2026-10-14"))).is_err());
    }

    #[test]
    fn periodic_checks_match_the_register() {
        let sim = SimulatorProvider::default();
        let r = sim.print_periodic_memory("011026", "151026").unwrap();
        assert!(r.raw_trace.contains("01-10-26..15-10-26"));
        assert!(sim.print_periodic_memory("151026", "011026").is_err());
        assert!(sim.print_periodic_memory("x", "011026").is_err());
    }
}
