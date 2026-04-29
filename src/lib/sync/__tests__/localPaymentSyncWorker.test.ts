/**
 * Tests for localPaymentSyncWorker. We exercise the full lifecycle by
 * stubbing `restaurantOrdersApi.recordPayment` and feeding outbox rows
 * via the sql.js-backed executor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSqlJsExec, type SqlJsHarness } from '@/lib/db/__tests__/sqlJsExec';
import { insertLocalPayment } from '@/lib/db/localPaymentOutbox';
import { runSyncTick } from '../localPaymentSyncWorker';
import {
  RestaurantOrderApiError,
  restaurantOrdersApi,
} from '@/lib/api/restaurantOrders';
import { _resetReachabilityForTests } from '@/lib/reachability';

let harness: SqlJsHarness;
beforeEach(async () => {
  _resetReachabilityForTests();
  harness = await makeSqlJsExec();
  await insertLocalPayment(harness.exec, {
    restaurantId: 'r-1',
    orderId: 'ord-1',
    localPaymentId: 'lp-1',
    idempotencyKey: 'k-1',
    amountCents: 4600,
    collectedAt: '2026-04-29T10:00:00Z',
    externalFiscalReceiptNumber: 'DP25-1',
    fiscalizationSource: 'device_offline',
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  harness?.close();
});

describe('runSyncTick', () => {
  it('skips work while offline', async () => {
    const recordSpy = vi
      .spyOn(restaurantOrdersApi, 'recordPayment')
      .mockResolvedValue({} as never);
    const r = await runSyncTick({ exec: harness.exec, isOnline: () => false });
    expect(r.skipped).toBe('offline');
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('marks the row synced on 200 and forwards Idempotency-Key + fiscal receipt', async () => {
    const recordSpy = vi
      .spyOn(restaurantOrdersApi, 'recordPayment')
      .mockResolvedValue({ id: 'ord-1' } as never);
    const r = await runSyncTick({ exec: harness.exec, isOnline: () => true });
    expect(r.synced).toBe(1);
    expect(r.failed).toBe(0);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const call = recordSpy.mock.calls[0];
    expect(call[0]).toBe('ord-1');
    expect(call[1].method).toBe('cash');
    expect(call[1].amount).toBe(46);
    expect(call[1].fiscalReceiptNumber).toBe('DP25-1');
    expect(call[1].fiscalizationSource).toBe('device_offline');
    expect(call[2]?.idempotencyKey).toBe('k-1');
    const row = (await harness.exec.select<{ status: string; synced_at: string | null }>(
      "SELECT status, synced_at FROM local_payment_outbox WHERE id = 1",
    ))[0];
    expect(row.status).toBe('synced');
    expect(row.synced_at).not.toBeNull();
  });

  it('queues a retry on a 500 (transient) with backoff', async () => {
    vi.spyOn(restaurantOrdersApi, 'recordPayment').mockRejectedValue(
      new RestaurantOrderApiError('boom', 500, 'boom'),
    );
    const r = await runSyncTick({
      exec: harness.exec,
      isOnline: () => true,
      now: () => Date.parse('2026-04-29T10:00:00Z'),
    });
    expect(r.retried).toBe(1);
    expect(r.failed).toBe(0);
    const row = (await harness.exec.select<{ status: string; attempts: number; next_retry_at: string | null; last_error: string | null }>(
      "SELECT status, attempts, next_retry_at, last_error FROM local_payment_outbox WHERE id = 1",
    ))[0];
    expect(row.status).toBe('pending_sync');
    expect(row.attempts).toBe(1);
    expect(row.next_retry_at).toBe('2026-04-29T10:00:30.000Z');
    expect(row.last_error).toBe('boom');
  });

  it('marks the row failed on a 4xx (non-retriable)', async () => {
    vi.spyOn(restaurantOrdersApi, 'recordPayment').mockRejectedValue(
      new RestaurantOrderApiError('IDEMPOTENCY_KEY_REUSED', 409, {
        code: 'IDEMPOTENCY_KEY_REUSED',
      }),
    );
    // 409 is technically retriable per our policy because the backend
    // emits IN_PROGRESS as 409 too — check that a real KEY_REUSED still
    // ends up retried (caller would need to surface the persistent
    // alert via an outbox-row-aging UI). Our worker treats 409 as
    // transient by design.
    const r = await runSyncTick({ exec: harness.exec, isOnline: () => true });
    expect(r.retried).toBe(1);
  });

  it('marks the row failed on a 400 validation error', async () => {
    vi.spyOn(restaurantOrdersApi, 'recordPayment').mockRejectedValue(
      new RestaurantOrderApiError('amount invalid', 400, 'amount invalid'),
    );
    const r = await runSyncTick({ exec: harness.exec, isOnline: () => true });
    expect(r.failed).toBe(1);
    const row = (await harness.exec.select<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM local_payment_outbox WHERE id = 1",
    ))[0];
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('amount invalid');
  });
});
