// Datecs FP-55 / DP-25 wire framing — port of fiscal-bridge/bridge/printers/
// datecs_fp.py. Frame layout:
//
//   STX(0x01) | LEN(4 nibbles, +0x20) | SEQ(1 byte 0x20..0x7F)
//             | CMD(4 nibbles, +0x20) | DATA(CP1250) | POST(0x05)
//             | BCC(4 nibbles SUM, +0x20) | ETX(0x03)
//
// Reply same layout + 6 STATUS bytes between POST and BCC.
// Control bytes:  ACK 0x06 (unused),  NAK 0x15 (raise),  SYN 0x16 (busy).
//
// FP-700 fallback dialect: nibble offset 0x30, BCC = XOR, CMD width = 1
// (single raw byte). Switchable at runtime via DatecsTransportConfig.
//
// Reference: Datecs DP-25 integrator manual + Python port already validated
// against real DP-25 hardware (memory: project_fiscal_bridge_flap_fix).

use std::io::{ErrorKind, Read, Write};
use std::time::{Duration, Instant};

use serialport::SerialPort;

use crate::fiscal::error::FiscalError;

pub const STX: u8 = 0x01;
pub const ETX: u8 = 0x03;
pub const POST: u8 = 0x05;
pub const SYN: u8 = 0x16;
pub const NAK: u8 = 0x15;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BccAlgo {
    Sum,
    Xor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BccCoverage {
    /// SEQ..POST (FP-55 / DP-25 default).
    Body,
    /// LEN..POST (rare variant).
    LenBody,
}

#[derive(Debug, Clone)]
pub struct DatecsTransportConfig {
    pub port: String,
    pub baud: u32,
    pub timeout: Duration,
    pub encoding_offset: u8, // 0x20 (FP-55) or 0x30 (FP-700)
    pub bcc_algo: BccAlgo,
    pub bcc_coverage: BccCoverage,
    pub cmd_width: u8, // 4 (FP-55) or 1 (FP-700)
}

impl DatecsTransportConfig {
    pub fn fp55(port: impl Into<String>, baud: u32) -> Self {
        Self {
            port: port.into(),
            baud,
            timeout: Duration::from_secs(3),
            encoding_offset: 0x20,
            bcc_algo: BccAlgo::Sum,
            bcc_coverage: BccCoverage::Body,
            cmd_width: 4,
        }
    }

    pub fn fp700(port: impl Into<String>, baud: u32) -> Self {
        Self {
            port: port.into(),
            baud,
            timeout: Duration::from_secs(3),
            encoding_offset: 0x30,
            bcc_algo: BccAlgo::Xor,
            bcc_coverage: BccCoverage::Body,
            cmd_width: 1,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FrameResponse {
    pub cmd: u16,
    pub data: Vec<u8>,
    pub status: [u8; 6],
    pub raw: Vec<u8>,
}

pub struct DatecsFpTransport {
    cfg: DatecsTransportConfig,
    port: Option<Box<dyn SerialPort>>,
    seq: u8,
}

impl DatecsFpTransport {
    pub fn new(cfg: DatecsTransportConfig) -> Self {
        Self {
            cfg,
            port: None,
            seq: 0x1F, // first next_seq() returns 0x20
        }
    }

    pub fn open(&mut self) -> Result<(), FiscalError> {
        if self.port.is_some() {
            return Ok(());
        }
        let port = serialport::new(&self.cfg.port, self.cfg.baud)
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .flow_control(serialport::FlowControl::None)
            .timeout(self.cfg.timeout)
            .open()
            .map_err(|e| FiscalError::CommunicationError {
                detail: format!("open {}: {e}", self.cfg.port),
            })?;
        self.port = Some(port);
        Ok(())
    }

    pub fn close(&mut self) {
        self.port = None;
    }

    fn next_seq(&mut self) -> u8 {
        self.seq = if self.seq >= 0x7F { 0x20 } else { self.seq + 1 };
        self.seq
    }

    fn build_frame(&mut self, cmd: u16, data: &[u8]) -> Vec<u8> {
        let seq = self.next_seq();
        let cmd_enc = if self.cfg.cmd_width == 4 {
            encode_4nibbles(cmd, self.cfg.encoding_offset).to_vec()
        } else {
            vec![cmd as u8]
        };

        let mut body = Vec::with_capacity(1 + cmd_enc.len() + data.len() + 1);
        body.push(seq);
        body.extend_from_slice(&cmd_enc);
        body.extend_from_slice(data);
        body.push(POST);

        let length_enc = encode_4nibbles(body.len() as u16, self.cfg.encoding_offset);

        let bcc_target: Vec<u8> = match self.cfg.bcc_coverage {
            BccCoverage::Body => body.clone(),
            BccCoverage::LenBody => {
                let mut v = length_enc.to_vec();
                v.extend_from_slice(&body);
                v
            }
        };
        let bcc = calc_bcc(&bcc_target, self.cfg.bcc_algo, self.cfg.encoding_offset);

        let mut frame = Vec::with_capacity(1 + 4 + body.len() + 4 + 1);
        frame.push(STX);
        frame.extend_from_slice(&length_enc);
        frame.extend_from_slice(&body);
        frame.extend_from_slice(&bcc);
        frame.push(ETX);
        frame
    }

    fn read_frame(&mut self) -> Result<Vec<u8>, FiscalError> {
        let port = self.port.as_mut().ok_or_else(|| FiscalError::CommunicationError {
            detail: "port not open".into(),
        })?;
        let mut buf: Vec<u8> = Vec::new();
        let deadline = Instant::now() + self.cfg.timeout.max(Duration::from_secs(3));
        let mut byte = [0u8; 1];
        while Instant::now() < deadline {
            match port.read(&mut byte) {
                Ok(0) => continue,
                Ok(_) => {}
                Err(e) if e.kind() == ErrorKind::TimedOut => continue,
                Err(e) => return Err(FiscalError::CommunicationError {
                    detail: format!("read: {e}"),
                }),
            }
            match byte[0] {
                SYN => continue, // device busy — keep waiting
                NAK => return Err(FiscalError::InvalidCommand {
                    detail: "device NAK".into(),
                }),
                STX => buf.clear(),
                ETX => return Ok(buf),
                b => buf.push(b),
            }
        }
        Err(FiscalError::CommunicationError {
            detail: format!("frame timeout after {:?}", self.cfg.timeout),
        })
    }

    pub fn execute(&mut self, cmd: u16, data: &[u8]) -> Result<FrameResponse, FiscalError> {
        let frame = self.build_frame(cmd, data);
        log::debug!(
            "datecs_fp → cmd=0x{:02X} data={} frame={}",
            cmd,
            hex::encode_short(data),
            hex::encode_short(&frame),
        );
        {
            let port = self.port.as_mut().ok_or_else(|| FiscalError::CommunicationError {
                detail: "port not open".into(),
            })?;
            port.write_all(&frame).map_err(|e| FiscalError::CommunicationError {
                detail: format!("write: {e}"),
            })?;
            port.flush().ok();
        }
        let raw = self.read_frame()?;
        log::debug!("datecs_fp ← raw={}", hex::encode_short(&raw));

        // raw layout: LEN(4) + SEQ(1) + CMD(4 or 1) + DATA + POST + STATUS(6) + BCC(4)
        // Minimum size = 4 + 1 + cmd_width + 1 + 6 + 4
        let cmd_width = self.cfg.cmd_width as usize;
        let min_len = 4 + 1 + cmd_width + 1 + 6 + 4;
        if raw.len() < min_len {
            return Err(FiscalError::CommunicationError {
                detail: format!("short frame: {} bytes", raw.len()),
            });
        }
        // CMD echoed at index 5 — decode according to cmd_width
        let cmd_echo: u16 = if cmd_width == 4 {
            decode_4nibbles(&raw[5..9], self.cfg.encoding_offset)
        } else {
            raw[5] as u16
        };
        let post_idx = raw[5 + cmd_width..]
            .iter()
            .position(|b| *b == POST)
            .map(|i| i + 5 + cmd_width)
            .ok_or_else(|| FiscalError::CommunicationError {
                detail: "no POST marker in reply".into(),
            })?;
        let data_bytes = raw[5 + cmd_width..post_idx].to_vec();
        if raw.len() < post_idx + 1 + 6 {
            return Err(FiscalError::CommunicationError {
                detail: "missing 6-byte STATUS in reply".into(),
            });
        }
        let mut status = [0u8; 6];
        status.copy_from_slice(&raw[post_idx + 1..post_idx + 7]);
        Ok(FrameResponse {
            cmd: cmd_echo,
            data: data_bytes,
            status,
            raw,
        })
    }
}

fn encode_4nibbles(value: u16, offset: u8) -> [u8; 4] {
    [
        (((value >> 12) & 0xF) as u8) + offset,
        (((value >> 8) & 0xF) as u8) + offset,
        (((value >> 4) & 0xF) as u8) + offset,
        ((value & 0xF) as u8) + offset,
    ]
}

fn decode_4nibbles(bytes: &[u8], offset: u8) -> u16 {
    let n0 = bytes[0].wrapping_sub(offset) & 0xF;
    let n1 = bytes[1].wrapping_sub(offset) & 0xF;
    let n2 = bytes[2].wrapping_sub(offset) & 0xF;
    let n3 = bytes[3].wrapping_sub(offset) & 0xF;
    ((n0 as u16) << 12) | ((n1 as u16) << 8) | ((n2 as u16) << 4) | (n3 as u16)
}

fn calc_bcc(payload: &[u8], algo: BccAlgo, offset: u8) -> [u8; 4] {
    let total: u16 = match algo {
        BccAlgo::Sum => payload.iter().fold(0u32, |acc, b| acc + (*b as u32)) as u16,
        BccAlgo::Xor => payload.iter().fold(0u8, |acc, b| acc ^ b) as u16,
    };
    encode_4nibbles(total, offset)
}

mod hex {
    pub fn encode_short(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes.iter().take(64) {
            s.push_str(&format!("{:02x}", b));
        }
        if bytes.len() > 64 {
            s.push_str("...");
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fp55_encoding_offset() {
        // 0x1234 → nibbles 1,2,3,4 → +0x20 = 0x21,0x22,0x23,0x24
        assert_eq!(encode_4nibbles(0x1234, 0x20), [0x21, 0x22, 0x23, 0x24]);
    }

    #[test]
    fn fp700_encoding_offset() {
        assert_eq!(encode_4nibbles(0x1234, 0x30), [0x31, 0x32, 0x33, 0x34]);
    }

    #[test]
    fn decode_roundtrip() {
        for v in [0u16, 1, 0x4A, 0x1234, 0xFFFF] {
            let enc = encode_4nibbles(v, 0x20);
            assert_eq!(decode_4nibbles(&enc, 0x20), v);
            let enc7 = encode_4nibbles(v, 0x30);
            assert_eq!(decode_4nibbles(&enc7, 0x30), v);
        }
    }

    #[test]
    fn bcc_sum_matches_python() {
        // Python: sum bytes & 0xFFFF, encoded with same offset.
        let payload = b" !\"#"; // 0x20+0x21+0x22+0x23 = 0x86
        let bcc = calc_bcc(payload, BccAlgo::Sum, 0x20);
        // 0x0086 → nibbles 0,0,8,6 → 0x20,0x20,0x28,0x26
        assert_eq!(bcc, [0x20, 0x20, 0x28, 0x26]);
    }

    #[test]
    fn bcc_xor_fp700() {
        let payload = b"\x01\x02\x04";
        let bcc = calc_bcc(payload, BccAlgo::Xor, 0x30);
        // XOR = 0x07 → 0x30,0x30,0x30,0x37
        assert_eq!(bcc, [0x30, 0x30, 0x30, 0x37]);
    }
}
