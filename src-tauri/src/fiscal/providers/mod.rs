pub mod datecs_dp25;
pub mod simulator;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, TryLockError};

use crate::fiscal::dto::{
    CancelReceiptRequest, FiscalStatus, ReceiptRequest, ReceiptResponse, ReceiptStatus, TestResult,
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
    Ok(Box::new(DeviceLocked(build_unlocked(name, cfg)?)))
}

/// The provider WITHOUT the device lock. Only for a caller that already
/// holds the guard from `try_device_lock()` / `device_lock()` (the status
/// watchdog, the automatic search): the lock is not re-entrant, so the
/// locked wrapper would deadlock there.
pub fn build_unlocked(
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
    Ok(inner)
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

/// The device if it is free right now, else None (never waits). The
/// watchdog takes it this way so a status poll never sits between the
/// steps of a job or delays a receipt.
pub fn try_device_lock() -> Option<MutexGuard<'static, ()>> {
    match DEVICE_LOCK.try_lock() {
        Ok(g) => Some(g),
        Err(TryLockError::Poisoned(e)) => Some(e.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

// ---------------------------------------------------------------------------
// „Raport Z necesar” — the DP-25X has no status bit for it: it only refuses
// to open a receipt with ErrorCode -111024 once 24 h passed since the first
// sale after the last Z. Every device operation goes through DeviceLocked,
// so this is where we learn it (sticky until a Z or a receipt succeeds).

static Z_REQUIRED: AtomicBool = AtomicBool::new(false);

/// Last receipt/storno was refused with „raport Z necesar” and no Z (and no
/// successful receipt) happened since.
pub fn z_report_required() -> bool {
    Z_REQUIRED.load(Ordering::Relaxed)
}

/// DP-25X ErrorCode for „Z report required (24 h)” — see datecs_errors.rs.
pub const Z_REQUIRED_CODE: i64 = -111024;

fn note_outcome<T>(r: &Result<T, FiscalError>, clears: bool) {
    match r {
        Err(FiscalError::Device { code, .. }) if *code == Z_REQUIRED_CODE => {
            if !Z_REQUIRED.swap(true, Ordering::Relaxed) {
                log::warn!("fiscal: the register asks for a Z report (code {Z_REQUIRED_CODE})");
            }
        }
        Ok(_) if clears => {
            if Z_REQUIRED.swap(false, Ordering::Relaxed) {
                log::info!("fiscal: Z report no longer required");
            }
        }
        _ => {}
    }
}

fn printed(r: &Result<ReceiptResponse, FiscalError>) -> Result<(), FiscalError> {
    match r {
        Ok(resp) if matches!(resp.status, ReceiptStatus::Printed) => Ok(()),
        Ok(_) => Err(FiscalError::Other { detail: "not printed".into() }),
        Err(e) => Err(e.clone()),
    }
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
        let r = self.0.print_receipt(req);
        note_outcome(&printed(&r), true);
        r
    }
    fn cancel_receipt(&self, req: CancelReceiptRequest) -> Result<ReceiptResponse, FiscalError> {
        let _g = device_lock();
        let r = self.0.cancel_receipt(req);
        note_outcome(&printed(&r), true);
        r
    }
    fn print_z_report(&self, confirm_token: &str) -> Result<ReceiptResponse, FiscalError> {
        let _g = device_lock();
        let r = self.0.print_z_report(confirm_token);
        note_outcome(&printed(&r), true);
        r
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

    #[test]
    fn try_lock_is_none_while_held() {
        let _g = device_lock();
        assert!(try_device_lock().is_none());
    }

    #[test]
    fn z_required_is_sticky_until_a_success() {
        let refused: Result<(), FiscalError> = Err(FiscalError::Device {
            code: Z_REQUIRED_CODE,
            message: "Casa a refuzat bonul".into(),
        });
        let other: Result<(), FiscalError> = Err(FiscalError::Device { code: -111016, message: String::new() });
        note_outcome(&refused, true);
        assert!(z_report_required());
        note_outcome(&other, true);
        assert!(z_report_required(), "a later step's error does not clear it");
        note_outcome(&Ok::<(), FiscalError>(()), false);
        assert!(z_report_required(), "a status read does not clear it");
        note_outcome(&Ok::<(), FiscalError>(()), true);
        assert!(!z_report_required());
    }
}
