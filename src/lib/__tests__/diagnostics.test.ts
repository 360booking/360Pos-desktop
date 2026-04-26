import { describe, expect, it } from 'vitest';
import { maskSecrets } from '../diagnostics';

describe('maskSecrets', () => {
  it('passes plain values through untouched', () => {
    expect(maskSecrets('hello')).toBe('hello');
    expect(maskSecrets(42)).toBe(42);
    expect(maskSecrets(null)).toBe(null);
    expect(maskSecrets(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('redacts JWT-like values', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.signature_part_here_long_enough';
    const masked = maskSecrets(jwt) as string;
    expect(masked).toContain('<jwt>');
    expect(masked).not.toContain('signature_part_here');
    // Head + tail still visible so support can tell distinct tokens apart.
    expect(masked.startsWith('eyJhbG')).toBe(true);
  });

  it('redacts long opaque strings', () => {
    const opaque = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'; // 46 chars
    const masked = maskSecrets(opaque) as string;
    expect(masked).toContain('<redacted>');
    expect(masked).not.toContain('lmnopqrstuvwxyz');
  });

  it('redacts known-sensitive object keys regardless of value shape', () => {
    const out = maskSecrets({
      deviceId: 'POS-01',
      deviceToken: 'short-but-still-a-token',
      jwt: 'whatever',
      authorization: 'Bearer xyz',
      password: 'hunter2',
      backendUrl: 'https://360booking.ro',
    }) as Record<string, unknown>;
    expect(out.deviceId).toBe('POS-01');
    expect(String(out.deviceToken)).toContain('<redacted>');
    expect(String(out.jwt)).toContain('<redacted>');
    expect(String(out.authorization)).toContain('<redacted>');
    expect(String(out.password)).toContain('<redacted>');
    expect(out.backendUrl).toBe('https://360booking.ro');
  });

  it('recurses into nested objects + arrays', () => {
    const out = maskSecrets({
      a: { token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      b: [{ secret: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
    }) as { a: { token: string }; b: Array<{ secret: string }> };
    expect(out.a.token).toContain('<redacted>');
    expect(out.b[0].secret).toContain('<redacted>');
  });
});
