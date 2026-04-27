use crate::fiscal::dto::{
    CancelReceiptRequest, FiscalStatus, ReceiptRequest, ReceiptResponse, TestResult,
};
use crate::fiscal::error::FiscalError;

pub trait FiscalPrinterProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn test_connection(&self) -> Result<TestResult, FiscalError>;
    fn get_status(&self) -> Result<FiscalStatus, FiscalError>;
    fn print_receipt(&self, req: ReceiptRequest) -> Result<ReceiptResponse, FiscalError>;
    /// Sprint 2 / Q3 — storno. Default impl returns NotImplemented so a
    /// provider can opt into supporting it without breaking trait callers.
    fn cancel_receipt(&self, _req: CancelReceiptRequest) -> Result<ReceiptResponse, FiscalError> {
        Err(FiscalError::InvalidCommand {
            detail: "cancel_receipt not supported by this provider".into(),
        })
    }
    /// Sprint 2 / Q7 — Z-report behind an admin gate. Caller must supply a
    /// fresh confirm_token issued by `fiscal_request_z_confirm`. Default impl
    /// rejects so providers explicitly opt in.
    fn print_z_report(&self, _confirm_token: &str) -> Result<ReceiptResponse, FiscalError> {
        Err(FiscalError::InvalidCommand {
            detail: "z_report not supported by this provider".into(),
        })
    }
}
