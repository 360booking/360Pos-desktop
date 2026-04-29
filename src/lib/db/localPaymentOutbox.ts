/**
 * Local persistence for `local_payment_outbox` (Faza 2).
 *
 * The outbox is the desktop's record of cash payments collected while
 * offline (or already synced — we keep them around for audit). Schema:
 * `pos-desktop/src/sql/migrations/0009_local_payment_outbox.sql`.
 *
 * The sync worker (`localPaymentSyncWorker`) is the only writer for the
 * status-flip transitions; this module exposes the read/write atoms it
 * uses, plus the insert helper that the cash-offline flow calls.
 */
import type { SqlExecutor } from './executor';

export type LocalPaymentStatus =
  | 'pending_sync'
  | 'syncing'
  | 'synced'
  | 'failed';

export interface LocalPaymentOutboxRow {
  id: number;
  restaurant_id: string;
  order_id: string;
  local_payment_id: string;
  idempotency_key: string;
  amount_cents: number;
  method: string;
  status: LocalPaymentStatus;
  collected_at: string;
  created_at: string;
  synced_at: string | null;
  attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
  external_fiscal_receipt_number: string | null;
  fiscalization_source: string;
  fiscal_attempt_id: number | null;
  fiscal_receipt_id: string | null;
}

export interface InsertLocalPayment {
  restaurantId: string;
  orderId: string;
  localPaymentId: string;
  idempotencyKey: string;
  amountCents: number;
  method?: 'cash' | 'card' | 'voucher' | 'other';
  collectedAt: string;
  externalFiscalReceiptNumber?: string | null;
  fiscalizationSource?: string;
  fiscalAttemptId?: number | null;
  fiscalReceiptId?: string | null;
}

/**
 * Insert a freshly-collected cash payment. Returns the auto-incremented
 * row id so the caller can reference it later (UI, logs).
 */
export async function insertLocalPayment(
  exec: SqlExecutor,
  rec: InsertLocalPayment,
): Promise<number> {
  await exec.execute(
    `INSERT INTO local_payment_outbox (
        restaurant_id, order_id, local_payment_id, idempotency_key,
        amount_cents, method, status, collected_at,
        external_fiscal_receipt_number, fiscalization_source,
        fiscal_attempt_id, fiscal_receipt_id)
     VALUES (?, ?, ?, ?, ?, ?, 'pending_sync', ?, ?, ?, ?, ?)`,
    [
      rec.restaurantId,
      rec.orderId,
      rec.localPaymentId,
      rec.idempotencyKey,
      rec.amountCents,
      rec.method ?? 'cash',
      rec.collectedAt,
      rec.externalFiscalReceiptNumber ?? null,
      rec.fiscalizationSource ?? 'device_offline',
      rec.fiscalAttemptId ?? null,
      rec.fiscalReceiptId ?? null,
    ],
  );
  const rows = await exec.select<{ id: number }>(
    `SELECT id FROM local_payment_outbox WHERE local_payment_id = ?`,
    [rec.localPaymentId],
  );
  return rows[0]?.id ?? 0;
}

/**
 * Pick rows that the worker should attempt to sync now. Workers ask for
 * a small batch (default 10) so a single tick can't monopolise the DB
 * connection during a flush.
 */
export async function claimNextBatch(
  exec: SqlExecutor,
  limit: number = 10,
): Promise<LocalPaymentOutboxRow[]> {
  return exec.select<LocalPaymentOutboxRow>(
    `SELECT * FROM local_payment_outbox
       WHERE status IN ('pending_sync', 'failed')
         AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
       ORDER BY collected_at ASC
       LIMIT ?`,
    [limit],
  );
}

export async function markSyncing(
  exec: SqlExecutor,
  id: number,
): Promise<void> {
  await exec.execute(
    `UPDATE local_payment_outbox
        SET status = 'syncing',
            attempts = attempts + 1,
            last_error = NULL
      WHERE id = ?`,
    [id],
  );
}

export async function markSynced(
  exec: SqlExecutor,
  id: number,
): Promise<void> {
  await exec.execute(
    `UPDATE local_payment_outbox
        SET status = 'synced',
            synced_at = datetime('now'),
            last_error = NULL,
            next_retry_at = NULL
      WHERE id = ?`,
    [id],
  );
}

export async function markFailed(
  exec: SqlExecutor,
  id: number,
  error: string,
): Promise<void> {
  await exec.execute(
    `UPDATE local_payment_outbox
        SET status = 'failed',
            last_error = ?,
            next_retry_at = NULL
      WHERE id = ?`,
    [error, id],
  );
}

export async function markRetry(
  exec: SqlExecutor,
  id: number,
  error: string,
  nextRetryAtIso: string,
): Promise<void> {
  await exec.execute(
    `UPDATE local_payment_outbox
        SET status = 'pending_sync',
            last_error = ?,
            next_retry_at = ?
      WHERE id = ?`,
    [error, nextRetryAtIso, id],
  );
}

export interface OutboxCounts {
  pending: number;
  syncing: number;
  failed: number;
  synced: number;
}

export async function countByStatus(
  exec: SqlExecutor,
): Promise<OutboxCounts> {
  const rows = await exec.select<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM local_payment_outbox GROUP BY status`,
  );
  const out: OutboxCounts = { pending: 0, syncing: 0, failed: 0, synced: 0 };
  for (const r of rows) {
    if (r.status === 'pending_sync') out.pending = r.n;
    else if (r.status === 'syncing') out.syncing = r.n;
    else if (r.status === 'failed') out.failed = r.n;
    else if (r.status === 'synced') out.synced = r.n;
  }
  return out;
}

export async function listForOrder(
  exec: SqlExecutor,
  orderId: string,
): Promise<LocalPaymentOutboxRow[]> {
  return exec.select<LocalPaymentOutboxRow>(
    `SELECT * FROM local_payment_outbox
       WHERE order_id = ?
       ORDER BY collected_at DESC`,
    [orderId],
  );
}

/** Fast existence check for the per-order overlay badge. */
export async function hasUnsyncedForOrder(
  exec: SqlExecutor,
  orderId: string,
): Promise<boolean> {
  const rows = await exec.select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM local_payment_outbox
       WHERE order_id = ? AND status IN ('pending_sync', 'syncing', 'failed')`,
    [orderId],
  );
  return (rows[0]?.n ?? 0) > 0;
}
