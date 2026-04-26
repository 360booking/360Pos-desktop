import { describe, expect, it } from 'vitest';
import {
  backOutVat,
  pickRateForCategory,
  rateFromFloat,
  rateToFloat,
  ROMANIAN_DEFAULT_VAT_BP,
  validateRateBp,
  type TenantVatConfig,
} from '../vat';
import { MoneyError } from '../money';

describe('rate conversion', () => {
  it('converts float ↔ basis points', () => {
    expect(rateFromFloat(0.19)).toBe(1900);
    expect(rateFromFloat(0.09)).toBe(900);
    expect(rateFromFloat(0)).toBe(0);
    expect(rateToFloat(1900)).toBeCloseTo(0.19, 6);
  });
  it('rejects out-of-range', () => {
    expect(() => rateFromFloat(-0.01)).toThrow(MoneyError);
    expect(() => rateFromFloat(1.01)).toThrow(MoneyError);
    expect(() => validateRateBp(-1)).toThrow(MoneyError);
    expect(() => validateRateBp(10_001)).toThrow(MoneyError);
    expect(() => validateRateBp(1.5)).toThrow(MoneyError);
  });
});

describe('pickRateForCategory', () => {
  const cfg: TenantVatConfig = { defaultRateBp: 1900, foodRateBp: 900, barRateBp: 1900 };
  it('picks bar / restaurant overrides', () => {
    expect(pickRateForCategory(cfg, 'bar')).toBe(1900);
    expect(pickRateForCategory(cfg, 'restaurant')).toBe(900);
    expect(pickRateForCategory(cfg, 'other')).toBe(1900);
    expect(pickRateForCategory(cfg, null)).toBe(1900);
  });
  it('falls back to default when override missing', () => {
    const partial: TenantVatConfig = { defaultRateBp: ROMANIAN_DEFAULT_VAT_BP };
    expect(pickRateForCategory(partial, 'bar')).toBe(1900);
    expect(pickRateForCategory(partial, 'restaurant')).toBe(1900);
  });
});

describe('backOutVat — parity with backend fiscal_service.compute_vat_breakdown', () => {
  it('matches backend examples (gross, rate) → (net, vat)', () => {
    // 1190 cents @ 19% → net 1000, vat 190 (textbook).
    expect(backOutVat(1190, 1900)).toEqual({ netCents: 1000, vatCents: 190 });
    // 109 cents @ 9% → net 100, vat 9.
    expect(backOutVat(109, 900)).toEqual({ netCents: 100, vatCents: 9 });
    // 0 rate → all net, no vat.
    expect(backOutVat(1234, 0)).toEqual({ netCents: 1234, vatCents: 0 });
    // 0 gross → 0/0.
    expect(backOutVat(0, 1900)).toEqual({ netCents: 0, vatCents: 0 });
  });
  it('rounds half-up to keep net+vat = gross exactly', () => {
    // Pick a value that triggers a rounding decision.
    const { netCents, vatCents } = backOutVat(1995, 1900); // 19% on 1995
    expect(netCents + vatCents).toBe(1995);
  });
  it('rejects non-integer gross or invalid rate', () => {
    expect(() => backOutVat(12.5, 1900)).toThrow(MoneyError);
    expect(() => backOutVat(1190, 99999)).toThrow(MoneyError);
  });
});
