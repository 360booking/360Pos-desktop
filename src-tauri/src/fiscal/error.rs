use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum FiscalError {
    CommunicationError { detail: String },
    PrinterBusy,
    PaperError { detail: String },
    FiscalMemoryError { detail: String },
    InvalidCommand { detail: String },
    NotFiscalized { detail: String },
    ConfigurationError { detail: String },
    UnknownFiscalError { detail: String },
    Other { detail: String },
    /// The register answered the frame but refused the command: the DP-25X
    /// `ErrorCode` (first answer field) was negative. `message` is the
    /// complete Romanian text for the operator (it already ends with the
    /// code), so `Display` prints it as-is — that string is what the guide,
    /// „Avansat”, the offline till and the server's job_result receive.
    Device { code: i64, message: String },
}

impl std::fmt::Display for FiscalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FiscalError::CommunicationError { detail } => write!(f, "communication error: {detail}"),
            FiscalError::PrinterBusy => write!(f, "printer busy"),
            FiscalError::PaperError { detail } => write!(f, "paper error: {detail}"),
            FiscalError::FiscalMemoryError { detail } => write!(f, "fiscal memory error: {detail}"),
            FiscalError::InvalidCommand { detail } => write!(f, "invalid command: {detail}"),
            FiscalError::NotFiscalized { detail } => write!(f, "not fiscalized: {detail}"),
            FiscalError::ConfigurationError { detail } => write!(f, "configuration error: {detail}"),
            FiscalError::UnknownFiscalError { detail } => write!(f, "unknown fiscal error: {detail}"),
            FiscalError::Other { detail } => write!(f, "other: {detail}"),
            FiscalError::Device { message, .. } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for FiscalError {}
