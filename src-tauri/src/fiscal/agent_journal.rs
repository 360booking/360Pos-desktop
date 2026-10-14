// Dedupe journal for the fiscal jobs the server sends to this station's
// agent (2026-10-14, „o singură cale”).
//
// The server sends every bon with a stable `mutation_id` (`order-<id>`,
// `storno-<id>`, `booking-<id>`). When the server times out waiting for the
// register it may send the same mutation again ("Reîncearcă"). This journal
// guarantees: one mutation_id ⇒ at most one bon on paper.
//
//   * never seen            → print, store the result;
//   * already `printed`     → return the stored result, do NOT print;
//   * last attempt `failed` → print again (nothing came out);
//   * `printing`/`unknown`  → an earlier attempt started and never finished
//     (app closed / power cut mid-print): the register MAY have printed —
//     refuse, the cashier checks the paper roll. Never auto-reprint.
//
// Own SQLite file next to the app's database (like `pos-offline.db`): no
// sqlx migration involved, nothing a "reset local data" would wipe.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub const FILE_NAME: &str = "fiscal-agent-journal.db";

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS agent_jobs (
          mutation_id TEXT PRIMARY KEY,
          kind        TEXT NOT NULL,
          status      TEXT NOT NULL,
          result_json TEXT,
          error       TEXT,
          attempts    INTEGER NOT NULL DEFAULT 1,
          created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        "#,
    )
}

pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = Connection::open(path).map_err(|e| format!("journal open {}: {e}", path.display()))?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
    migrate(&conn).map_err(|e| format!("journal migrate: {e}"))?;
    Ok(conn)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Begin {
    /// Print now (first time, or the last attempt failed cleanly).
    Proceed,
    /// Already printed: answer with this stored result, print nothing.
    AlreadyPrinted(Value),
    /// Started earlier, no result: the register may have printed.
    Unknown,
}

pub fn begin(conn: &Connection, mutation_id: &str, kind: &str) -> rusqlite::Result<Begin> {
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT status, result_json FROM agent_jobs WHERE mutation_id = ?1",
            params![mutation_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some((status, result)) if status == "printed" => {
            let v = result
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .unwrap_or(Value::Null);
            Ok(Begin::AlreadyPrinted(v))
        }
        Some((status, _)) if status == "printing" || status == "unknown" => {
            conn.execute(
                "UPDATE agent_jobs SET status = 'unknown', \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE mutation_id = ?1",
                params![mutation_id],
            )?;
            Ok(Begin::Unknown)
        }
        Some(_) => {
            conn.execute(
                "UPDATE agent_jobs SET status = 'printing', error = NULL, attempts = attempts + 1, \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE mutation_id = ?1",
                params![mutation_id],
            )?;
            Ok(Begin::Proceed)
        }
        None => {
            conn.execute(
                "INSERT INTO agent_jobs (mutation_id, kind, status) VALUES (?1, ?2, 'printing')",
                params![mutation_id, kind],
            )?;
            Ok(Begin::Proceed)
        }
    }
}

pub fn finish_ok(conn: &Connection, mutation_id: &str, result: &Value) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_jobs SET status = 'printed', result_json = ?2, error = NULL, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE mutation_id = ?1",
        params![mutation_id, result.to_string()],
    )?;
    Ok(())
}

pub fn finish_err(conn: &Connection, mutation_id: &str, error: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_jobs SET status = 'failed', error = ?2, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE mutation_id = ?1",
        params![mutation_id, error],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
    }

    #[test]
    fn first_time_proceeds_then_printed_is_returned_without_printing() {
        let c = mem();
        assert_eq!(begin(&c, "order-1", "print_receipt").unwrap(), Begin::Proceed);
        let res = serde_json::json!({"status": "printed", "fiscal_number": "0000123"});
        finish_ok(&c, "order-1", &res).unwrap();
        assert_eq!(begin(&c, "order-1", "print_receipt").unwrap(), Begin::AlreadyPrinted(res.clone()));
        // Still printed on a third retry.
        assert_eq!(begin(&c, "order-1", "print_receipt").unwrap(), Begin::AlreadyPrinted(res));
    }

    #[test]
    fn failed_attempt_can_be_retried() {
        let c = mem();
        assert_eq!(begin(&c, "order-2", "print_receipt").unwrap(), Begin::Proceed);
        finish_err(&c, "order-2", "communication error: port").unwrap();
        assert_eq!(begin(&c, "order-2", "print_receipt").unwrap(), Begin::Proceed);
        let attempts: i64 = c
            .query_row("SELECT attempts FROM agent_jobs WHERE mutation_id = 'order-2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(attempts, 2);
    }

    #[test]
    fn interrupted_attempt_is_never_reprinted() {
        let c = mem();
        assert_eq!(begin(&c, "order-3", "print_receipt").unwrap(), Begin::Proceed);
        // No finish_* — the app died while printing.
        assert_eq!(begin(&c, "order-3", "print_receipt").unwrap(), Begin::Unknown);
        assert_eq!(begin(&c, "order-3", "print_receipt").unwrap(), Begin::Unknown);
    }

    #[test]
    fn mutations_are_independent() {
        let c = mem();
        assert_eq!(begin(&c, "order-4", "print_receipt").unwrap(), Begin::Proceed);
        finish_ok(&c, "order-4", &serde_json::json!({"fiscal_number": "1"})).unwrap();
        assert_eq!(begin(&c, "storno-4", "cancel_receipt").unwrap(), Begin::Proceed);
    }
}
