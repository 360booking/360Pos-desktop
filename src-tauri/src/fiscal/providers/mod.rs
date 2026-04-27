pub mod datecs_dp25;
pub mod simulator;

use crate::fiscal::error::FiscalError;
use crate::fiscal::provider::FiscalPrinterProvider;

pub fn build(name: &str) -> Result<Box<dyn FiscalPrinterProvider>, FiscalError> {
    match name {
        "simulator" => Ok(Box::new(simulator::SimulatorProvider::default())),
        "datecs_dp25" | "datecs_fp" => {
            // datecs_fp is the family alias — the same provider with config
            // overrides handles DP-150/FP-550 once we have wire fixtures.
            let cfg = datecs_config_from_env()?;
            Ok(Box::new(datecs_dp25::DatecsDp25Provider::new(cfg)))
        }
        other => Err(FiscalError::ConfigurationError {
            detail: format!("unknown fiscal provider: {other}"),
        }),
    }
}

fn datecs_config_from_env() -> Result<datecs_dp25::DatecsConfig, FiscalError> {
    use datecs_dp25::{CmdCodes, DatecsConfig};
    let port = std::env::var("FISCAL_SERIAL_PORT").map_err(|_| FiscalError::ConfigurationError {
        detail: "FISCAL_SERIAL_PORT not set (e.g. COM3 or /dev/ttyUSB0)".into(),
    })?;
    let baud: u32 = std::env::var("FISCAL_BAUD_RATE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(9600);
    let operator = std::env::var("FISCAL_OPERATOR").unwrap_or_else(|_| "1".into());
    let operator_password = std::env::var("FISCAL_OPERATOR_PASSWORD")
        .unwrap_or_else(|_| "0000".into());
    let variant_fp700 = matches!(
        std::env::var("FISCAL_PROTOCOL_VARIANT").as_deref(),
        Ok("fp700")
    );
    Ok(DatecsConfig {
        serial_port: port,
        baud,
        operator,
        operator_password,
        variant_fp700,
        cmd_codes: CmdCodes::default(),
    })
}
