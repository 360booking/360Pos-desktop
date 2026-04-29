/**
 * Tests for cashOfflineFlow — gating + branch selection.
 *
 * We mock `getFiscal()` to control whether the device is "available"
 * and `restaurantOrdersApi.recordPayment` for the online branch. The
 * sync engine is stubbed via `getSyncEngine` so writes go through a
 * sql.js-backed exec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCashFlow } from '../cashOfflineFlow';
import { _resetReachabilityForTests, recordFailure } from '../reachability';
import * as adapters from '@/adapters';
import { restaurantOrdersApi } from '@/lib/api/restaurantOrders';
import * as bootstrap from '@/lib/sync/bootstrap';
import { makeSqlJsExec, type SqlJsHarness } from '@/lib/db/__tests__/sqlJsExec';
import { AxiosError } from 'axios';

let harness: SqlJsHarness;
beforeEach(async () => {
  _resetReachabilityForTests();
  harness = await makeSqlJsExec();
  vi.spyOn(bootstrap, 'getSyncEngine').mockReturnValue({
    exec: harness.exec,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  harness?.close();
});

function flipOffline() {
  const err = new AxiosError('Network Error', 'ERR_NETWORK');
  recordFailure(err);
  recordFailure(err); // 2 consecutive failures → offline
}

describe('online branch', () => {
  it('POSTs /payments with Idempotency-Key + cash method', async () => {
    const recordSpy = vi
      .spyOn(restaurantOrdersApi, 'recordPayment')
      .mockResolvedValue({ id: 'ord-1' } as never);
    const out = await runCashFlow({
      serverOrderId: 'ord-1',
      restaurantId: 'r-1',
      amountCents: 4600,
    });
    expect(out.kind).toBe('online');
    expect(recordSpy).toHaveBeenCalledOnce();
    const [orderId, body, opts] = recordSpy.mock.calls[0];
    expect(orderId).toBe('ord-1');
    expect(body.method).toBe('cash');
    expect(body.amount).toBe(46);
    expect(opts?.idempotencyKey).toBeTruthy();
  });
});

describe('offline branch — fiscal device gate', () => {
  it('blocks cash when DP-25X reports not ready', async () => {
    flipOffline();
    vi.spyOn(adapters, 'getFiscal').mockReturnValue({
      status: vi.fn().mockResolvedValue({
        online: false,
        ready: false,
        paperOk: false,
      }),
      printReceipt: vi.fn(),
    } as never);
    await expect(
      runCashFlow({
        serverOrderId: 'ord-1',
        restaurantId: 'r-1',
        amountCents: 4600,
      }),
    ).rejects.toMatchObject({
      name: 'CashFlowError',
      code: 'OFFLINE_NO_FISCAL_DEVICE',
    });
  });

  it('blocks cash when status() throws', async () => {
    flipOffline();
    vi.spyOn(adapters, 'getFiscal').mockReturnValue({
      status: vi.fn().mockRejectedValue(new Error('serial timeout')),
      printReceipt: vi.fn(),
    } as never);
    await expect(
      runCashFlow({
        serverOrderId: 'ord-1',
        restaurantId: 'r-1',
        amountCents: 4600,
      }),
    ).rejects.toMatchObject({ code: 'OFFLINE_NO_FISCAL_DEVICE' });
  });

  it('emits fiscal + writes outbox row on offline cash', async () => {
    flipOffline();
    const printReceipt = vi.fn().mockResolvedValue({
      status: 'printed',
      fiscalNumber: 'DP25-9999',
      rawTrace: '',
    });
    vi.spyOn(adapters, 'getFiscal').mockReturnValue({
      status: vi.fn().mockResolvedValue({
        online: true,
        ready: true,
        paperOk: true,
      }),
      printReceipt,
    } as never);
    const out = await runCashFlow({
      serverOrderId: 'ord-1',
      restaurantId: 'r-1',
      amountCents: 4600,
    });
    expect(out.kind).toBe('offline');
    if (out.kind !== 'offline') return;
    expect(out.fiscalReceiptNumber).toBe('DP25-9999');
    expect(printReceipt).toHaveBeenCalledOnce();
    const rows = await harness.exec.select<{
      idempotency_key: string;
      external_fiscal_receipt_number: string;
      fiscalization_source: string;
      status: string;
    }>(
      `SELECT idempotency_key, external_fiscal_receipt_number,
              fiscalization_source, status
         FROM local_payment_outbox`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].external_fiscal_receipt_number).toBe('DP25-9999');
    expect(rows[0].fiscalization_source).toBe('device_offline');
    expect(rows[0].status).toBe('pending_sync');
    expect(rows[0].idempotency_key).toBe(out.idempotencyKey);
  });

  it('rejects amount <= 0', async () => {
    await expect(
      runCashFlow({
        serverOrderId: 'ord-1',
        restaurantId: 'r-1',
        amountCents: 0,
      }),
    ).rejects.toMatchObject({ code: 'AMOUNT_INVALID' });
  });
});
