import { describe, expect, it } from 'vitest';
import { backoffMs, nextRetryIso } from '../backoff';

describe('backoff schedule', () => {
  it('matches the documented ladder', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(5_000);
    expect(backoffMs(3)).toBe(30_000);
    expect(backoffMs(4)).toBe(120_000);
    expect(backoffMs(5)).toBe(600_000);
  });
  it('caps at 1h after step 5', () => {
    expect(backoffMs(6)).toBe(60 * 60 * 1_000);
    expect(backoffMs(50)).toBe(60 * 60 * 1_000);
  });
  it('nextRetryIso adds backoff to a base ISO', () => {
    const base = '2026-04-25T12:00:00.000Z';
    expect(nextRetryIso(base, 1)).toBe('2026-04-25T12:00:01.000Z');
    expect(nextRetryIso(base, 3)).toBe('2026-04-25T12:00:30.000Z');
  });
});
