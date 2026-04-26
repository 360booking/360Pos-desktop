/**
 * Local persistence for the CARD_PAYMENT_UNKNOWN recovery queue.
 * Sprint 8.
 */
import type { SqlExecutor } from './executor';

export type CardRecoveryStatus =
  | 'open'
  | 'resolved_paid'
  | 'resolved_void'
  | 'cancelled';

export interface CardRecoveryRow {
  id: string;
  order_id: string;
  amount_cents: number;
  terminal_trace: string | null;
  terminal_auth_code: string | null;
  terminal_rrn: string | null;
  raised_at: string;
  status: CardRecoveryStatus;
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface InsertCardRecovery {
  id: string;
  orderId: string;
  amountCents: number;
  terminalTrace?: string | null;
  terminalAuthCode?: string | null;
  terminalRrn?: string | null;
}

export async function insertCardRecovery(
  exec: SqlExecutor,
  rec: InsertCardRecovery,
): Promise<void> {
  await exec.execute(
    `INSERT INTO card_recoveries (id, order_id, amount_cents, terminal_trace,
       terminal_auth_code, terminal_rrn)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      rec.id,
      rec.orderId,
      rec.amountCents,
      rec.terminalTrace ?? null,
      rec.terminalAuthCode ?? null,
      rec.terminalRrn ?? null,
    ],
  );
}

export async function listCardRecoveries(
  exec: SqlExecutor,
  status: 'open' | 'all' = 'open',
): Promise<CardRecoveryRow[]> {
  const sql =
    status === 'open'
      ? `SELECT * FROM card_recoveries WHERE status = 'open' ORDER BY raised_at DESC`
      : `SELECT * FROM card_recoveries ORDER BY raised_at DESC`;
  return exec.select<CardRecoveryRow>(sql);
}

export async function resolveCardRecovery(
  exec: SqlExecutor,
  id: string,
  status: CardRecoveryStatus,
  note?: string,
): Promise<void> {
  await exec.execute(
    `UPDATE card_recoveries
        SET status = ?, resolved_at = datetime('now'), resolution_note = ?
      WHERE id = ?`,
    [status, note ?? null, id],
  );
}
