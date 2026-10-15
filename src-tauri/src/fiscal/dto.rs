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

/// `cancel_receipt` (storno) request shape. A DP-25X storno document (cmd
/// 0x2B) names the original receipt by its number ON THE REGISTER, its
/// date+time and the fiscal memory number of the register that printed it.
/// `items` are the lines being returned, with positive quantities and
/// prices (the storno document itself makes them negative). `reason` is
/// free text printed on the storno receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelReceiptRequest {
    pub mutation_id: String,
    pub order_local_id: String,
    pub fiscal_attempt_id: String,
    /// The register's number of the original receipt (the slip number the
    /// agent returned as `fiscal_number` when it printed it), 1…9999999.
    pub original_fiscal_number: String,
    /// Date and time of the original receipt, Romanian local time:
    /// `YYYY-MM-DDTHH:MM:SS` (preferred), `YYYY-MM-DD` (older servers — the
    /// time is then sent as 00:00:00) or Datecs `DD-MM-YY hh:mm:ss`.
    /// Mandatory for the DP-25X.
    pub original_fiscal_date: Option<String>,
    /// Fiscal memory number of the register that printed the original.
    /// None → the agent reads it from the connected register (cmd 0x5A),
    /// which is right whenever the original was printed on this register.
    #[serde(default)]
    pub original_fm_number: Option<String>,
    /// `refund` (default, guest return), `operator_error` or
    /// `tax_base_reduction` — the DP-25X `Storno` parameter 1 / 0 / 2.
    #[serde(default)]
    pub storno_type: Option<String>,
    pub items: Vec<ReceiptItem>,
    pub payments: Vec<ReceiptPayment>,
    pub currency: String,
    /// Storno reason — printed on the receipt as a free fiscal text line.
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

// Register status. `error_message` is the Romanian text for the operator:
// set when something blocks printing (paper out, cover open, …), when a
// receipt was left open, and for warnings (paper almost out) while `ready`
// stays true. Decoded in mapping/status.rs.
#[derive(Debug, Clone, Serialize)]
pub struct FiscalStatus {
    pub online: bool,
    pub paper_ok: bool,
    pub ready: bool,
    pub busy: bool,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub raw: Option<String>,
    /// Every decoded status flag (`X_PAPER_OUT`, `X_COVER_OPEN`, …; see
    /// mapping/status.rs), warnings and info included — `error_code` only
    /// carries the most important one. Empty when nothing is set.
    pub codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestResult {
    pub ok: bool,
    pub detail: String,
}
