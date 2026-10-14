/**
 * 2026-10-14 („o singură cale”): the guide says WHY the agent can't reach
 * the server, and step 2 stops saying „Stația e legată ✓” once the token was
 * revoked from the admin.
 */
import { describe, expect, it } from 'vitest';

import { REVOKED_TEXT, deriveSteps, explainConnectionError, linkSummary } from '../logic';

describe('explainConnectionError', () => {
  it('names a TLS / certificate failure (the till PC without ISRG roots)', () => {
    const t = explainConnectionError(
      'IO error: invalid peer certificate: UnknownIssuer',
    );
    expect(t).toMatch(/certificat/);
  });

  it('maps a revoked token to „leagă din nou”', () => {
    expect(explainConnectionError('auth rejected HTTP 403')).toMatch(/anulată din admin/);
    expect(explainConnectionError('configuration error: device_token revoked — re-enroll required')).toMatch(
      /cod nou/,
    );
  });

  it('maps DNS, refused, timeout and no network', () => {
    expect(explainConnectionError('error trying to connect: dns error: failed to lookup address')).toMatch(/DNS/);
    expect(explainConnectionError('IO error: No connection could be made (os error 10061) refused')).toMatch(
      /refuzat/,
    );
    expect(explainConnectionError('IO error: timed out')).toMatch(/nu răspunde/);
    expect(explainConnectionError('Network is unreachable (os error 10051)')).toMatch(/internet/);
  });

  it('keeps an unknown error readable (shortened)', () => {
    expect(explainConnectionError('')).toBe('motiv necunoscut');
    expect(explainConnectionError('ceva ciudat')).toBe('ceva ciudat');
    expect(explainConnectionError('x'.repeat(400)).length).toBeLessThanOrEqual(161);
  });
});

describe('revoked link', () => {
  const base = {
    configSaved: true,
    provider: 'datecs_dp25',
    serialPort: 'COM4',
    printerOk: true,
    enrolled: true,
    connected: false,
    testDone: true,
  };

  it('step 2 turns into an error, not a green ✓', () => {
    expect(deriveSteps({ ...base, revoked: true }).steps[1]).toBe('error');
    expect(deriveSteps({ ...base, revoked: false }).steps[1]).toBe('warn');
    expect(deriveSteps({ ...base, connected: true, revoked: false }).steps[1]).toBe('done');
  });

  it('summary says the link was cancelled from the admin', () => {
    expect(linkSummary(true, false, true, true)).toEqual({ text: 'anulată din admin', tone: 'bad' });
    // Connected wins (a new enrolment already reconnected).
    expect(linkSummary(true, true, true, true).tone).toBe('ok');
    expect(REVOKED_TEXT).toBe('Legătura a fost anulată din admin — leagă din nou');
  });
});
