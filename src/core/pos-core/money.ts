/**
 * Money utilities — integer cents only.
 *
 * Floats appear ONLY at the boundary (display, JSON I/O with the
 * backend / web frontend). Everything else uses integers.
 */

const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER; // 2^53 - 1

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Convert a float currency value (e.g. 12.5) to integer cents (1250). */
export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new MoneyError(`toCents: not finite (${amount})`);
  }
  // Round-half-up to align with backend's ROUND_HALF_UP in fiscal_service.py.
  const cents = Math.round(amount * 100);
  validateCents(cents);
  return cents;
}

/** Convert integer cents back to a float for DISPLAY ONLY. Never feed back into math. */
export function fromCents(cents: number): number {
  validateCents(cents);
  return cents / 100;
}

/** Throw if `cents` is not a finite, safe integer. */
export function validateCents(cents: number): void {
  if (!Number.isInteger(cents)) {
    throw new MoneyError(`cents must be an integer, got ${cents}`);
  }
  if (Math.abs(cents) > MAX_SAFE_CENTS) {
    throw new MoneyError(`cents overflow: ${cents}`);
  }
}

/** Add cents with overflow protection. Negative values allowed (refunds, voids). */
export function safeAddCents(...values: number[]): number {
  let acc = 0;
  for (const v of values) {
    validateCents(v);
    const next = acc + v;
    if (Math.abs(next) > MAX_SAFE_CENTS) {
      throw new MoneyError(`addCents overflow at ${acc} + ${v}`);
    }
    acc = next;
  }
  return acc;
}

/** Multiply integer cents by an integer quantity. */
export function safeMultiplyCents(unitCents: number, quantity: number): number {
  validateCents(unitCents);
  if (!Number.isInteger(quantity)) {
    throw new MoneyError(`quantity must be integer, got ${quantity}`);
  }
  if (quantity < 0) {
    throw new MoneyError(`quantity must be non-negative, got ${quantity}`);
  }
  // Pre-check overflow: |unit| * |qty| ≤ MAX
  if (quantity !== 0 && Math.abs(unitCents) > MAX_SAFE_CENTS / quantity) {
    throw new MoneyError(`multiplyCents overflow: ${unitCents} × ${quantity}`);
  }
  return unitCents * quantity;
}

/** Format integer cents as Romanian-style display string. Boundary only. */
export function formatMoney(
  cents: number,
  currency: 'RON' | 'EUR' | 'USD' = 'RON',
  locale: string = 'ro-RO',
): string {
  validateCents(cents);
  const formatted = (cents / 100).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} ${currency}`;
}
