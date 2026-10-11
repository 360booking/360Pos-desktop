pub mod datecs_dp25;
pub mod simulator;

use std::sync::{Mutex, MutexGuard, TryLockError};

use crate::fiscal::dto::{
    CancelReceiptRequest, FiscalStatus, ReceiptRequest, ReceiptResponse, TestResult,
};
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
    let inner: Box<dyn FiscalPrinterProvider> = match name {
        "simulator" => Box::new(simulator::SimulatorProvider::default()),
        "datecs_dp25" | "datecs_fp" => {
            // datecs_fp is the family alias — same provider with config
            // overrides handles DP-150/FP-550 once we have wire fixtures.
            let dconf = runtime_config::effective_datecs_config(cfg)?;
            Box::new(datecs_dp25::DatecsDp25Provider::new(dconf))
        }
        other => {
            return Err(FiscalError::ConfigurationError {
                detail: format!("unknown fiscal provider: {other}"),
            })
        }
    };
    Ok(Box::new(DeviceLocked(inner)))
}

// ---------------------------------------------------------------------------
// Etapa 5 — one device, one conversation at a time.
//
// Every caller (Tauri commands from the fiscal window, the WSS agent job
// runner, the offline till and the printer watchdog) builds its own provider
// instance, and each instance opens the COM port on its own. Two of them
// talking to the DP-25 at the same moment = "access denied" on the port or,
// worse, interleaved frames inside an open receipt. The wrapper below
// serialises every device operation behind one process-wide mutex.

static DEVICE_LOCK: Mutex<()> = Mutex::new(());

/// Blocks until the fiscal device is free. Poisoning (a panic while printing)
/// must not brick the till, so a poisoned lock is simply taken over.
pub fn device_lock() -> MutexGuard<'static, ()> {
    DEVICE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// True while another operation is talking to the device. Used by the
/// watchdog so a status poll never queues behind a receipt.
pub fn device_busy() -> bool {
    matches!(DEVICE_LOCK.try_lock(), Err(TryLockError::WouldBlock))
}

struct DeviceLocked(Box<dyn FiscalPrinterProvider>);

impl FiscalPrinterProvider for DeviceLocked {
    fn name(&self) -> &'static str {
        self.0.name()
    }
    fn test_connection(&self) -> Result<TestResult, FiscalError> {
        let _g = device_lock();
        self.0.test_connection()
    }
    fn get_status(&self) -> Result<FiscalStatus, FiscalError> {
        let _g = device_lock();
        self.0.get_status()
    }
    fn print_receipt(&self, req: ReceiptRequest) -> Result<ReceiptResponse, FiscalError> {
        let _g = device_lock();
        self.0.print_receipt(req)
    }
    fn cancel_receipt(&self, req: CancelReceiptRequest) -> Result<ReceiptResponse, FiscalError> {
        let _g = device_lock();
        self.0.cancel_receipt(req)
    }
    fn print_z_report(&self, confirm_token: &str) -> Result<ReceiptResponse, FiscalError> {
        let _g = device_lock();
        self.0.print_z_report(confirm_token)
    }
    fn print_x_report(&self) -> Result<ReceiptResponse, FiscalError> {
        let _g = device_lock();
        self.0.print_x_report()
    }
    fn open_cash_drawer(&self) -> Result<(), FiscalError> {
        let _g = device_lock();
        self.0.open_cash_drawer()
    }
    fn reprint_last_receipt(&self) -> Result<ReceiptResponse, FiscalError> {
        let _g = device_lock();
        self.0.reprint_last_receipt()
    }
    fn print_periodic_memory(
        &self,
        date_from: &str,
        date_to: &str,
    ) -> Result<ReceiptResponse, FiscalError> {
        let _g = device_lock();
        self.0.print_periodic_memory(date_from, date_to)
    }
}

#[cfg(test)]
mod lock_tests {
    use super::*;

    #[test]
    fn built_provider_is_wrapped_and_releases_lock() {
        // Two sequential calls on the same wrapped provider must not
        // deadlock: the guard is released at the end of each call.
        let p = build("simulator", &RuntimeConfig::default()).unwrap();
        assert_eq!(p.name(), "simulator");
        let _ = p.get_status();
        let _ = p.get_status();
    }
}
