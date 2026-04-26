import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  fromCents,
  MoneyError,
  safeAddCents,
  safeMultiplyCents,
  toCents,
  validateCents,
} from '../money';

describe('toCents / fromCents', () => {
  it('rounds half-up to match backend ROUND_HALF_UP', () => {
    expect(toCents(12.5)).toBe(1250);
    expect(toCents(12.005)).toBe(1201); // 12.005 → 1200.5 → 1201 (HALF_UP)
    expect(toCents(0)).toBe(0);
    expect(toCents(-3.14)).toBe(-314);
  });
  it('rejects non-finite', () => {
    expect(() => toCents(NaN)).toThrow(MoneyError);
    expect(() => toCents(Infinity)).toThrow(MoneyError);
  });
  it('round-trips display values', () => {
    expect(fromCents(1250)).toBe(12.5);
    expect(fromCents(0)).toBe(0);
  });
});

describe('validateCents', () => {
  it('rejects floats and overflows', () => {
    expect(() => validateCents(12.5)).toThrow(MoneyError);
    expect(() => validateCents(Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyError);
    expect(validateCents(0)).toBeUndefined();
    expect(validateCents(1250)).toBeUndefined();
  });
});

describe('safeAddCents', () => {
  it('adds many values', () => {
    expect(safeAddCents(100, 200, 300)).toBe(600);
    expect(safeAddCents()).toBe(0);
    expect(safeAddCents(1000, -300)).toBe(700);
  });
  it('throws on overflow', () => {
    expect(() => safeAddCents(Number.MAX_SAFE_INTEGER, 1)).toThrow(MoneyError);
  });
});

describe('safeMultiplyCents', () => {
  it('multiplies and pre-checks overflow', () => {
    expect(safeMultiplyCents(1250, 3)).toBe(3750);
    expect(safeMultiplyCents(1250, 0)).toBe(0);
    expect(() => safeMultiplyCents(1250, 1.5)).toThrow(MoneyError);
    expect(() => safeMultiplyCents(1250, -1)).toThrow(MoneyError);
    expect(() => safeMultiplyCents(Number.MAX_SAFE_INTEGER, 2)).toThrow(MoneyError);
  });
});

describe('formatMoney', () => {
  it('formats RON with Romanian locale', () => {
    expect(formatMoney(1250)).toMatch(/12,50.*RON/);
    expect(formatMoney(0)).toMatch(/0,00.*RON/);
  });
});
