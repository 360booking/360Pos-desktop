//! Raw TCP ESC/POS dispatcher for Epson TM-T20/T88 and ESC/POS-compatible
//! network printers (Star, Bixolon, …). Used by the desktop both for the
//! Settings → Imprimante "Test print" button and for the offline fallback
//! when the backend is unreachable but the printer still is.
//!
//! The frontend is responsible for building the ESC/POS byte payload —
//! this module only opens the socket, writes everything, and closes.

use serde::Serialize;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::time::timeout;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Serialize)]
pub struct EscposResult {
    pub ok: bool,
    pub bytes: usize,
    pub error: Option<String>,
}

/// Send a raw byte buffer to a network printer at host:port. Synchronous
/// from the JS caller's perspective — resolves only after the bytes are
/// flushed (or after a 5s timeout). Returns a structured result so the
/// Settings UI can show the exact failure ("Connection refused" vs
/// "Timeout" etc) instead of guessing.
#[tauri::command]
pub async fn escpos_send(host: String, port: u16, data: Vec<u8>) -> EscposResult {
    let bytes_len = data.len();
    let addr = format!("{host}:{port}");

    let connect_fut = TcpStream::connect(&addr);
    let stream = match timeout(CONNECT_TIMEOUT, connect_fut).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            return EscposResult {
                ok: false,
                bytes: 0,
                error: Some(format!("connect {addr}: {e}")),
            };
        }
        Err(_) => {
            return EscposResult {
                ok: false,
                bytes: 0,
                error: Some(format!("connect {addr}: timeout after 5s")),
            };
        }
    };

    let mut stream = stream;
    let write_fut = async {
        stream.write_all(&data).await?;
        stream.flush().await?;
        stream.shutdown().await?;
        Ok::<(), std::io::Error>(())
    };
    match timeout(WRITE_TIMEOUT, write_fut).await {
        Ok(Ok(())) => EscposResult {
            ok: true,
            bytes: bytes_len,
            error: None,
        },
        Ok(Err(e)) => EscposResult {
            ok: false,
            bytes: 0,
            error: Some(format!("write {addr}: {e}")),
        },
        Err(_) => EscposResult {
            ok: false,
            bytes: 0,
            error: Some(format!("write {addr}: timeout after 5s")),
        },
    }
}
