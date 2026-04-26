/**
 * Pure POS actions.
 *
 * Each action takes `(state, command, ctx) → { next, events }`. No side
 * effects: no Date.now(), no Math.random(), no fetch, no DB. The caller
 * supplies a `Clock` and `IdGen` via `ctx` so tests are deterministic and
 * the sync engine can replay events with stable timestamps.
 */
import type {
  DeviceId,
  FiscalAttempt,
  Iso,
  KitchenTicket,
  LocalId,
  MutationId,
  Order,
  OrderItem,
  OrderState,
  Payment,
  PaymentMethod,
  ServerId,
} from './types';
import type { TenantVatConfig } from './vat';
import { pickRateForCategory, type CategoryType } from './vat';
import {
  lineTotalCents,
  remainingCents,
  withRefreshedTotals,
} from './calculator';
import {
  assertCanTransition,
  assertCardPaymentAllowed,
  assertHasItems,
  assertNoUnknownAttempt,
  assertNotCancelled,
  assertNotFiscalised,
  assertOwnedLocally,
  OrderNotPaidError,
  PaymentExceedsRemainingError,
} from './state-machine';
import type {
  CardPaymentUnknownPayload,
  DiscountAppliedPayload,
  FiscalAttemptCreatedPayload,
  FiscalReceiptPrintedPayload,
  FiscalReceiptUnknownPayload,
  OrderCancelledPayload,
  OrderClosedPayload,
  OrderCreatedPayload,
  OrderItemAddedPayload,
  OrderItemVoidedPayload,
  PaymentRegisteredPayload,
  SentToKitchenPayload,
  SyncEvent,
  TipAddedPayload,
} from './events';

// ─── Side-effect injection ──────────────────────────────────────────────────

export interface Clock {
  nowIso(): Iso;
}
export interface IdGen {
  newId(): LocalId;
  newMutationId(): MutationId;
}
export interface ActionCtx {
  clock: Clock;
  ids: IdGen;
  deviceId: DeviceId;
  /** True ⇒ online; false ⇒ offline. Drives ownership + card-payment guards. */
  online: boolean;
}

export interface ActionResult {
  next: Order;
  events: SyncEvent[];
}

function envelope<P>(
  ctx: ActionCtx,
  order: Order,
  type: SyncEvent['type'],
  payload: P,
  mutationId: MutationId,
): SyncEvent<P> {
  return {
    mutationId,
    type,
    localTimestamp: ctx.clock.nowIso(),
    deviceId: ctx.deviceId,
    orderLocalId: order.id,
    orderServerId: order.serverId,
    payload,
  };
}

// ─── createOrder ────────────────────────────────────────────────────────────

export interface CreateOrderCommand {
  tableId: LocalId | null;
  source?: Order['source'];
  vatConfig: TenantVatConfig;
}

export function createOrder(cmd: CreateOrderCommand, ctx: ActionCtx): ActionResult {
  const id = ctx.ids.newId();
  const mutationId = ctx.ids.newMutationId();
  const now = ctx.clock.nowIso();
  const order: Order = {
    id,
    serverId: null,
    mutationId,
    tableId: cmd.tableId,
    state: 'draft',
    source: cmd.source ?? 'pos',
    ownerDeviceId: ctx.deviceId,
    items: [],
    payments: [],
    discountCents: 0,
    discountNote: null,
    tipCents: 0,
    subtotalCents: 0,
    vatCents: 0,
    totalCents: 0,
    fiscalAttempts: [],
    fiscalReceipt: null,
    openedAt: now,
    closedAt: null,
    vatConfig: cmd.vatConfig,
    version: 0,
  };
  const event = envelope<OrderCreatedPayload>(
    ctx,
    order,
    'ORDER_CREATED',
    { tableId: order.tableId, source: order.source, ownerDeviceId: order.ownerDeviceId },
    mutationId,
  );
  return { next: order, events: [event] };
}

// ─── addItem ────────────────────────────────────────────────────────────────

export interface AddItemCommand {
  productId: LocalId | null;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  /** Category type drives VAT rate selection (mirrors backend). */
  categoryType: CategoryType | null;
  modifiers?: Record<string, unknown>;
}

export function addItem(
  order: Order,
  cmd: AddItemCommand,
  ctx: ActionCtx,
): ActionResult {
  assertNotCancelled(order);
  assertNotFiscalised(order);
  assertOwnedLocally(order, ctx.deviceId, ctx.online);

  const itemId = ctx.ids.newId();
  const itemMutationId = ctx.ids.newMutationId();
  const vatRateBp = pickRateForCategory(order.vatConfig, cmd.categoryType);
  const item: OrderItem = {
    id: itemId,
    mutationId: itemMutationId,
    productId: cmd.productId,
    productName: cmd.productName,
    quantity: cmd.quantity,
    unitPriceCents: cmd.unitPriceCents,
    lineTotalCents: lineTotalCents(cmd.unitPriceCents, cmd.quantity),
    vatRateBp,
    modifiers: cmd.modifiers ?? {},
    kitchenTicketId: null,
    sentAt: null,
    voidedAt: null,
    voidReason: null,
    createdAt: ctx.clock.nowIso(),
  };
  let next: Order = withRefreshedTotals({
    ...order,
    items: [...order.items, item],
    state: order.state === 'draft' ? 'open' : order.state,
  });
  const events: SyncEvent[] = [];
  if (order.state === 'draft') {
    assertCanTransition('draft', 'open');
  }
  events.push(
    envelope<OrderItemAddedPayload>(
      ctx,
      next,
      'ORDER_ITEM_ADDED',
      {
        itemMutationId,
        productId: cmd.productId,
        productName: cmd.productName,
        quantity: cmd.quantity,
        unitPriceCents: cmd.unitPriceCents,
        vatRateBp,
        modifiers: cmd.modifiers,
      },
      itemMutationId,
    ),
  );
  return { next, events };
}

// ─── voidItem ───────────────────────────────────────────────────────────────

export interface VoidItemCommand {
  itemId: LocalId;
  reason: string;
}

export function voidItem(
  order: Order,
  cmd: VoidItemCommand,
  ctx: ActionCtx,
): ActionResult {
  assertNotCancelled(order);
  assertNotFiscalised(order);
  assertOwnedLocally(order, ctx.deviceId, ctx.online);

  const target = order.items.find((it) => it.id === cmd.itemId);
  if (!target) throw new Error(`Item not found: ${cmd.itemId}`);
  if (target.voidedAt) throw new Error(`Item already voided: ${cmd.itemId}`);

  const mutationId = ctx.ids.newMutationId();
  const next = withRefreshedTotals({
    ...order,
    items: order.items.map((it) =>
      it.id === cmd.itemId
        ? { ...it, voidedAt: ctx.clock.nowIso(), voidReason: cmd.reason }
        : it,
    ),
  });
  return {
    next,
    events: [
      envelope<OrderItemVoidedPayload>(
        ctx,
        next,
        'ORDER_ITEM_VOIDED',
        { itemId: cmd.itemId, reason: cmd.reason },
        mutationId,
      ),
    ],
  };
}

// ─── applyDiscount ──────────────────────────────────────────────────────────

export interface ApplyDiscountCommand {
  amountCents: number; // absolute discount, in cents
  note: string | null;
}

export function applyDiscount(
  order: Order,
  cmd: ApplyDiscountCommand,
  ctx: ActionCtx,
): ActionResult {
  assertNotCancelled(order);
  assertNotFiscalised(order);
  assertOwnedLocally(order, ctx.deviceId, ctx.online);
  if (cmd.amountCents < 0) throw new Error('discount must be non-negative');
  const mutationId = ctx.ids.newMutationId();
  const next = withRefreshedTotals({
    ...order,
    discountCents: cmd.amountCents,
    discountNote: cmd.note,
  });
  return {
    next,
    events: [
      envelope<DiscountAppliedPayload>(
        ctx,
        next,
        'DISCOUNT_APPLIED',
        { amountCents: cmd.amountCents, note: cmd.note },
        mutationId,
      ),
    ],
  };
}

// ─── addTip ─────────────────────────────────────────────────────────────────

export interface AddTipCommand {
  amountCents: number;
}

export function addTip(order: Order, cmd: AddTipCommand, ctx: ActionCtx): ActionResult {
  assertNotCancelled(order);
  assertOwnedLocally(order, ctx.deviceId, ctx.online);
  if (cmd.amountCents < 0) throw new Error('tip must be non-negative');
  const mutationId = ctx.ids.newMutationId();
  const next = withRefreshedTotals({ ...order, tipCents: cmd.amountCents });
  return {
    next,
    events: [
      envelope<TipAddedPayload>(
        ctx,
        next,
        'TIP_ADDED',
        { amountCents: cmd.amountCents },
        mutationId,
      ),
    ],
  };
}

// ─── sendToKitchen ──────────────────────────────────────────────────────────

export interface SendToKitchenCommand {
  /** Map item.id → station. Default station for items without an entry. */
  stationByItemId?: Record<LocalId, string>;
  defaultStation?: string;
}

export function sendToKitchen(
  order: Order,
  cmd: SendToKitchenCommand,
  ctx: ActionCtx,
): ActionResult & { tickets: KitchenTicket[] } {
  assertNotCancelled(order);
  assertNotFiscalised(order);
  assertOwnedLocally(order, ctx.deviceId, ctx.online);
  assertHasItems(order);
  assertCanTransition(order.state, 'sent_to_kitchen');

  // Group items per station; one ticket per station.
  const defaultStation = cmd.defaultStation ?? 'kitchen';
  const groups = new Map<string, OrderItem[]>();
  const unsent = order.items.filter(
    (it) => it.voidedAt == null && it.sentAt == null,
  );
  if (unsent.length === 0) {
    // Nothing new to send — no-op, no event.
    return { next: order, events: [], tickets: [] };
  }

  for (const it of unsent) {
    const station = cmd.stationByItemId?.[it.id] ?? defaultStation;
    const arr = groups.get(station) ?? [];
    arr.push(it);
    groups.set(station, arr);
  }

  const now = ctx.clock.nowIso();
  const tickets: KitchenTicket[] = [];
  for (const [station, items] of groups) {
    const ticketId = ctx.ids.newId();
    const ticketMutationId = ctx.ids.newMutationId();
    tickets.push({
      id: ticketId,
      mutationId: ticketMutationId,
      orderLocalId: order.id,
      station,
      status: 'pending',
      parentTicketId: null,
      printedAt: null,
      seenAt: null,
      inPrepAt: null,
      readyAt: null,
      completedAt: null,
      payload: {
        items: items.map((it) => ({
          name: it.productName,
          quantity: it.quantity,
          modifiers: it.modifiers,
        })),
      },
    });
  }

  // Mark items sent + attach their kitchen_ticket_id.
  const ticketByStation = new Map(tickets.map((t) => [t.station, t.id]));
  const items = order.items.map((it): OrderItem => {
    if (it.sentAt != null || it.voidedAt != null) return it;
    const station = cmd.stationByItemId?.[it.id] ?? defaultStation;
    return { ...it, sentAt: now, kitchenTicketId: ticketByStation.get(station) ?? null };
  });

  const next: Order = withRefreshedTotals({
    ...order,
    items,
    state: 'sent_to_kitchen',
  });

  const eventMutationId = ctx.ids.newMutationId();
  return {
    next,
    tickets,
    events: [
      envelope<SentToKitchenPayload>(
        ctx,
        next,
        'SENT_TO_KITCHEN',
        { ticketIds: tickets.map((t) => t.id) },
        eventMutationId,
      ),
    ],
  };
}

// ─── registerCashPayment ────────────────────────────────────────────────────

export interface RegisterCashPaymentCommand {
  amountCents: number;
  /** When true, we accept over-tender (cash drawer with change due). */
  acceptOverTender?: boolean;
}

export function registerCashPayment(
  order: Order,
  cmd: RegisterCashPaymentCommand,
  ctx: ActionCtx,
): ActionResult {
  assertNotCancelled(order);
  assertOwnedLocally(order, ctx.deviceId, ctx.online);
  assertHasItems(order);
  if (cmd.amountCents <= 0) throw new Error('cash amount must be > 0');

  const remaining = remainingCents(order);
  if (!cmd.acceptOverTender && cmd.amountCents > remaining) {
    throw new PaymentExceedsRemainingError(cmd.amountCents, remaining);
  }

  return registerPayment(order, {
    method: 'cash',
    amountCents: cmd.amountCents,
    status: 'recorded',
  }, ctx);
}

// ─── registerCardPaymentResult ──────────────────────────────────────────────

export interface RegisterCardPaymentResultCommand {
  amountCents: number;
  status: 'approved' | 'declined' | 'cancelled' | 'unknown';
  terminalAuthCode?: string;
  terminalRrn?: string;
  terminalTrace?: string;
}

export function registerCardPaymentResult(
  order: Order,
  cmd: RegisterCardPaymentResultCommand,
  ctx: ActionCtx,
): ActionResult {
  assertNotCancelled(order);
  assertOwnedLocally(order, ctx.deviceId, ctx.online);
  assertCardPaymentAllowed(ctx.online); // card flow can only START online; result must arrive online too
  assertHasItems(order);
  if (cmd.amountCents <= 0) throw new Error('card amount must be > 0');

  if (cmd.status === 'unknown') {
    // Unknown does NOT count as paid. We log it for the recovery flow and
    // do NOT advance the order state.
    const mutationId = ctx.ids.newMutationId();
    const payment: Payment = {
      id: ctx.ids.newId(),
      mutationId,
      method: 'card',
      amountCents: cmd.amountCents,
      status: 'unknown',
      terminalAuthCode: cmd.terminalAuthCode ?? null,
      terminalRrn: cmd.terminalRrn ?? null,
      terminalTrace: cmd.terminalTrace ?? null,
      rawResponse: null,
      errorCode: null,
      createdAt: ctx.clock.nowIso(),
    };
    const next = { ...order, payments: [...order.payments, payment] };
    return {
      next,
      events: [
        envelope<CardPaymentUnknownPayload>(
          ctx,
          next,
          'CARD_PAYMENT_UNKNOWN',
          {
            paymentMutationId: mutationId,
            amountCents: cmd.amountCents,
            terminalTrace: cmd.terminalTrace ?? '',
          },
          mutationId,
        ),
      ],
    };
  }

  return registerPayment(
    order,
    {
      method: 'card',
      amountCents: cmd.amountCents,
      status: cmd.status,
      terminalAuthCode: cmd.terminalAuthCode ?? null,
      terminalRrn: cmd.terminalRrn ?? null,
    },
    ctx,
  );
}

// ─── shared payment helper ──────────────────────────────────────────────────

interface InternalPaymentSpec {
  method: PaymentMethod;
  amountCents: number;
  status: 'recorded' | 'approved' | 'declined' | 'cancelled';
  terminalAuthCode?: string | null;
  terminalRrn?: string | null;
}

function registerPayment(
  order: Order,
  spec: InternalPaymentSpec,
  ctx: ActionCtx,
): ActionResult {
  const mutationId = ctx.ids.newMutationId();
  const payment: Payment = {
    id: ctx.ids.newId(),
    mutationId,
    method: spec.method,
    amountCents: spec.amountCents,
    status: spec.status,
    terminalAuthCode: spec.terminalAuthCode ?? null,
    terminalRrn: spec.terminalRrn ?? null,
    terminalTrace: null,
    rawResponse: null,
    errorCode: null,
    createdAt: ctx.clock.nowIso(),
  };
  const withPayment = withRefreshedTotals({
    ...order,
    payments: [...order.payments, payment],
  });

  // Drive state. Only successful payments (recorded/approved) advance state.
  let nextState: OrderState = withPayment.state;
  const isSuccess = spec.status === 'recorded' || spec.status === 'approved';
  if (isSuccess) {
    const remaining = remainingCents(withPayment);
    if (remaining === 0) {
      assertCanTransition(withPayment.state, 'paid');
      nextState = 'paid';
    } else {
      assertCanTransition(withPayment.state, 'partially_paid');
      nextState = 'partially_paid';
    }
  }
  const next: Order = { ...withPayment, state: nextState };

  return {
    next,
    events: [
      envelope<PaymentRegisteredPayload>(
        ctx,
        next,
        'PAYMENT_REGISTERED',
        {
          paymentMutationId: mutationId,
          method: spec.method,
          amountCents: spec.amountCents,
          status: spec.status,
          terminalAuthCode: spec.terminalAuthCode ?? undefined,
          terminalRrn: spec.terminalRrn ?? undefined,
        },
        mutationId,
      ),
    ],
  };
}

// ─── createFiscalAttempt ────────────────────────────────────────────────────

export interface CreateFiscalAttemptCommand {
  adapterId: string; // 'datecs-dp25', 'simulator', ...
}

export function createFiscalAttempt(
  order: Order,
  cmd: CreateFiscalAttemptCommand,
  ctx: ActionCtx,
): ActionResult & { attempt: FiscalAttempt } {
  assertNotCancelled(order);
  assertOwnedLocally(order, ctx.deviceId, ctx.online);
  assertNoUnknownAttempt(order);
  if (order.state !== 'paid') {
    throw new OrderNotPaidError(remainingCents(order));
  }
  // Block if any card payment is unknown — must be resolved first.
  if (order.payments.some((p) => p.method === 'card' && p.status === 'unknown')) {
    throw new Error(
      'Există plată cu cardul cu status "unknown" — rezolvă-o înainte de fiscalizare.',
    );
  }
  assertCanTransition(order.state, 'fiscal_pending');

  const attemptId = ctx.ids.newId();
  const mutationId = ctx.ids.newMutationId();
  const attempt: FiscalAttempt = {
    id: attemptId,
    mutationId,
    orderLocalId: order.id,
    deviceId: ctx.deviceId,
    adapterId: cmd.adapterId,
    status: 'pending',
    fiscalNumber: null,
    errorCode: null,
    errorMessage: null,
    startedAt: ctx.clock.nowIso(),
    finishedAt: null,
  };
  const next: Order = {
    ...order,
    fiscalAttempts: [...order.fiscalAttempts, attempt],
    state: 'fiscal_pending',
  };
  return {
    next,
    attempt,
    events: [
      envelope<FiscalAttemptCreatedPayload>(
        ctx,
        next,
        'FISCAL_ATTEMPT_CREATED',
        { fiscalAttemptId: attemptId, adapterId: cmd.adapterId },
        mutationId,
      ),
    ],
  };
}

// ─── markFiscalPrinted ──────────────────────────────────────────────────────

export interface MarkFiscalPrintedCommand {
  attemptId: LocalId;
  fiscalNumber: string;
  fiscalDate: Iso;
  recoverySource?: 'device' | 'manual';
}

export function markFiscalPrinted(
  order: Order,
  cmd: MarkFiscalPrintedCommand,
  ctx: ActionCtx,
): ActionResult {
  const attempt = order.fiscalAttempts.find((a) => a.id === cmd.attemptId);
  if (!attempt) throw new Error(`fiscal attempt not found: ${cmd.attemptId}`);
  if (attempt.status === 'printed' || attempt.status === 'confirmed_failed') {
    throw new Error(`attempt already finalised: ${attempt.status}`);
  }
  assertCanTransition(order.state, 'fiscally_printed');
  const mutationId = ctx.ids.newMutationId();
  const recoverySource = cmd.recoverySource ?? 'device';
  const finishedAt = ctx.clock.nowIso();
  const next: Order = {
    ...order,
    state: 'fiscally_printed',
    fiscalAttempts: order.fiscalAttempts.map((a) =>
      a.id === cmd.attemptId
        ? { ...a, status: 'printed', fiscalNumber: cmd.fiscalNumber, finishedAt }
        : a,
    ),
    fiscalReceipt: {
      id: ctx.ids.newId(),
      mutationId,
      fiscalAttemptId: cmd.attemptId,
      orderLocalId: order.id,
      fiscalNumber: cmd.fiscalNumber,
      fiscalDate: cmd.fiscalDate,
      deviceId: ctx.deviceId,
      recoverySource,
      createdAt: finishedAt,
    },
  };
  return {
    next,
    events: [
      envelope<FiscalReceiptPrintedPayload>(
        ctx,
        next,
        'FISCAL_RECEIPT_PRINTED',
        {
          fiscalAttemptId: cmd.attemptId,
          fiscalNumber: cmd.fiscalNumber,
          fiscalDate: cmd.fiscalDate,
          recoverySource,
        },
        mutationId,
      ),
    ],
  };
}

// ─── markFiscalUnknown ──────────────────────────────────────────────────────

export interface MarkFiscalUnknownCommand {
  attemptId: LocalId;
  errorCode: string;
  errorMessage: string;
}

export function markFiscalUnknown(
  order: Order,
  cmd: MarkFiscalUnknownCommand,
  ctx: ActionCtx,
): ActionResult {
  const attempt = order.fiscalAttempts.find((a) => a.id === cmd.attemptId);
  if (!attempt) throw new Error(`fiscal attempt not found: ${cmd.attemptId}`);
  if (attempt.status !== 'pending') {
    throw new Error(`unexpected attempt status: ${attempt.status}`);
  }
  // Stay in fiscal_pending (manager must resolve manually).
  const mutationId = ctx.ids.newMutationId();
  const next: Order = {
    ...order,
    fiscalAttempts: order.fiscalAttempts.map((a) =>
      a.id === cmd.attemptId
        ? {
            ...a,
            status: 'unknown',
            errorCode: cmd.errorCode,
            errorMessage: cmd.errorMessage,
            finishedAt: ctx.clock.nowIso(),
          }
        : a,
    ),
  };
  return {
    next,
    events: [
      envelope<FiscalReceiptUnknownPayload>(
        ctx,
        next,
        'FISCAL_RECEIPT_UNKNOWN',
        {
          fiscalAttemptId: cmd.attemptId,
          errorCode: cmd.errorCode,
          errorMessage: cmd.errorMessage,
        },
        mutationId,
      ),
    ],
  };
}

// ─── closeOrder ─────────────────────────────────────────────────────────────

export function closeOrder(order: Order, ctx: ActionCtx): ActionResult {
  assertNotCancelled(order);
  // Allow closing from `paid` (no fiscal needed for non-fiscalised flows e.g.
  // staff meal) or `fiscally_printed` (the normal case).
  if (order.state !== 'paid' && order.state !== 'fiscally_printed') {
    throw new OrderNotPaidError(remainingCents(order));
  }
  assertCanTransition(order.state, 'closed');
  const mutationId = ctx.ids.newMutationId();
  const closedAt = ctx.clock.nowIso();
  const next: Order = { ...order, state: 'closed', closedAt };
  return {
    next,
    events: [
      envelope<OrderClosedPayload>(
        ctx,
        next,
        'ORDER_CLOSED',
        { closedAt },
        mutationId,
      ),
    ],
  };
}

// ─── cancelOrder ────────────────────────────────────────────────────────────

export interface CancelOrderCommand {
  reason: string;
}

export function cancelOrder(
  order: Order,
  cmd: CancelOrderCommand,
  ctx: ActionCtx,
): ActionResult {
  // Fiscalised guard runs first so the operator gets the precise message
  // ("bon fiscal emis") instead of the generic illegal-transition.
  assertNotFiscalised(order);
  assertCanTransition(order.state, 'cancelled');
  const mutationId = ctx.ids.newMutationId();
  const next: Order = { ...order, state: 'cancelled', closedAt: ctx.clock.nowIso() };
  return {
    next,
    events: [
      envelope<OrderCancelledPayload>(
        ctx,
        next,
        'ORDER_CANCELLED',
        { reason: cmd.reason },
        mutationId,
      ),
    ],
  };
}

// ─── re-exports for tests ───────────────────────────────────────────────────

export type { ServerId };
