/**
 * Cash-offline flow (Faza 2).
 *
 * Wired into PaymentModal's "Cash" button. Decides whether to:
 *   - online → POST /payments with Idempotency-Key (REST direct);
 *   - offline + cached server order + DP-25X reachable → emit fiscal,
 *     write outbox row, return success;
 *   - everything else → block with a controlled error message.
 *
 * Cash offline is forbidden on local-only drafts (no `serverId`) because
 * the worker can't post the payment back without an `order_id`.
 */
import { getFiscal, type FiscalDeviceAdapter } from '@/adapters';
import { isReachable } from '@/lib/reachability';
import { logger } from '@/lib/logger';
import {
  insertLocalPayment,
  type LocalPaymentOutboxRow,
} from '@/lib/db/localPaymentOutbox';
import {
  restaurantOrdersApi,
  type RestaurantOrder,
} from '@/lib/api/restaurantOrders';
import { getSyncEngine } from '@/lib/sync/bootstrap';

export type CashFlowOutcome =
  | { kind: 'online'; order: RestaurantOrder; idempotencyKey: string }
  | {
      kind: 'offline';
      localPaymentId: string;
      idempotencyKey: string;
      fiscalReceiptNumber: string;
      outboxRow: Pick<
        LocalPaymentOutboxRow,
        'id' | 'order_id' | 'amount_cents' | 'idempotency_key'
      >;
    };

export class CashFlowError extends Error {
  readonly code:
    | 'OFFLINE_NO_SERVER_ORDER'
    | 'OFFLINE_NO_FISCAL_DEVICE'
    | 'FISCAL_PRINT_FAILED'
    | 'AMOUNT_INVALID'
    | 'NO_RESTAURANT_CTX';
  constructor(
    code: CashFlowError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'CashFlowError';
    this.code = code;
  }
}

export interface CashFlowInput {
  /** Cached server order id (`remote_orders.id` / `RestaurantOrder.id`).
   *  Required even for online calls so the worker / replay path always
   *  has a stable identifier. */
  serverOrderId: string;
  restaurantId: string;
  amountCents: number;
  // Optional fiscal lines passed to the device. The DP-25X driver reads
  // these to print the bon; if empty we send a single "Comandă" line.
  fiscalLines?: Array<{ name: string; quantity: number; unitPriceCents: number; vatGroup: 'A' | 'B' | 'C' | 'D' | 'E' }>;
  operatorCode?: string;
  operatorPassword?: string;
  customerCif?: string;
}

const DEFAULT_OPERATOR = { code: '1', password: '0000' };

function newKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Probe the fiscal device for live status. We treat any failure to talk
 * to the device as "not available" — the cash-offline path is allowed
 * only when we're confident the bon will print.
 */
async function fiscalDeviceAvailable(adapter: FiscalDeviceAdapter): Promise<boolean> {
  try {
    const s = await adapter.status();
    return Boolean(s.online && s.ready && s.paperOk);
  } catch {
    return false;
  }
}

/**
 * Run the cash flow. Throws `CashFlowError` for the controlled blocking
 * cases (no fiscal, no cached order). Bubbles up other errors verbatim
 * so the caller can decide how to surface them.
 */
export async function runCashFlow(input: CashFlowInput): Promise<CashFlowOutcome> {
  if (input.amountCents <= 0) {
    throw new CashFlowError('AMOUNT_INVALID', 'Suma trebuie să fie pozitivă.');
  }

  const idempotencyKey = newKey('cash');

  if (isReachable()) {
    // Online — post straight to the backend. Idempotency-Key protects
    // against retries; on 200 we're done. We do NOT touch the outbox
    // for online cash; the server is the source of truth.
    const order = await restaurantOrdersApi.recordPayment(
      input.serverOrderId,
      {
        method: 'cash',
        amount: input.amountCents / 100,
        customerCif: input.customerCif,
      },
      { idempotencyKey },
    );
    logger.info('pos.cash', 'online cash registered', {
      orderId: input.serverOrderId,
      amountCents: input.amountCents,
      idempotencyKey,
      fiscalReceiptNumber: order.fiscalReceiptNumber,
    });
    return { kind: 'online', order, idempotencyKey };
  }

  // ── Offline path ────────────────────────────────────────────────────
  const fiscal = getFiscal();
  if (!(await fiscalDeviceAvailable(fiscal))) {
    throw new CashFlowError(
      'OFFLINE_NO_FISCAL_DEVICE',
      'Casa fiscală nu este disponibilă. Nu putem încasa cash offline.',
    );
  }

  // Mint identifiers BEFORE printing so the bon can be cross-referenced
  // even if the print succeeds and the DB write subsequently fails.
  const localPaymentId = newKey('lp');
  const fiscalAttemptId = newKey('fa');

  // Build a single fiscal line if the caller didn't supply detail. RO
  // VAT default is 19% (group B); food VAT is 9% (group A). We use group
  // B as the conservative default — operator can audit on the bon.
  const lines = input.fiscalLines && input.fiscalLines.length > 0
    ? input.fiscalLines
    : [{ name: 'Comandă POS', quantity: 1, unitPriceCents: input.amountCents, vatGroup: 'B' as const }];

  let fiscalNumber: string | undefined;
  try {
    const r = await fiscal.printReceipt({
      mutationId: idempotencyKey,
      orderId: input.serverOrderId,
      fiscalAttemptId,
      lines,
      payments: [{ method: 'cash', amountCents: input.amountCents }],
      operator: {
        code: input.operatorCode ?? DEFAULT_OPERATOR.code,
        password: input.operatorPassword ?? DEFAULT_OPERATOR.password,
      },
    });
    if (r.status !== 'printed' || !r.fiscalNumber) {
      throw new CashFlowError(
        'FISCAL_PRINT_FAILED',
        r.errorMessage ?? 'Casa fiscală nu a confirmat tipărirea bonului.',
      );
    }
    fiscalNumber = r.fiscalNumber;
  } catch (err) {
    if (err instanceof CashFlowError) throw err;
    logger.error('pos.cash', 'fiscal printReceipt threw', { err: String(err) });
    throw new CashFlowError(
      'FISCAL_PRINT_FAILED',
      `Bonul fiscal nu a putut fi emis: ${(err as Error).message}`,
    );
  }

  // Bon printed successfully — we MUST land an outbox row, otherwise
  // we have a fiscal receipt with no audit trail. The exec.transaction
  // wrapper here would be ideal but the SQLite executor is single-table
  // INSERT-friendly already; we let any thrown error bubble up.
  const engine = getSyncEngine();
  if (!engine) {
    throw new CashFlowError(
      'NO_RESTAURANT_CTX',
      'Engine-ul local nu este pornit — nu pot persista plata.',
    );
  }

  const collectedAt = new Date().toISOString();
  const outboxId = await insertLocalPayment(engine.exec, {
    restaurantId: input.restaurantId,
    orderId: input.serverOrderId,
    localPaymentId,
    idempotencyKey,
    amountCents: input.amountCents,
    method: 'cash',
    collectedAt,
    externalFiscalReceiptNumber: fiscalNumber,
    fiscalizationSource: 'device_offline',
    fiscalReceiptId: null,
    fiscalAttemptId: null,
  });

  logger.info('pos.cash', 'offline cash collected + outbox row written', {
    orderId: input.serverOrderId,
    amountCents: input.amountCents,
    idempotencyKey,
    fiscalReceiptNumber: fiscalNumber,
    outboxId,
  });

  return {
    kind: 'offline',
    localPaymentId,
    idempotencyKey,
    fiscalReceiptNumber: fiscalNumber,
    outboxRow: {
      id: outboxId,
      order_id: input.serverOrderId,
      amount_cents: input.amountCents,
      idempotency_key: idempotencyKey,
    },
  };
}
