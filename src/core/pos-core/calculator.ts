/**
 * Order calculator.
 *
 * Mirrors backend src/services/restaurant_order_service.py:_recalculate_totals
 * (verified Sprint 1):
 *
 *     subtotal      = Σ line_total                      (gross / VAT-inclusive)
 *     total         = subtotal − discount + tax + tip   (tax stays 0 today; kept for parity)
 *     vat_total     = back-out from `total` per line at issue_receipt time
 *
 * pos-core differences (documented in fiscal-flow.md):
 *  - We compute a *running* `vatCents` per line so the cart can show the
 *    fiscal split BEFORE issuing the receipt (backend cannot today; this
 *    is one of the inconsistencies we logged).
 *  - We do NOT include `tip` in the VAT base, matching the comment in
 *    backend `restaurant.py:889` even though the backend currently does.
 *    Documented as a *deliberate* delta in docs/fiscal-flow.md.
 *  - All math is integer cents.
 */
import type { Order, OrderItem, Payment } from './types';
import { safeAddCents, safeMultiplyCents, validateCents } from './money';
import { backOutVat, type VatRateBp } from './vat';

export interface OrderTotals {
  subtotalCents: number;
  discountCents: number;
  tipCents: number;
  vatCents: number;
  totalCents: number;
  paidCents: number;
  remainingCents: number;
  changeDueCents: number;
}

export function lineTotalCents(unitPriceCents: number, quantity: number): number {
  return safeMultiplyCents(unitPriceCents, quantity);
}

/** Active items only — voided items are excluded from totals. */
export function activeItems(order: Order): OrderItem[] {
  return order.items.filter((it) => it.voidedAt == null);
}

/**
 * Sum of (line_total) over active items. Mirrors backend _recalculate_totals.
 */
export function subtotalCents(order: Order): number {
  return safeAddCents(
    ...activeItems(order).map((it) => it.lineTotalCents),
  );
}

/**
 * VAT estimative — back out per line so the cart can preview the split.
 *
 * Each item carries its own vatRateBp (snapshotted at insert time), so a
 * mixed-rate order (food + bar) sums correctly. Discount reduces VAT
 * proportionally; tip is excluded from VAT.
 */
export function vatCents(order: Order): number {
  const items = activeItems(order);
  if (items.length === 0) return 0;

  const subtotal = subtotalCents(order);
  if (subtotal === 0) return 0;

  // Allocate the order-level discount proportionally per line, then back
  // out VAT per (discounted) line. Stays integer-safe: we use floor +
  // remainder to ensure the parts sum back to the discounted subtotal.
  const discount = order.discountCents;
  const discountedLines = allocateDiscount(items, subtotal, discount);

  let vat = 0;
  for (let i = 0; i < items.length; i++) {
    const grossAfterDiscount = discountedLines[i];
    const { vatCents: lineVat } = backOutVat(grossAfterDiscount, items[i].vatRateBp);
    vat = safeAddCents(vat, lineVat);
  }
  return vat;
}

/**
 * Allocate `discount` across line items proportionally to their gross share.
 * Sum(allocated) === subtotal − discount, exactly (no float drift).
 *
 * Strategy: floor-allocate per line, then sprinkle the remainder cent-by-cent
 * onto the largest lines until the total matches.
 */
export function allocateDiscount(
  items: OrderItem[],
  subtotal: number,
  discount: number,
): number[] {
  validateCents(subtotal);
  validateCents(discount);
  if (discount <= 0 || subtotal === 0) {
    return items.map((it) => it.lineTotalCents);
  }
  const cappedDiscount = Math.min(discount, subtotal);
  const target = subtotal - cappedDiscount;

  // Floor-allocated discounted lines.
  const floored: number[] = items.map((it) =>
    Math.floor((it.lineTotalCents * target) / subtotal),
  );
  let allocated = floored.reduce((a, b) => a + b, 0);

  // Distribute the remaining 0..items.length cents onto items ranked by
  // their fractional remainder (largest first), stable on original index.
  const ranked = items
    .map((it, idx) => ({
      idx,
      frac: (it.lineTotalCents * target) % subtotal,
    }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);

  let i = 0;
  while (allocated < target && i < ranked.length) {
    floored[ranked[i].idx] += 1;
    allocated += 1;
    i += 1;
  }
  return floored;
}

export function tipCents(order: Order): number {
  return order.tipCents;
}

/**
 * total = max(0, subtotal − discount) + tip
 * (Backend adds `tax_total` here too, but tax_total is always 0 today — see
 * fiscal_service.py audit notes.)
 */
export function totalCents(order: Order): number {
  const sub = subtotalCents(order);
  const afterDiscount = Math.max(0, sub - order.discountCents);
  return safeAddCents(afterDiscount, order.tipCents);
}

export function paidCents(order: Order): number {
  // Only successful payments count toward "paid". Recorded cash and approved
  // card are authoritative; declined/cancelled/unknown do NOT.
  return safeAddCents(
    ...order.payments
      .filter((p) => p.status === 'recorded' || p.status === 'approved')
      .map((p) => p.amountCents),
  );
}

export function remainingCents(order: Order): number {
  const total = totalCents(order);
  const paid = paidCents(order);
  return Math.max(0, total - paid);
}

/** Positive when over-tendered (cash payment with change due). */
export function changeDueCents(order: Order): number {
  const total = totalCents(order);
  const paid = paidCents(order);
  return Math.max(0, paid - total);
}

export function computeTotals(order: Order): OrderTotals {
  return {
    subtotalCents: subtotalCents(order),
    discountCents: order.discountCents,
    tipCents: order.tipCents,
    vatCents: vatCents(order),
    totalCents: totalCents(order),
    paidCents: paidCents(order),
    remainingCents: remainingCents(order),
    changeDueCents: changeDueCents(order),
  };
}

/** Returns a new Order with cached totals refreshed. Pure. */
export function withRefreshedTotals(order: Order): Order {
  return {
    ...order,
    subtotalCents: subtotalCents(order),
    vatCents: vatCents(order),
    totalCents: totalCents(order),
  };
}

/** Sum a payments array — useful for invariants in actions. */
export function sumPayments(payments: Payment[]): number {
  return safeAddCents(
    ...payments
      .filter((p) => p.status === 'recorded' || p.status === 'approved')
      .map((p) => p.amountCents),
  );
}

export type { VatRateBp };
