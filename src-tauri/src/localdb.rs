// Etapa 5 — single-writer SQLite access for the React UI (pos-desktop.db).
//
// Why this exists: the pilot kept hitting `database is locked (code: 5)`.
// Root cause was tauri-plugin-sql's sqlx *pool*: every `db.execute()` from JS
// may land on a different pooled connection, so the manual `BEGIN` of a
// hydrate batch ran on connection A, the INSERTs on B/C (autocommit) and the
// `COMMIT` on D ("no transaction is active"). Connection A was left holding
// an open write transaction until the pool recycled it — every other writer
// (auth refresh, outbox, the Rust fiscal persistence) then waited out its
// busy timeout and failed.
//
// The fix: ONE rusqlite connection, owned by Rust, behind a mutex.
//   * WAL journal + synchronous=NORMAL (readers never block the writer);
//   * busy_timeout 10s for the other handles that still exist (the fiscal
//     module opens short-lived rusqlite handles for its own tables);
//   * transactions are `BEGIN IMMEDIATE` on the same connection the
//     statements run on, so BEGIN/…/COMMIT can never be split again;
//   * a stale transaction (window reloaded mid-batch) is rolled back on the
//     next BEGIN or when the UI re-initialises (`db_reset_session`).
//
// tauri-plugin-sql is still used once at start-up purely to run the existing
// migrations (its `_sqlx_migrations` bookkeeping stays authoritative); JS then
// closes that pool and talks to these commands only.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags, Statement};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

pub const BUSY_TIMEOUT: Duration = Duration::from_millis(10_000);

pub struct LocalDb {
    inner: Mutex<Option<DbConn>>,
}

struct DbConn {
    conn: Connection,
    tx_started: Option<Instant>,
}

impl LocalDb {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl Default for LocalDb {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub rows_affected: u64,
    pub last_insert_id: i64,
}

/// WAL + NORMAL sync + busy timeout + FK. Shared with the offline journal.
pub fn configure(conn: &Connection) {
    let _ = conn.busy_timeout(BUSY_TIMEOUT);
    let mode: Result<String, _> = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0));
    if let Ok(m) = mode {
        if !m.eq_ignore_ascii_case("wal") {
            log::warn!("localdb: journal_mode is {m}, expected wal");
        }
    }
    let _ = conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
}

fn open_existing(path: &Path) -> Result<Connection, String> {
    // NO_CREATE on purpose: the file must be created by the migration
    // runner (tauri-plugin-sql). Creating it here first would leave sqlx
    // looking at a schema-less file it did not create.
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_URI;
    let conn = Connection::open_with_flags(path, flags)
        .map_err(|e| format!("sqlite open {}: {e}", path.display()))?;
    configure(&conn);
    Ok(conn)
}

fn with_conn<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut DbConn) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<LocalDb>();
    let mut guard = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        // Same file tauri-plugin-sql migrates (`sqlite:pos-desktop.db` is
        // resolved against app_config_dir; on Windows that is the same
        // Roaming folder `persist::db_path` uses).
        let path = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("app_config_dir: {e}"))?
            .join("pos-desktop.db");
        if !path.exists() {
            return Err("database not initialised yet (migrations pending)".into());
        }
        let conn = open_existing(&path)?;
        log::info!("localdb: opened {}", path.display());
        *guard = Some(DbConn {
            conn,
            tx_started: None,
        });
    }
    match guard.as_mut() {
        Some(c) => f(c),
        None => Err("database unavailable".into()),
    }
}

// ---------------------------------------------------------------------------
// Value conversion

pub fn json_to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                SqlValue::Null
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

pub fn value_ref_to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::Array(b.iter().map(|x| Value::from(*x)).collect()),
    }
}

/// Which JS argument feeds the SQL parameter called `name`.
/// Mirrors sqlx: `$N` / `?N` are explicit 1-based positions (the existing JS
/// code uses `$1, $2…`), anything else (`?`, `:name`) is taken in order.
fn param_slot(name: Option<&str>, seq: &mut usize) -> usize {
    if let Some(n) = name {
        if n.len() > 1 && (n.starts_with('$') || n.starts_with('?')) {
            let digits = &n[1..];
            if digits.chars().all(|c| c.is_ascii_digit()) {
                if let Ok(pos) = digits.parse::<usize>() {
                    return pos.saturating_sub(1);
                }
            }
        }
    }
    let i = *seq;
    *seq += 1;
    i
}

fn bind_all(stmt: &mut Statement<'_>, params: &[Value]) -> Result<(), String> {
    let count = stmt.parameter_count();
    let mut seq = 0usize;
    for idx in 1..=count {
        let name = stmt.parameter_name(idx).map(|s| s.to_string());
        let slot = param_slot(name.as_deref(), &mut seq);
        let v = params.get(slot).map(json_to_sql).unwrap_or(SqlValue::Null);
        stmt.raw_bind_parameter(idx, v)
            .map_err(|e| format!("bind #{idx}: {e}"))?;
    }
    Ok(())
}

pub fn run_select(
    conn: &Connection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Map<String, Value>>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    bind_all(&mut stmt, params)?;
    let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.raw_query();
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut m = Map::new();
        for (i, c) in cols.iter().enumerate() {
            let v = row.get_ref(i).map_err(|e| e.to_string())?;
            m.insert(c.clone(), value_ref_to_json(v));
        }
        out.push(m);
    }
    Ok(out)
}

fn is_multi_statement(sql: &str) -> bool {
    let t = sql.trim().trim_end_matches(';').trim();
    t.contains(';')
}

pub fn run_execute(conn: &Connection, sql: &str, params: &[Value]) -> Result<ExecResult, String> {
    if params.is_empty() && is_multi_statement(sql) {
        conn.execute_batch(sql).map_err(|e| e.to_string())?;
    } else {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        bind_all(&mut stmt, params)?;
        // Drain rows so PRAGMAs / RETURNING work through `execute` too.
        let mut rows = stmt.raw_query();
        while rows.next().map_err(|e| e.to_string())?.is_some() {}
    }
    Ok(ExecResult {
        rows_affected: conn.changes() as u64,
        last_insert_id: conn.last_insert_rowid(),
    })
}

fn rollback_if_open(c: &mut DbConn, why: &str) {
    if !c.conn.is_autocommit() {
        let age = c.tx_started.map(|t| t.elapsed().as_millis()).unwrap_or(0);
        log::warn!("localdb: rolling back stale transaction ({why}, open {age} ms)");
        let _ = c.conn.execute_batch("ROLLBACK");
    }
    c.tx_started = None;
}

// ---------------------------------------------------------------------------
// Commands. All async + spawn_blocking: sync Tauri commands run on the main
// (UI) thread, and an 11s hydrate batch must never freeze the window.

async fn blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(&app))
        .await
        .map_err(|e| format!("db task: {e}"))?
}

#[tauri::command]
pub async fn db_select(
    app: AppHandle,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<Vec<Map<String, Value>>, String> {
    blocking(app, move |app| {
        with_conn(app, |c| run_select(&c.conn, &sql, params.as_deref().unwrap_or(&[])))
    })
    .await
}

#[tauri::command]
pub async fn db_execute(
    app: AppHandle,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<ExecResult, String> {
    blocking(app, move |app| {
        with_conn(app, |c| run_execute(&c.conn, &sql, params.as_deref().unwrap_or(&[])))
    })
    .await
}

#[tauri::command]
pub async fn db_begin(app: AppHandle) -> Result<(), String> {
    blocking(app, |app| {
        with_conn(app, |c| {
            rollback_if_open(c, "BEGIN while a transaction was open");
            c.conn
                .execute_batch("BEGIN IMMEDIATE")
                .map_err(|e| e.to_string())?;
            c.tx_started = Some(Instant::now());
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn db_commit(app: AppHandle) -> Result<(), String> {
    blocking(app, |app| {
        with_conn(app, |c| {
            c.tx_started = None;
            if c.conn.is_autocommit() {
                return Ok(());
            }
            c.conn.execute_batch("COMMIT").map_err(|e| e.to_string())
        })
    })
    .await
}

#[tauri::command]
pub async fn db_rollback(app: AppHandle) -> Result<(), String> {
    blocking(app, |app| {
        with_conn(app, |c| {
            c.tx_started = None;
            if c.conn.is_autocommit() {
                return Ok(());
            }
            c.conn.execute_batch("ROLLBACK").map_err(|e| e.to_string())
        })
    })
    .await
}

/// Called by the UI at start-up (and after a reload): a transaction left
/// open by the previous page instance is rolled back so nothing written
/// later gets swallowed by it.
#[tauri::command]
pub async fn db_reset_session(app: AppHandle) -> Result<(), String> {
    blocking(app, |app| {
        with_conn(app, |c| {
            rollback_if_open(c, "UI session reset");
            Ok(())
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b REAL, c INTEGER);")
            .unwrap();
        c
    }

    #[test]
    fn dollar_params_bind_by_position_even_out_of_order() {
        let c = mem();
        run_execute(
            &c,
            "INSERT INTO t (a, b, c) VALUES ($2, $3, $1)",
            &[json!(7), json!("x"), json!(1.5)],
        )
        .unwrap();
        let rows = run_select(&c, "SELECT a, b, c FROM t WHERE a = $1", &[json!("x")]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["a"], json!("x"));
        assert_eq!(rows[0]["b"], json!(1.5));
        assert_eq!(rows[0]["c"], json!(7));
    }

    #[test]
    fn question_marks_bind_in_order_and_bools_become_ints() {
        let c = mem();
        let r = run_execute(&c, "INSERT INTO t (a, c) VALUES (?, ?)", &[json!("y"), json!(true)])
            .unwrap();
        assert_eq!(r.rows_affected, 1);
        assert_eq!(r.last_insert_id, 1);
        let rows = run_select(&c, "SELECT c FROM t", &[]).unwrap();
        assert_eq!(rows[0]["c"], json!(1));
    }

    #[test]
    fn pragma_and_multi_statement_through_execute() {
        let c = mem();
        run_execute(&c, "PRAGMA user_version = 3;", &[]).unwrap();
        run_execute(&c, "INSERT INTO t (a) VALUES ('1'); INSERT INTO t (a) VALUES ('2');", &[])
            .unwrap();
        let rows = run_select(&c, "SELECT COUNT(*) AS n FROM t", &[]).unwrap();
        assert_eq!(rows[0]["n"], json!(2));
    }

    #[test]
    fn transaction_on_single_connection_rolls_back() {
        let c = mem();
        c.execute_batch("BEGIN IMMEDIATE").unwrap();
        run_execute(&c, "INSERT INTO t (a) VALUES ('z')", &[]).unwrap();
        c.execute_batch("ROLLBACK").unwrap();
        let rows = run_select(&c, "SELECT COUNT(*) AS n FROM t", &[]).unwrap();
        assert_eq!(rows[0]["n"], json!(0));
    }
}
