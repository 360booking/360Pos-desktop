// Wire format mirrors what the Python bridge ships today (see
// backend/src/services/fiscal/drivers/bridge_agent.py::_receipt_to_wire and
// fiscal-bridge/bridge/printers/datecs_dp25.py::_print_receipt). Keep these
// shapes stable so the TS adapter and the existing FiscalAttempt records
// don't have to change when we cut over.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptItem {
    pub name: String,
    pub quantity: f64,
    pub unit_price: f64,
    pub vat_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentMethod {
    Cash,
    Card,
    Voucher,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptPayment {
    pub method: PaymentMethod,
    pub amount: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptRequest {
    pub mutation_id: String,
    pub order_local_id: String,
    pub fiscal_attempt_id: String,
    pub items: Vec<ReceiptItem>,
    pub payments: Vec<ReceiptPayment>,
    pub currency: String,
    pub customer_cif: Option<String>,
    pub customer_name: Option<String>,
    pub footer_note: Option<String>,
}

/// Sprint 2 / Q3 — `cancel_receipt` (storno) request shape. The original BF
/// is mandatory; Datecs firmware references the original receipt by it.
/// `items` mirror the lines being voided (positive quantities; the driver
/// wraps them as negative when composing the frame). Reasons are free text
/// for the receipt footer, capped server-side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelReceiptRequest {
    pub mutation_id: String,
    pub order_local_id: String,
    pub fiscal_attempt_id: String,
    pub original_fiscal_number: String,
    /// Optional original receipt date (`YYYY-MM-DD`) required by some Datecs
    /// firmwares for storno frame composition. When None the driver uses
    /// today + a vendor-default fiscal memory index.
    pub original_fiscal_date: Option<String>,
    pub items: Vec<ReceiptItem>,
    pub payments: Vec<ReceiptPayment>,
    pub currency: String,
    /// Storno reason — printed on the receipt (max 36 char on DP-25).
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptStatus {
    Printed,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReceiptResponse {
    pub status: ReceiptStatus,
    pub fiscal_number: Option<String>,
    pub fiscal_date: Option<String>,
    pub raw_trace: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

// Minimal Sprint 1 status. Six-byte STATUS decoder (paper low,
// fiscal memory full, etc.) lands Sprint 2 — see audit Q5.
#[derive(Debug, Clone, Serialize)]
pub struct FiscalStatus {
    pub online: bool,
    pub paper_ok: bool,
    pub ready: bool,
    pub busy: bool,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestResult {
    pub ok: bool,
    pub detail: String,
}
