/**
 * VAT helpers — rate is integer basis points to avoid floats.
 *
 * Backend source of truth (verified Sprint 1):
 *   /opt/360booking/backend/src/services/fiscal_service.py
 * - Rates are PER-TENANT, not per-product. No A/B/C/D/E enum.
 * - Tenant config: { defaultRate, foodRate?, barRate? }, derived from
 *   restaurants.pos_config_json.fiscal.{vat_rate, vat_rate_food, vat_rate_bar}.
 * - Category type === 'bar' → barRate; 'restaurant' → foodRate; else default.
 * - Prices on menu items are GROSS (VAT-inclusive); VAT is backed out via
 *   gross / (1 + rate). See fiscal_service.compute_vat_breakdown().
 */
import { MoneyError } from './money';

export type CategoryType = 'restaurant' | 'bar' | 'other';

/** Integer basis points: 1900 = 19%. Bounded 0..10_000 (0%..100%). */
export type VatRateBp = number;

export interface TenantVatConfig {
  /** Default rate (bp). 1900 = 19% — Romanian standard. */
  defaultRateBp: VatRateBp;
  /** Override for menu category type === 'restaurant'. */
  foodRateBp?: VatRateBp;
  /** Override for menu category type === 'bar'. */
  barRateBp?: VatRateBp;
}

export const ROMANIAN_DEFAULT_VAT_BP = 1900; // 19%

export function rateFromFloat(rate: number): VatRateBp {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new MoneyError(`VAT rate must be in [0, 1], got ${rate}`);
  }
  return Math.round(rate * 10_000);
}

export function rateToFloat(rateBp: VatRateBp): number {
  validateRateBp(rateBp);
  return rateBp / 10_000;
}

export function validateRateBp(rateBp: number): void {
  if (!Number.isInteger(rateBp)) {
    throw new MoneyError(`VAT rate must be integer bp, got ${rateBp}`);
  }
  if (rateBp < 0 || rateBp > 10_000) {
    throw new MoneyError(`VAT rate bp out of [0, 10000]: ${rateBp}`);
  }
}

/**
 * Pick the rate for a category type, mirroring fiscal_service.py:229–246.
 * Falls back to the default when the type-specific override is undefined.
 */
export function pickRateForCategory(
  cfg: TenantVatConfig,
  categoryType: CategoryType | null | undefined,
): VatRateBp {
  if (categoryType === 'bar' && cfg.barRateBp != null) return cfg.barRateBp;
  if (categoryType === 'restaurant' && cfg.foodRateBp != null) return cfg.foodRateBp;
  return cfg.defaultRateBp;
}

/**
 * Back out VAT from a GROSS amount in cents.
 * Mirrors fiscal_service.compute_vat_breakdown():
 *   net = gross / (1 + rate);  vat = gross - net.
 *
 * Both results are integer cents, ROUND_HALF_UP — matches backend.
 */
export function backOutVat(
  grossCents: number,
  rateBp: VatRateBp,
): { netCents: number; vatCents: number } {
  validateRateBp(rateBp);
  if (!Number.isInteger(grossCents)) {
    throw new MoneyError(`grossCents must be integer, got ${grossCents}`);
  }
  if (rateBp === 0) {
    return { netCents: grossCents, vatCents: 0 };
  }
  // gross / (1 + r) where r = rateBp / 10000
  // = gross * 10000 / (10000 + rateBp)
  const denom = 10_000 + rateBp;
  const numer = grossCents * 10_000;
  const netCents = Math.round(numer / denom); // ROUND_HALF_UP via Math.round
  const vatCents = grossCents - netCents;
  return { netCents, vatCents };
}
