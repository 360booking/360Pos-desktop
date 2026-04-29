/**
 * Unit tests for the local_payment_outbox helpers + migration shape.
 * Faza 2.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { makeSqlJsExec, type SqlJsHarness } from './sqlJsExec';
import {
  claimNextBatch,
  countByStatus,
  hasUnsyncedForOrder,
  insertLocalPayment,
  markFailed,
  markRetry,
  markSynced,
  markSyncing,
} from '../localPaymentOutbox';

let harness: SqlJsHarness | null = null;
async function fresh(): Promise<SqlJsHarness> {
  harness = await makeSqlJsExec();
  return harness;
}
afterEach(() => {
  harness?.close();
  harness = null;
});

const baseRow = {
  restaurantId: 'r-1',
  orderId: 'ord-1',
  amountCents: 4600,
  collectedAt: '2026-04-29T10:00:00Z',
};

describe('local_payment_outbox migration', () => {
  it('creates the table with the expected columns', async () => {
    const h = await fresh();
    const cols = await h.exec.select<{ name: string }>(
      "SELECT name FROM pragma_table_info('local_payment_outbox')",
    );
    const names = cols.map((c) => c.name);
    for (const c of [
      'id',
      'restaurant_id',
      'order_id',
      'local_payment_id',
      'idempotency_key',
      'amount_cents',
      'method',
      'status',
      'collected_at',
      'created_at',
      'synced_at',
      'attempts',
      'next_retry_at',
      'last_error',
      'external_fiscal_receipt_number',
      'fiscalization_source',
      'fiscal_attempt_id',
      'fiscal_receipt_id',
    ]) {
      expect(names).toContain(c);
    }
  });

  it('enforces UNIQUE(idempotency_key) and UNIQUE(local_payment_id)', async () => {
    const h = await fresh();
    await insertLocalPayment(h.exec, {
      ...baseRow,
      localPaymentId: 'lp-1',
      idempotencyKey: 'k-1',
    });
    await expect(
      insertLocalPayment(h.exec, {
        ...baseRow,
        localPaymentId: 'lp-1', // collide on local_payment_id
        idempotencyKey: 'k-2',
      }),
    ).rejects.toThrow();
    await expect(
      insertLocalPayment(h.exec, {
        ...baseRow,
        localPaymentId: 'lp-2',
        idempotencyKey: 'k-1', // collide on idempotency_key
      }),
    ).rejects.toThrow();
  });
});

describe('claimNextBatch', () => {
  it('returns pending and failed-with-due-retry rows oldest first', async () => {
    const h = await fresh();
    await insertLocalPayment(h.exec, {
      ...baseRow,
      localPaymentId: 'lp-1',
      idempotencyKey: 'k-1',
      collectedAt: '2026-04-29T10:00:00Z',
    });
    await insertLocalPayment(h.exec, {
      ...baseRow,
      localPaymentId: 'lp-2',
      idempotencyKey: 'k-2',
      collectedAt: '2026-04-29T10:01:00Z',
    });
    // Mark lp-2 as syncing — must NOT be returned by claimNextBatch.
    const id2 = (await h.exec.select<{ id: number }>(
      "SELECT id FROM local_payment_outbox WHERE local_payment_id = 'lp-2'",
    ))[0].id;
    await markSyncing(h.exec, id2);

    const batch = await claimNextBatch(h.exec, 10);
    expect(batch.length).toBe(1);
    expect(batch[0].local_payment_id).toBe('lp-1');
  });

  it('skips failed rows whose next_retry_at is in the future', async () => {
    const h = await fresh();
    await insertLocalPayment(h.exec, {
      ...baseRow,
      localPaymentId: 'lp-1',
      idempotencyKey: 'k-1',
    });
    const id = (await h.exec.select<{ id: number }>(
      "SELECT id FROM local_payment_outbox LIMIT 1",
    ))[0].id;
    await markRetry(h.exec, id, 'transient', '2099-01-01T00:00:00Z');
    const batch = await claimNextBatch(h.exec, 10);
    expect(batch.length).toBe(0);
  });
});

describe('status transitions', () => {
  it('markSynced flips status + stamps synced_at', async () => {
    const h = await fresh();
    await insertLocalPayment(h.exec, {
      ...baseRow,
      localPaymentId: 'lp-1',
      idempotencyKey: 'k-1',
    });
    const id = (await h.exec.select<{ id: number }>(
      "SELECT id FROM local_payment_outbox LIMIT 1",
    ))[0].id;
    await markSyncing(h.exec, id);
    await markSynced(h.exec, id);
    const row = (await h.exec.select<{ status: string; synced_at: string | null; attempts: number }>(
      `SELECT status, synced_at, attempts FROM local_payment_outbox WHERE id = ?`,
      [id],
    ))[0];
    expect(row.status).toBe('synced');
    expect(row.synced_at).not.toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('markFailed records the error + leaves next_retry_at null', async () => {
    const h = await fresh();
    await insertLocalPayment(h.exec, {
      ...baseRow,
      localPaymentId: 'lp-1',
      idempotencyKey: 'k-1',
    });
    const id = (await h.exec.select<{ id: number }>(
      "SELECT id FROM local_payment_outbox LIMIT 1",
    ))[0].id;
    await markFailed(h.exec, id, 'IDEMPOTENCY_KEY_REUSED');
    const row = (await h.exec.select<{ status: string; last_error: string | null; next_retry_at: string | null }>(
      `SELECT status, last_error, next_retry_at FROM local_payment_outbox WHERE id = ?`,
      [id],
    ))[0];
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(row.next_retry_at).toBeNull();
  });
});

describe('counts + per-order overlay', () => {
  it('aggregates by status', async () => {
    const h = await fresh();
    await insertLocalPayment(h.exec, {
      ...baseRow,
      localPaymentId: 'lp-1',
      idempotencyKey: 'k-1',
    });
    await insertLocalPayment(h.exec, {
      ...baseRow,
      localPaymentId: 'lp-2',
      idempotencyKey: 'k-2',
    });
    const id1 = (await h.exec.select<{ id: number }>(
      "SELECT id FROM local_payment_outbox ORDER BY id LIMIT 1",
    ))[0].id;
    await markSyncing(h.exec, id1);
    await markSynced(h.exec, id1);
    const counts = await countByStatus(h.exec);
    expect(counts.pending).toBe(1);
    expect(counts.synced).toBe(1);
    expect(counts.failed).toBe(0);
  });

  it('hasUnsyncedForOrder reflects pending/syncing/failed only', async () => {
    const h = await fresh();
    await insertLocalPayment(h.exec, {
      ...baseRow,
      localPaymentId: 'lp-1',
      idempotencyKey: 'k-1',
    });
    expect(await hasUnsyncedForOrder(h.exec, 'ord-1')).toBe(true);
    const id = (await h.exec.select<{ id: number }>(
      "SELECT id FROM local_payment_outbox LIMIT 1",
    ))[0].id;
    await markSyncing(h.exec, id);
    await markSynced(h.exec, id);
    expect(await hasUnsyncedForOrder(h.exec, 'ord-1')).toBe(false);
  });
});
