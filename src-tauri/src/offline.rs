// Etapa 5 — offline till: cached open orders + local fiscal journal.
//
// Lives in its own SQLite file (`pos-offline.db`) so it never competes with
// the legacy UI's database or its sqlx migration bookkeeping, and so a
// "reset local data" of the legacy UI can never wipe un-synced fiscal
// receipts. One rusqlite connection behind a mutex (single writer), WAL,
// busy timeout — same recipe as `localdb`.
//
// Flow:
//   1. While online, the web POS pushes a snapshot of its open orders
//      (`cache_orders`). Server data only — the till never edits items.
//   2. Internet down → the cashier opens the offline till (local page),
//      picks a cached order, chooses cash/card and closes it. We write a
//      journal row FIRST (status `printing`, durable), then print the fiscal
//      receipt on the local device, then store the BF number.
//   3. Back online → the web POS drains `pending_sync()`: it POSTs each
//      payment with `Idempotency-Key = mutation_id`,
//      `fiscalizationSource = 'device_offline'` and `fiscalReceiptNumber`,
//      then reports the outcome through `mark_synced`.
//
// Invariants:
//   * one mutation_id ⇒ at most one printed receipt (a retry returns the
//     stored result instead of printing again);
//   * an order closed offline cannot be closed a second time offline;
//   * a crash between "printing" and "printed" leaves the row `unknown`
//     and flagged for review — we NEVER auto-reprint in that case, the
//     cashier checks the paper roll / device journal first.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::fiscal::dto::{
    PaymentMethod, ReceiptItem, ReceiptPayment, ReceiptRequest, ReceiptResponse, ReceiptStatus,
};

const SCHEMA_VERSION: i64 = 1;
const MAX_CACHED_ORDERS: usize = 500;

pub struct OfflineStore {
    conn: Mutex<Option<Connection>>,
}

impl OfflineStore {
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }
}

impl Default for OfflineStore {
    fn default() -> Self {
        Self::new()
    }
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v < 1 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS cached_orders (
              order_id          TEXT PRIMARY KEY,
              restaurant_id     TEXT,
              table_label       TEXT,
              waiter_name       TEXT,
              status            TEXT,
              payment_status    TEXT,
              currency          TEXT NOT NULL DEFAULT 'RON',
              subtotal          REAL NOT NULL DEFAULT 0,
              discount_total    REAL NOT NULL DEFAULT 0,
              tip_total         REAL NOT NULL DEFAULT 0,
              total             REAL NOT NULL DEFAULT 0,
              paid_total        REAL NOT NULL DEFAULT 0,
              items_signature   TEXT,
              server_updated_at TEXT,
              items_json        TEXT NOT NULL,
              cached_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE TABLE IF NOT EXISTS offline_journal (
              id                      TEXT PRIMARY KEY,
              mutation_id             TEXT NOT NULL UNIQUE,
              order_id                TEXT NOT NULL,
              table_label             TEXT,
              method                  TEXT NOT NULL,
              amount                  REAL NOT NULL,
              currency                TEXT NOT NULL,
              order_total             REAL NOT NULL,
              items_signature         TEXT,
              order_server_updated_at TEXT,
              items_json              TEXT NOT NULL,
              customer_cif            TEXT,
              provider                TEXT,
              fiscal_status           TEXT NOT NULL,
              fiscal_number           TEXT,
              fiscal_date             TEXT,
              fiscal_error            TEXT,
              sync_status             TEXT NOT NULL,
              sync_attempts           INTEGER NOT NULL DEFAULT 0,
              last_sync_error         TEXT,
              needs_review            INTEGER NOT NULL DEFAULT 0,
              review_reason           TEXT,
              reviewed_at             TEXT,
              server_response_json    TEXT,
              created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              synced_at               TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_offline_journal_sync  ON offline_journal(sync_status);
            CREATE INDEX IF NOT EXISTS ix_offline_journal_order ON offline_journal(order_id);
            "#,
        )?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    Ok(())
}

fn open(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = Connection::open(path).map_err(|e| format!("sqlite open {}: {e}", path.display()))?;
    crate::localdb::configure(&conn);
    migrate(&conn).map_err(|e| format!("offline migrate: {e}"))?;
    Ok(conn)
}

pub fn with_store<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let store = app.state::<OfflineStore>();
    let mut guard = store.conn.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))?;
        *guard = Some(open(&dir.join("pos-offline.db"))?);
    }
    match guard.as_mut() {
        Some(c) => f(c),
        None => Err("offline store unavailable".into()),
    }
}

// ---------------------------------------------------------------------------
// DTOs (camelCase on the wire — the web POS and the local page are JS)

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedItem {
    pub name: String,
    pub quantity: f64,
    pub unit_price: f64,
    pub line_total: f64,
    #[serde(default)]
    pub vat_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedOrder {
    pub id: String,
    #[serde(default)]
    pub table_label: Option<String>,
    #[serde(default)]
    pub waiter_name: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub payment_status: Option<String>,
    #[serde(default = "default_currency")]
    pub currency: String,
    pub subtotal: f64,
    #[serde(default)]
    pub discount_total: f64,
    #[serde(default)]
    pub tip_total: f64,
    pub total: f64,
    #[serde(default)]
    pub paid_total: f64,
    #[serde(default)]
    pub items_signature: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    pub items: Vec<CachedItem>,
    /// Filled on read: when the snapshot was taken.
    #[serde(default)]
    pub cached_at: Option<String>,
    /// Filled on read: why this order cannot be closed offline (None = ok).
    #[serde(default)]
    pub offline_block_reason: Option<String>,
}

fn default_currency() -> String {
    "RON".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachePayload {
    #[serde(default)]
    pub restaurant_id: Option<String>,
    pub orders: Vec<CachedOrder>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseRequest {
    pub order_id: String,
    /// Generated by the till page once per close attempt and reused on
    /// retries — becomes the Idempotency-Key on sync.
    pub mutation_id: String,
    /// "cash" | "card"
    pub method: String,
    #[serde(default)]
    pub customer_cif: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: String,
    pub mutation_id: String,
    pub order_id: String,
    pub table_label: Option<String>,
    pub method: String,
    pub amount: f64,
    pub currency: String,
    pub order_total: f64,
    pub items_signature: Option<String>,
    pub order_server_updated_at: Option<String>,
    pub items: Value,
    pub customer_cif: Option<String>,
    pub provider: Option<String>,
    pub fiscal_status: String,
    pub fiscal_number: Option<String>,
    pub fiscal_date: Option<String>,
    pub fiscal_error: Option<String>,
    pub sync_status: String,
    pub sync_attempts: i64,
    pub last_sync_error: Option<String>,
    pub needs_review: bool,
    pub review_reason: Option<String>,
    pub reviewed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub synced_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    /// "synced" | "conflict" | "retry"
    pub outcome: String,
    #[serde(default)]
    pub needs_review: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub server_response: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JournalCounts {
    pub pending_sync: i64,
    pub needs_review: i64,
    pub unknown_prints: i64,
    pub cached_orders: i64,
    pub last_cached_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Cache

pub fn cache_orders(conn: &mut Connection, payload: &CachePayload) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM cached_orders", [])
        .map_err(|e| e.to_string())?;
    let mut n = 0usize;
    for o in payload.orders.iter().take(MAX_CACHED_ORDERS) {
        if o.id.trim().is_empty() {
            continue;
        }
        let items_json = serde_json::to_string(&o.items).map_err(|e| e.to_string())?;
        tx.execute(
            r#"INSERT OR REPLACE INTO cached_orders (
                 order_id, restaurant_id, table_label, waiter_name, status, payment_status,
                 currency, subtotal, discount_total, tip_total, total, paid_total,
                 items_signature, server_updated_at, items_json
               ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"#,
            params![
                o.id,
                payload.restaurant_id,
                o.table_label,
                o.waiter_name,
                o.status,
                o.payment_status,
                o.currency,
                o.subtotal,
                o.discount_total,
                o.tip_total,
                o.total,
                o.paid_total,
                o.items_signature,
                o.updated_at,
                items_json,
            ],
        )
        .map_err(|e| e.to_string())?;
        n += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

fn row_to_cached(r: &Row<'_>) -> rusqlite::Result<CachedOrder> {
    let items_json: String = r.get("items_json")?;
    let items: Vec<CachedItem> = serde_json::from_str(&items_json).unwrap_or_default();
    Ok(CachedOrder {
        id: r.get("order_id")?,
        table_label: r.get("table_label")?,
        waiter_name: r.get("waiter_name")?,
        status: r.get("status")?,
        payment_status: r.get("payment_status")?,
        currency: r.get("currency")?,
        subtotal: r.get("subtotal")?,
        discount_total: r.get("discount_total")?,
        tip_total: r.get("tip_total")?,
        total: r.get("total")?,
        paid_total: r.get("paid_total")?,
        items_signature: r.get("items_signature")?,
        updated_at: r.get("server_updated_at")?,
        items,
        cached_at: r.get("cached_at")?,
        offline_block_reason: None,
    })
}

const ACTIVE_FISCAL: &str = "('printing','printed','unknown')";

/// Open orders from the last snapshot, minus those already closed offline.
pub fn list_cached(conn: &Connection) -> Result<Vec<CachedOrder>, String> {
    let sql = format!(
        "SELECT c.* FROM cached_orders c
          WHERE NOT EXISTS (SELECT 1 FROM offline_journal j
                             WHERE j.order_id = c.order_id AND j.fiscal_status IN {ACTIVE_FISCAL})
          ORDER BY c.table_label COLLATE NOCASE, c.cached_at"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_cached)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        let mut o = r.map_err(|e| e.to_string())?;
        o.offline_block_reason = block_reason(&o);
        out.push(o);
    }
    Ok(out)
}

fn approx_eq(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.0101
}

/// The offline till only closes plain notes: everything the fiscal receipt
/// needs must come straight from the server snapshot.
pub fn block_reason(o: &CachedOrder) -> Option<String> {
    if o.items.is_empty() {
        return Some("Nota nu are produse.".into());
    }
    if matches!(o.status.as_deref(), Some("cancelled")) {
        return Some("Nota este anulată.".into());
    }
    if matches!(o.payment_status.as_deref(), Some("paid")) {
        return Some("Nota este deja plătită.".into());
    }
    if o.paid_total > 0.0049 {
        return Some("Nota are deja o plată parțială — închide-o online.".into());
    }
    if o.discount_total.abs() > 0.0049 || o.tip_total.abs() > 0.0049 {
        return Some("Nota are reducere sau bacșiș — se închide doar online.".into());
    }
    let lines: f64 = o.items.iter().map(|i| i.line_total).sum();
    if !approx_eq(lines, o.subtotal) || !approx_eq(o.subtotal, o.total) {
        return Some("Totalul notei din cache nu se potrivește — închide-o online.".into());
    }
    if o.total <= 0.0 {
        return Some("Total zero.".into());
    }
    None
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// Server line → fiscal line. The price on the receipt must multiply back
/// to the server's line total; when it does not divide evenly (modifiers,
/// odd quantities) the line is registered as "N x Name" at quantity 1.
pub fn receipt_items(o: &CachedOrder, default_vat: f64) -> Vec<ReceiptItem> {
    o.items
        .iter()
        .filter(|i| i.quantity > 0.0 && i.line_total.abs() > 0.0)
        .map(|i| {
            let vat = i.vat_rate.unwrap_or(default_vat);
            let unit = round2(i.line_total / i.quantity);
            if (round2(unit * i.quantity) - round2(i.line_total)).abs() < 0.0001 {
                ReceiptItem {
                    name: i.name.clone(),
                    quantity: i.quantity,
                    unit_price: unit,
                    vat_rate: vat,
                }
            } else {
                let q = if (i.quantity - i.quantity.round()).abs() < 1e-9 {
                    format!("{}", i.quantity as i64)
                } else {
                    format!("{:.3}", i.quantity)
                };
                ReceiptItem {
                    name: format!("{q} x {}", i.name),
                    quantity: 1.0,
                    unit_price: round2(i.line_total),
                    vat_rate: vat,
                }
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Journal

fn row_to_entry(r: &Row<'_>) -> rusqlite::Result<JournalEntry> {
    let items_json: String = r.get("items_json")?;
    Ok(JournalEntry {
        id: r.get("id")?,
        mutation_id: r.get("mutation_id")?,
        order_id: r.get("order_id")?,
        table_label: r.get("table_label")?,
        method: r.get("method")?,
        amount: r.get("amount")?,
        currency: r.get("currency")?,
        order_total: r.get("order_total")?,
        items_signature: r.get("items_signature")?,
        order_server_updated_at: r.get("order_server_updated_at")?,
        items: serde_json::from_str(&items_json).unwrap_or(Value::Null),
        customer_cif: r.get("customer_cif")?,
        provider: r.get("provider")?,
        fiscal_status: r.get("fiscal_status")?,
        fiscal_number: r.get("fiscal_number")?,
        fiscal_date: r.get("fiscal_date")?,
        fiscal_error: r.get("fiscal_error")?,
        sync_status: r.get("sync_status")?,
        sync_attempts: r.get("sync_attempts")?,
        last_sync_error: r.get("last_sync_error")?,
        needs_review: r.get::<_, i64>("needs_review")? != 0,
        review_reason: r.get("review_reason")?,
        reviewed_at: r.get("reviewed_at")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        synced_at: r.get("synced_at")?,
    })
}

pub fn get_by_mutation(conn: &Connection, mutation_id: &str) -> Result<Option<JournalEntry>, String> {
    conn.query_row(
        "SELECT * FROM offline_journal WHERE mutation_id = ?1",
        params![mutation_id],
        row_to_entry,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn get_by_id(conn: &Connection, id: &str) -> Result<Option<JournalEntry>, String> {
    conn.query_row(
        "SELECT * FROM offline_journal WHERE id = ?1",
        params![id],
        row_to_entry,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn list_journal(conn: &Connection, limit: i64) -> Result<Vec<JournalEntry>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM offline_journal ORDER BY created_at DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit.clamp(1, 1000)], row_to_entry)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn pending_sync(conn: &Connection) -> Result<Vec<JournalEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT * FROM offline_journal
              WHERE fiscal_status = 'printed' AND sync_status = 'pending'
              ORDER BY created_at ASC LIMIT 200",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_entry).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn counts(conn: &Connection) -> Result<JournalCounts, String> {
    let q = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())
    };
    Ok(JournalCounts {
        pending_sync: q("SELECT COUNT(*) FROM offline_journal WHERE fiscal_status='printed' AND sync_status='pending'")?,
        needs_review: q("SELECT COUNT(*) FROM offline_journal WHERE needs_review=1 AND reviewed_at IS NULL")?,
        unknown_prints: q("SELECT COUNT(*) FROM offline_journal WHERE fiscal_status IN ('printing','unknown')")?,
        cached_orders: q("SELECT COUNT(*) FROM cached_orders")?,
        last_cached_at: conn
            .query_row("SELECT MAX(cached_at) FROM cached_orders", [], |r| r.get(0))
            .map_err(|e| e.to_string())?,
    })
}

pub enum Prepared {
    /// Nothing to print — this mutation already has a final answer.
    Existing(JournalEntry),
    /// A `printing` row was written; print, then call `finish_print`.
    Print {
        entry_id: String,
        request: ReceiptRequest,
    },
}

/// Step 1 of a close: validation + durable `printing` row.
pub fn prepare_close(
    conn: &mut Connection,
    req: &CloseRequest,
    default_vat: f64,
    provider: &str,
) -> Result<Prepared, String> {
    if req.mutation_id.trim().len() < 8 {
        return Err("mutation_id lipsă".into());
    }
    let method = match req.method.as_str() {
        "cash" => PaymentMethod::Cash,
        "card" => PaymentMethod::Card,
        other => return Err(format!("Metodă de plată nesuportată offline: {other}")),
    };
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    if let Some(existing) = get_by_mutation(&tx, &req.mutation_id)? {
        if existing.fiscal_status != "failed" {
            // printed → same answer again; printing/unknown → the cashier
            // must check the device before anything else happens.
            return Ok(Prepared::Existing(existing));
        }
    }

    let other_close: Option<String> = tx
        .query_row(
            &format!(
                "SELECT COALESCE(fiscal_number, fiscal_status) FROM offline_journal
                  WHERE order_id = ?1 AND mutation_id <> ?2 AND fiscal_status IN {ACTIVE_FISCAL}
                  LIMIT 1"
            ),
            params![req.order_id, req.mutation_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(bf) = other_close {
        return Err(format!("Nota a fost deja închisă offline (bon {bf})."));
    }

    let order = tx
        .query_row(
            "SELECT * FROM cached_orders WHERE order_id = ?1",
            params![req.order_id],
            row_to_cached,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Nota nu este în cache-ul stației.".to_string())?;
    if let Some(reason) = block_reason(&order) {
        return Err(reason);
    }
    let items = receipt_items(&order, default_vat);
    if items.is_empty() {
        return Err("Nota nu are produse de pus pe bon.".into());
    }
    let amount = round2(order.total);
    let entry_id = new_id();
    let items_json = serde_json::to_string(&order.items).map_err(|e| e.to_string())?;

    // Insert (or revive a failed attempt with the same mutation id).
    tx.execute(
        r#"INSERT INTO offline_journal (
             id, mutation_id, order_id, table_label, method, amount, currency,
             order_total, items_signature, order_server_updated_at, items_json,
             customer_cif, provider, fiscal_status, sync_status
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'printing', 'not_ready')
           ON CONFLICT(mutation_id) DO UPDATE SET
             fiscal_status = 'printing', fiscal_error = NULL, method = excluded.method,
             provider = excluded.provider, customer_cif = excluded.customer_cif,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
        params![
            entry_id,
            req.mutation_id,
            order.id,
            order.table_label,
            req.method,
            amount,
            order.currency,
            order.total,
            order.items_signature,
            order.updated_at,
            items_json,
            req.customer_cif,
            provider,
        ],
    )
    .map_err(|e| e.to_string())?;
    let stored = get_by_mutation(&tx, &req.mutation_id)?
        .ok_or_else(|| "journal row vanished".to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    let request = ReceiptRequest {
        mutation_id: req.mutation_id.clone(),
        order_local_id: order.id.clone(),
        fiscal_attempt_id: stored.id.clone(),
        items,
        payments: vec![ReceiptPayment { method, amount }],
        currency: order.currency.clone(),
        customer_cif: req.customer_cif.clone().filter(|s| !s.trim().is_empty()),
        customer_name: None,
        footer_note: None,
    };
    Ok(Prepared::Print {
        entry_id: stored.id,
        request,
    })
}

/// Step 2 of a close: store what the device answered.
pub fn finish_print(
    conn: &Connection,
    entry_id: &str,
    outcome: Result<ReceiptResponse, String>,
) -> Result<JournalEntry, String> {
    match outcome {
        Ok(res) => {
            let (fiscal_status, sync_status, review): (&str, &str, Option<String>) = match res.status {
                ReceiptStatus::Printed if res.fiscal_number.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false) => {
                    ("printed", "pending", None)
                }
                ReceiptStatus::Printed => (
                    "unknown",
                    "not_ready",
                    Some("Casa a raportat bon tipărit, dar fără număr BF — verifică pe rolă.".into()),
                ),
                ReceiptStatus::Failed => ("failed", "not_ready", None),
                ReceiptStatus::Unknown => (
                    "unknown",
                    "not_ready",
                    Some("Răspuns neclar de la casă — verifică pe rolă dacă bonul a ieșit.".into()),
                ),
            };
            conn.execute(
                r#"UPDATE offline_journal SET
                     fiscal_status = ?2, fiscal_number = ?3, fiscal_date = ?4,
                     fiscal_error = ?5, sync_status = ?6,
                     needs_review = CASE WHEN ?7 IS NULL THEN needs_review ELSE 1 END,
                     review_reason = COALESCE(?7, review_reason),
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                   WHERE id = ?1"#,
                params![
                    entry_id,
                    fiscal_status,
                    res.fiscal_number.as_deref().map(str::trim),
                    res.fiscal_date,
                    res.error_message.or(res.error_code),
                    sync_status,
                    review,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        Err(err) => {
            conn.execute(
                r#"UPDATE offline_journal SET fiscal_status = 'failed', fiscal_error = ?2,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                   WHERE id = ?1"#,
                params![entry_id, err],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    get_by_id(conn, entry_id)?.ok_or_else(|| "journal row vanished".into())
}

/// A row left in `printing` (app crashed / killed mid-print) is turned into
/// `unknown` + review at start-up. Never reprinted automatically.
pub fn recover_interrupted(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        r#"UPDATE offline_journal SET fiscal_status = 'unknown', needs_review = 1,
             review_reason = 'Aplicația s-a oprit în timpul tipăririi — verifică pe rolă dacă bonul a ieșit.',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE fiscal_status = 'printing'"#,
        [],
    )
    .map_err(|e| e.to_string())
}

pub fn mark_synced(conn: &Connection, id: &str, result: &SyncResult) -> Result<JournalEntry, String> {
    let resp = result
        .server_response
        .as_ref()
        .map(|v| v.to_string())
        .map(|s| s.chars().take(20_000).collect::<String>());
    let n = match result.outcome.as_str() {
        "synced" => conn.execute(
            r#"UPDATE offline_journal SET sync_status = 'synced', sync_attempts = sync_attempts + 1,
                 last_sync_error = NULL,
                 needs_review = CASE WHEN ?2 THEN 1 ELSE needs_review END,
                 review_reason = CASE WHEN ?2 THEN COALESCE(?3, review_reason) ELSE review_reason END,
                 server_response_json = COALESCE(?4, server_response_json),
                 synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = ?1 AND sync_status <> 'synced'"#,
            params![id, result.needs_review, result.reason, resp],
        ),
        "conflict" => conn.execute(
            r#"UPDATE offline_journal SET sync_status = 'conflict', sync_attempts = sync_attempts + 1,
                 last_sync_error = ?2, needs_review = 1,
                 review_reason = COALESCE(?2, 'Conflict la sincronizare'),
                 server_response_json = COALESCE(?3, server_response_json),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = ?1 AND sync_status <> 'synced'"#,
            params![id, result.reason, resp],
        ),
        "retry" => conn.execute(
            r#"UPDATE offline_journal SET sync_attempts = sync_attempts + 1, last_sync_error = ?2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = ?1 AND sync_status = 'pending'"#,
            params![id, result.reason],
        ),
        other => return Err(format!("outcome necunoscut: {other}")),
    }
    .map_err(|e| e.to_string())?;
    if n == 0 {
        log::info!("offline: mark_synced({id}, {}) changed nothing", result.outcome);
    }
    get_by_id(conn, id)?.ok_or_else(|| "Înregistrarea nu există.".into())
}

pub fn mark_reviewed(conn: &Connection, id: &str) -> Result<JournalEntry, String> {
    conn.execute(
        "UPDATE offline_journal SET reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    get_by_id(conn, id)?.ok_or_else(|| "Înregistrarea nu există.".into())
}

/// The cashier checked the paper roll for a receipt whose outcome was
/// unclear (`unknown`): either it printed (with this BF number → it syncs
/// like any other) or it did not (→ `failed`, the order can be closed
/// again).
pub fn resolve_unknown(
    conn: &Connection,
    id: &str,
    printed: bool,
    fiscal_number: Option<&str>,
) -> Result<JournalEntry, String> {
    let entry = get_by_id(conn, id)?.ok_or_else(|| "Înregistrarea nu există.".to_string())?;
    if entry.fiscal_status != "unknown" {
        return Err("Doar bonurile cu rezultat neclar se pot lămuri manual.".into());
    }
    if printed {
        let bf = fiscal_number.map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| {
            "Scrie numărul bonului (BF) de pe rolă.".to_string()
        })?;
        conn.execute(
            r#"UPDATE offline_journal SET fiscal_status = 'printed', fiscal_number = ?2,
                 sync_status = 'pending', reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                 review_reason = 'Confirmat manual de pe rolă',
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = ?1"#,
            params![id, bf],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            r#"UPDATE offline_journal SET fiscal_status = 'failed',
                 fiscal_error = 'Confirmat manual: bonul nu a ieșit',
                 reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = ?1"#,
            params![id],
        )
        .map_err(|e| e.to_string())?;
    }
    get_by_id(conn, id)?.ok_or_else(|| "Înregistrarea nu există.".into())
}

/// A conflicted row the operator fixed on the server can be pushed again.
pub fn requeue(conn: &Connection, id: &str) -> Result<JournalEntry, String> {
    conn.execute(
        "UPDATE offline_journal SET sync_status = 'pending', last_sync_error = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1 AND fiscal_status = 'printed' AND sync_status = 'conflict'",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    get_by_id(conn, id)?.ok_or_else(|| "Înregistrarea nu există.".into())
}

pub fn new_id() -> String {
    // 128 random bits from the OS-seeded std hasher, formatted like a UUIDv4.
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut a = RandomState::new().build_hasher();
    a.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    let hi = a.finish();
    let mut b = RandomState::new().build_hasher();
    b.write_u64(hi ^ 0x9e37_79b9_7f4a_7c15);
    let lo = b.finish();
    let bytes: u128 = ((hi as u128) << 64) | lo as u128;
    let mut s = format!("{bytes:032x}");
    // version 4 + variant bits for readability; uniqueness comes from the hashes.
    s.replace_range(12..13, "4");
    let v = u8::from_str_radix(&s[16..17], 16).unwrap_or(8);
    s.replace_range(16..17, &format!("{:x}", (v & 0x3) | 0x8));
    format!("{}-{}-{}-{}-{}", &s[0..8], &s[8..12], &s[12..16], &s[16..20], &s[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
    }

    fn order(id: &str) -> CachedOrder {
        CachedOrder {
            id: id.into(),
            table_label: Some("Masa 4".into()),
            waiter_name: None,
            status: Some("sent".into()),
            payment_status: Some("unpaid".into()),
            currency: "RON".into(),
            subtotal: 61.0,
            discount_total: 0.0,
            tip_total: 0.0,
            total: 61.0,
            paid_total: 0.0,
            items_signature: Some("sig".into()),
            updated_at: Some("2026-10-11T10:00:00Z".into()),
            items: vec![
                CachedItem { name: "Ciorbă".into(), quantity: 2.0, unit_price: 18.0, line_total: 36.0, vat_rate: Some(0.11) },
                CachedItem { name: "Bere".into(), quantity: 1.0, unit_price: 25.0, line_total: 25.0, vat_rate: None },
            ],
            cached_at: None,
            offline_block_reason: None,
        }
    }

    fn close_req(order_id: &str, mutation: &str) -> CloseRequest {
        CloseRequest {
            order_id: order_id.into(),
            mutation_id: mutation.into(),
            method: "cash".into(),
            customer_cif: None,
        }
    }

    fn printed(bf: &str) -> Result<ReceiptResponse, String> {
        Ok(ReceiptResponse {
            status: ReceiptStatus::Printed,
            fiscal_number: Some(bf.into()),
            fiscal_date: Some("2026-10-11T10:05:00Z".into()),
            raw_trace: String::new(),
            error_code: None,
            error_message: None,
        })
    }

    #[test]
    fn close_prints_once_and_retry_returns_same_receipt() {
        let mut c = store();
        cache_orders(&mut c, &CachePayload { restaurant_id: None, orders: vec![order("o1")] }).unwrap();
        let p = prepare_close(&mut c, &close_req("o1", "mut-00000001"), 0.21, "simulator").unwrap();
        let (entry_id, request) = match p {
            Prepared::Print { entry_id, request, .. } => (entry_id, request),
            _ => panic!("expected print"),
        };
        assert_eq!(request.items.len(), 2);
        assert_eq!(request.items[1].vat_rate, 0.21); // default applied
        assert_eq!(request.payments[0].amount, 61.0);
        let e = finish_print(&c, &entry_id, printed("0042")).unwrap();
        assert_eq!(e.fiscal_status, "printed");
        assert_eq!(e.sync_status, "pending");

        // Same mutation again → no new print.
        match prepare_close(&mut c, &close_req("o1", "mut-00000001"), 0.21, "simulator").unwrap() {
            Prepared::Existing(x) => assert_eq!(x.fiscal_number.as_deref(), Some("0042")),
            _ => panic!("must not print twice"),
        }
        // Different mutation on the same order → refused.
        let err = prepare_close(&mut c, &close_req("o1", "mut-00000002"), 0.21, "simulator")
            .err()
            .unwrap();
        assert!(err.contains("deja închisă"));
        // Closed order disappears from the till list.
        assert!(list_cached(&c).unwrap().is_empty());
        assert_eq!(pending_sync(&c).unwrap().len(), 1);
    }

    #[test]
    fn failed_print_can_be_retried_with_same_mutation() {
        let mut c = store();
        cache_orders(&mut c, &CachePayload { restaurant_id: None, orders: vec![order("o2")] }).unwrap();
        let id = match prepare_close(&mut c, &close_req("o2", "mut-00000003"), 0.21, "x").unwrap() {
            Prepared::Print { entry_id, .. } => entry_id,
            _ => panic!(),
        };
        let e = finish_print(&c, &id, Err("hârtie lipsă".into())).unwrap();
        assert_eq!(e.fiscal_status, "failed");
        assert!(matches!(
            prepare_close(&mut c, &close_req("o2", "mut-00000003"), 0.21, "x").unwrap(),
            Prepared::Print { .. }
        ));
    }

    #[test]
    fn interrupted_print_becomes_unknown_and_is_never_reprinted() {
        let mut c = store();
        cache_orders(&mut c, &CachePayload { restaurant_id: None, orders: vec![order("o3")] }).unwrap();
        let _ = prepare_close(&mut c, &close_req("o3", "mut-00000004"), 0.21, "x").unwrap();
        assert_eq!(recover_interrupted(&c).unwrap(), 1);
        match prepare_close(&mut c, &close_req("o3", "mut-00000004"), 0.21, "x").unwrap() {
            Prepared::Existing(x) => {
                assert_eq!(x.fiscal_status, "unknown");
                assert!(x.needs_review);
            }
            _ => panic!("unknown must not reprint"),
        }
        assert_eq!(counts(&c).unwrap().unknown_prints, 1);
    }

    #[test]
    fn unknown_can_be_resolved_either_way() {
        let mut c = store();
        cache_orders(&mut c, &CachePayload { restaurant_id: None, orders: vec![order("p1")] }).unwrap();
        let _ = prepare_close(&mut c, &close_req("p1", "mut-0000000a"), 0.21, "x").unwrap();
        recover_interrupted(&c).unwrap();
        let e = get_by_mutation(&c, "mut-0000000a").unwrap().unwrap();
        assert!(resolve_unknown(&c, &e.id, true, None).is_err());
        let r = resolve_unknown(&c, &e.id, true, Some(" 0099 ")).unwrap();
        assert_eq!(r.fiscal_status, "printed");
        assert_eq!(r.fiscal_number.as_deref(), Some("0099"));
        assert_eq!(r.sync_status, "pending");

        cache_orders(&mut c, &CachePayload { restaurant_id: None, orders: vec![order("p2")] }).unwrap();
        let _ = prepare_close(&mut c, &close_req("p2", "mut-0000000b"), 0.21, "x").unwrap();
        recover_interrupted(&c).unwrap();
        let e = get_by_mutation(&c, "mut-0000000b").unwrap().unwrap();
        let r = resolve_unknown(&c, &e.id, false, None).unwrap();
        assert_eq!(r.fiscal_status, "failed");
        // The order is closable again with a fresh attempt.
        assert!(matches!(
            prepare_close(&mut c, &close_req("p2", "mut-0000000c"), 0.21, "x").unwrap(),
            Prepared::Print { .. }
        ));
    }

    #[test]
    fn discounted_or_inconsistent_orders_are_blocked() {
        let mut o = order("o4");
        o.discount_total = 5.0;
        o.total = 56.0;
        assert!(block_reason(&o).is_some());
        let mut o = order("o5");
        o.subtotal = 70.0;
        o.total = 70.0;
        assert!(block_reason(&o).is_some());
        assert!(block_reason(&order("o6")).is_none());
    }

    #[test]
    fn uneven_unit_price_becomes_single_line() {
        let mut o = order("o7");
        o.items = vec![CachedItem { name: "Pizza".into(), quantity: 3.0, unit_price: 10.0, line_total: 31.0, vat_rate: Some(0.11) }];
        let items = receipt_items(&o, 0.21);
        assert_eq!(items[0].quantity, 1.0);
        assert_eq!(items[0].unit_price, 31.0);
        assert!(items[0].name.starts_with("3 x "));
    }

    #[test]
    fn sync_outcomes() {
        let mut c = store();
        cache_orders(&mut c, &CachePayload { restaurant_id: None, orders: vec![order("o8"), order("o9")] }).unwrap();
        let a = match prepare_close(&mut c, &close_req("o8", "mut-00000008"), 0.21, "x").unwrap() {
            Prepared::Print { entry_id, .. } => entry_id,
            _ => panic!(),
        };
        finish_print(&c, &a, printed("0050")).unwrap();
        let b = match prepare_close(&mut c, &close_req("o9", "mut-00000009"), 0.21, "x").unwrap() {
            Prepared::Print { entry_id, .. } => entry_id,
            _ => panic!(),
        };
        finish_print(&c, &b, printed("0051")).unwrap();

        let r = mark_synced(&c, &a, &SyncResult { outcome: "retry".into(), needs_review: false, reason: Some("timeout".into()), server_response: None }).unwrap();
        assert_eq!(r.sync_status, "pending");
        let r = mark_synced(&c, &a, &SyncResult { outcome: "synced".into(), needs_review: true, reason: Some("Nota s-a modificat".into()), server_response: None }).unwrap();
        assert_eq!(r.sync_status, "synced");
        assert!(r.needs_review);
        let r = mark_synced(&c, &b, &SyncResult { outcome: "conflict".into(), needs_review: true, reason: Some("anulată".into()), server_response: None }).unwrap();
        assert_eq!(r.sync_status, "conflict");
        assert_eq!(r.fiscal_number.as_deref(), Some("0051"));
        assert!(pending_sync(&c).unwrap().is_empty());
        let r = requeue(&c, &b).unwrap();
        assert_eq!(r.sync_status, "pending");
        let k = counts(&c).unwrap();
        assert_eq!(k.needs_review, 2);
        mark_reviewed(&c, &a).unwrap();
        assert_eq!(counts(&c).unwrap().needs_review, 1);
    }

    #[test]
    fn ids_look_like_uuids_and_differ() {
        let a = new_id();
        let b = new_id();
        assert_eq!(a.len(), 36);
        assert_ne!(a, b);
    }
}
