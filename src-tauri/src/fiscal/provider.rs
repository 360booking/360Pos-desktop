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
    /// X-report — intermediate readout that does NOT zero the daily counters.
    /// Safe to run any time, no confirm token. Default impl rejects so
    /// providers opt in.
    fn print_x_report(&self) -> Result<ReceiptResponse, FiscalError> {
        Err(FiscalError::InvalidCommand {
            detail: "x_report not supported by this provider".into(),
        })
    }
    /// Pop the cash drawer (kick-out pulse on the drawer-port pin).
    /// Safe to run any time; no confirm token. Default impl rejects.
    fn open_cash_drawer(&self) -> Result<(), FiscalError> {
        Err(FiscalError::InvalidCommand {
            detail: "open_cash_drawer not supported by this provider".into(),
        })
    }
    /// Reprint the last fiscal receipt as a non-fiscal duplicate copy
    /// (with "DUPLICATE" / "COPIE" header per Romanian fiscal regulation).
    /// Default impl rejects so providers opt in explicitly.
    fn reprint_last_receipt(&self) -> Result<ReceiptResponse, FiscalError> {
        Err(FiscalError::InvalidCommand {
            detail: "reprint_last_receipt not supported by this provider".into(),
        })
    }
    /// Print a periodic memory report between two dates (used for the
    /// monthly ANAF readout). Dates are DDMMYY strings in Datecs lingo;
    /// providers convert as needed.
    fn print_periodic_memory(
        &self,
        _date_from: &str,
        _date_to: &str,
    ) -> Result<ReceiptResponse, FiscalError> {
        Err(FiscalError::InvalidCommand {
            detail: "periodic_memory not supported by this provider".into(),
        })
    }
}
