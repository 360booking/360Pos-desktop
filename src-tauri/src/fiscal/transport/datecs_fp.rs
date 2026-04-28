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
    pub encoding_offset: u8, // 0x30 for DP-25X / FP-700, 0x20 for legacy FP-55
    pub bcc_algo: BccAlgo,
    pub bcc_coverage: BccCoverage,
    pub cmd_width: u8, // 4 (DP-25X / DP-150X) or 1 (FP-700)
    /// DP-25X firmware reports `LEN = body_bytes + 4` (the LEN field counts
    /// itself). The legacy FP-55 documentation said LEN = body only. Set to
    /// true for DP-25X-compatible builds.
    pub len_includes_self: bool,
}

impl DatecsTransportConfig {
    /// Default DP-25 / DP-25X / DP-150X dialect — confirmed against a real
    /// DUDE serial capture on 2026-04-28.
    ///
    /// Wire format:
    ///   STX | LEN(4 nibbles, +0x30) | SEQ | CMD(4 nibbles, +0x30)
    ///       | DATA | POST | BCC(4 nibbles, +0x30) | ETX
    ///
    /// LEN value = number of bytes from `LEN` (inclusive) through `POST`.
    /// BCC algo = sum, coverage = the same `LEN..POST` byte range.
    /// Encoding offset is 0x30 (cifre 0-9 mapped to '0'-'9', cifre A-F to
    /// ':'-'?'). The earlier "FP-55 generic" config used offset 0x20 — that
    /// produced NAK on every command on this firmware family.
    pub fn fp55(port: impl Into<String>, baud: u32) -> Self {
        Self {
            port: port.into(),
            baud,
            timeout: Duration::from_secs(3),
            encoding_offset: 0x30,
            bcc_algo: BccAlgo::Sum,
            bcc_coverage: BccCoverage::LenBody,
            cmd_width: 4,
            len_includes_self: true,
        }
    }

    /// FP-700 fallback — same family but uses XOR BCC and a single raw
    /// command byte. Kept around because some older firmwares still need it,
    /// not the default for DP-25X.
    pub fn fp700(port: impl Into<String>, baud: u32) -> Self {
        Self {
            port: port.into(),
            baud,
            timeout: Duration::from_secs(3),
            encoding_offset: 0x30,
            bcc_algo: BccAlgo::Xor,
            bcc_coverage: BccCoverage::Body,
            cmd_width: 1,
            len_includes_self: false,
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
        let mut port = serialport::new(&self.cfg.port, self.cfg.baud)
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .flow_control(serialport::FlowControl::None)
            .timeout(self.cfg.timeout)
            .open()
            .map_err(|e| FiscalError::CommunicationError {
                detail: format!("open {}: {e}", self.cfg.port),
            })?;
        // Replicate DUDE setup captured 2026-04-28: explicitly drive both
        // modem control lines low and purge the kernel buffers before any
        // I/O. Datecs Virtual Serial Port driver leaves stale bytes from the
        // previous session otherwise; serialport-rs' default also leaves
        // DTR/RTS high which is wrong for this firmware.
        let _ = port.write_data_terminal_ready(false);
        let _ = port.write_request_to_send(false);
        let _ = port.clear(serialport::ClearBuffer::All);
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

        // LEN value on DP-25X = body_byte_count + 0x24 (36 decimal). The
        // constant comes from a 2026-04-28 DUDE capture that matched four
        // distinct frame sizes (6/8/17/37 → 42/44/53/73). It is NOT
        // documented as "+4 LEN field" — the firmware really wants the +36
        // bias, presumably because it counts the LEN+SEQ+CMD+POST+BCC+ETX
        // header overhead (4+1+4+1+4+1 = 15) plus padding... whatever the
        // reason, +0x24 is what reproduces every sniffed frame byte-for-byte.
        // Legacy FP-55 / FP-700 use plain body length; the flag picks.
        let len_value: u16 = if self.cfg.len_includes_self {
            (body.len() as u16) + 0x24
        } else {
            body.len() as u16
        };
        let length_enc = encode_4nibbles(len_value, self.cfg.encoding_offset);

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

        // raw layout (DP-25X confirmed against DUDE 2026-04-28):
        //   LEN(4) + SEQ(1) + CMD(4 or 1) + DATA(...) + POST(1) + BCC(4)
        //
        // The legacy FP-55 spec called for a separate 6-byte STATUS field
        // between POST and BCC — that does NOT appear in the DP-25X reply.
        // Status info is embedded inside DATA, separated by 0x09 (TAB) and
        // 0x04 control bytes. We hand the whole DATA back to the provider
        // and let it parse whatever it needs.
        let cmd_width = self.cfg.cmd_width as usize;
        let min_len = 4 + 1 + cmd_width + 1 + 4; // LEN + SEQ + CMD + POST + BCC
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
        // Optional legacy 6-byte STATUS field between POST and BCC. Present
        // on FP-55 / FP-700 firmwares, absent on DP-25X. If there's room,
        // grab it; otherwise leave as zeros and let higher layers cope.
        let mut status = [0u8; 6];
        if raw.len() >= post_idx + 1 + 6 + 4 {
            status.copy_from_slice(&raw[post_idx + 1..post_idx + 7]);
        }
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

    /// Golden test against a real Datecs DUDE capture (2026-04-28) on a
    /// physical DP-25 register at 115200 baud. STATUS frame, SEQ 0x20.
    /// Wire bytes:
    ///   01 30 30 32 3a 20 30 30 34 3a 05 30 31 3b 3f 03
    ///
    /// LEN value = body(6) + 0x24 = 0x002A → encoded `30 30 32 3a`.
    /// BCC = SUM of LEN..POST = 0x01BF → encoded `30 31 3b 3f`.
    #[test]
    fn dp25x_status_frame_matches_dude_capture() {
        let cfg = DatecsTransportConfig::fp55("COM4", 115200);
        let mut t = DatecsFpTransport::new(cfg);
        t.seq = 0x1F; // next_seq → 0x20
        let frame = t.build_frame(0x4A, b"");
        assert_eq!(
            frame,
            vec![
                0x01, // STX
                0x30, 0x30, 0x32, 0x3A, // LEN value 0x002A = body(6)+0x24
                0x20, // SEQ
                0x30, 0x30, 0x34, 0x3A, // CMD = 0x004A
                0x05, // POST
                0x30, 0x31, 0x3B, 0x3F, // BCC = 0x01BF
                0x03, // ETX
            ],
            "DP-25X STATUS frame must match DUDE capture byte-for-byte"
        );
    }

    /// Golden test for open_fiscal (TX 450 in the capture):
    ///   01 30 30 33 35 24 30 30 33 30 31 09 30 30 30 31 09 31 09 09 09 05 30 33 30 34 03
    /// Payload `1\t0001\t1\t\t\t` (operator, password, till, three empty).
    /// LEN value = body(17) + 0x24 = 0x35.  BCC = 0x0304.
    #[test]
    fn dp25x_open_fiscal_frame_matches_dude_capture() {
        let cfg = DatecsTransportConfig::fp55("COM4", 115200);
        let mut t = DatecsFpTransport::new(cfg);
        t.seq = 0x23; // next_seq → 0x24 (matches capture SEQ at TX 450)
        let frame = t.build_frame(0x30, b"1\t0001\t1\t\t\t");
        assert_eq!(
            frame,
            vec![
                0x01, // STX
                0x30, 0x30, 0x33, 0x35, // LEN = 0x0035 = body(17)+0x24
                0x24, // SEQ
                0x30, 0x30, 0x33, 0x30, // CMD = 0x0030 (open_fiscal)
                // payload "1\t0001\t1\t\t\t"
                0x31, 0x09, 0x30, 0x30, 0x30, 0x31, 0x09, 0x31, 0x09, 0x09, 0x09,
                0x05, // POST
                0x30, 0x33, 0x30, 0x34, // BCC = 0x0304
                0x03, // ETX
            ],
            "DP-25X open_fiscal frame must match DUDE capture byte-for-byte"
        );
    }
}
