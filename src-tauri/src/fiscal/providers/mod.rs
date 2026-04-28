pub mod datecs_dp25;
pub mod simulator;

use crate::fiscal::error::FiscalError;
use crate::fiscal::provider::FiscalPrinterProvider;
use crate::fiscal::runtime_config::{self, RuntimeConfig};

/// Build the active provider using the supplied runtime config (DB row + env
/// fallback). The factory does no I/O on its own — `commands.rs` reads
/// `RuntimeConfig` once via `runtime_config::read` and hands it down so a
/// single SQLite hit covers `provider`, `serial_port`, `baud`, etc.
pub fn build(
    name: &str,
    cfg: &RuntimeConfig,
) -> Result<Box<dyn FiscalPrinterProvider>, FiscalError> {
    match name {
        "simulator" => Ok(Box::new(simulator::SimulatorProvider::default())),
        "datecs_dp25" | "datecs_fp" => {
            // datecs_fp is the family alias — same provider with config
            // overrides handles DP-150/FP-550 once we have wire fixtures.
            let dconf = runtime_config::effective_datecs_config(cfg)?;
            Ok(Box::new(datecs_dp25::DatecsDp25Provider::new(dconf)))
        }
        other => Err(FiscalError::ConfigurationError {
            detail: format!("unknown fiscal provider: {other}"),
        }),
    }
}
