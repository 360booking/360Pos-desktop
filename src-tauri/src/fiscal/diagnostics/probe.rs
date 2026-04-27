// Datecs serial probe — port of fiscal-bridge/bridge/probe.py.
// Sweeps dialects (FP-55 / FP-700) × baud rates with CMD_STATUS (0x4A) and
// reports which combination ACKs. The "all NAK = unverified register"
// pattern is preserved so support gets the same hint they get today.
//
// Memory: feedback_fiscal_printer_nak_all_combos — instant NAK on all
// combos almost always means the cash register is not yet ANAF-activated.

use std::time::Duration;

use serde::Serialize;

use crate::fiscal::error::FiscalError;
use crate::fiscal::transport::datecs_fp::{
    BccAlgo, BccCoverage, DatecsFpTransport, DatecsTransportConfig,
};

const CMD_STATUS: u16 = 0x4A;
const COMMON_BAUDS: &[u32] = &[9600, 115200, 19200, 38400, 57600, 4800];

#[derive(Debug, Clone, Serialize)]
pub struct ProbeAttempt {
    pub dialect: String,
    pub baud: u32,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeReport {
    pub port: String,
    pub configured_baud: u32,
    pub attempts: Vec<ProbeAttempt>,
    pub recommended_dialect: Option<String>,
    pub recommended_baud: Option<u32>,
    pub all_nak_hint: bool,
}

fn one(port: &str, baud: u32, dialect: &str) -> ProbeAttempt {
    let cfg = match dialect {
        "fp700" => DatecsTransportConfig {
            timeout: Duration::from_millis(1200),
            encoding_offset: 0x30,
            bcc_algo: BccAlgo::Xor,
            bcc_coverage: BccCoverage::Body,
            cmd_width: 1,
            ..DatecsTransportConfig::fp55(port, baud)
        },
        _ => DatecsTransportConfig {
            timeout: Duration::from_millis(1200),
            ..DatecsTransportConfig::fp55(port, baud)
        },
    };
    let mut t = DatecsFpTransport::new(cfg);
    if let Err(e) = t.open() {
        return ProbeAttempt {
            dialect: dialect.into(),
            baud,
            ok: false,
            error: Some(format!("open failed: {e}")),
        };
    }
    let res = t.execute(CMD_STATUS, b"");
    t.close();
    match res {
        Ok(_) => ProbeAttempt { dialect: dialect.into(), baud, ok: true, error: None },
        Err(FiscalError::InvalidCommand { detail }) if detail == "device NAK" => ProbeAttempt {
            dialect: dialect.into(), baud, ok: false, error: Some("Device NAK".into()),
        },
        Err(e) => ProbeAttempt {
            dialect: dialect.into(), baud, ok: false, error: Some(e.to_string()),
        },
    }
}

pub fn probe_all(port: &str, configured_baud: u32) -> ProbeReport {
    let mut attempts: Vec<ProbeAttempt> = Vec::new();

    let mut bauds: Vec<u32> = vec![configured_baud];
    bauds.extend(COMMON_BAUDS.iter().copied().filter(|b| *b != configured_baud));

    for &baud in &bauds {
        for dialect in ["fp55", "fp700"] {
            let r = one(port, baud, dialect);
            let ok = r.ok;
            attempts.push(r);
            if ok {
                let last = attempts.last().unwrap();
                return ProbeReport {
                    port: port.into(),
                    configured_baud,
                    recommended_dialect: Some(last.dialect.clone()),
                    recommended_baud: Some(last.baud),
                    all_nak_hint: false,
                    attempts,
                };
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    let all_nak = !attempts.is_empty()
        && attempts
            .iter()
            .all(|a| !a.ok && a.error.as_deref() == Some("Device NAK"));

    ProbeReport {
        port: port.into(),
        configured_baud,
        recommended_dialect: None,
        recommended_baud: None,
        all_nak_hint: all_nak,
        attempts,
    }
}

pub fn list_ports() -> Vec<String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default()
}
