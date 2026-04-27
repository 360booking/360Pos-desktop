use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::fiscal::dto::{
    CancelReceiptRequest, FiscalStatus, ReceiptRequest, ReceiptResponse, ReceiptStatus,
    TestResult,
};
use crate::fiscal::error::FiscalError;
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
                "SIM storno mutation={} order={} original_bf={} reason={:?}",
                req.mutation_id, req.order_local_id, req.original_fiscal_number, req.reason
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
}
