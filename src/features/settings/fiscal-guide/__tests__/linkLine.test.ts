import { describe, expect, it } from 'vitest';

import { LINK_FROM_POS_TEXT, REVOKED_TEXT, explainConnectionError, linkLine, type AutoLinkState } from '../logic';

const base = { enrolled: false, connected: false, running: false, revoked: false, auto: null as AutoLinkState | null };
const auto = (state: string, error: string | null = null): AutoLinkState => ({ state, at: 1, error, bridgeId: null });

describe('„Legare” line (automatic link, was step 2)', () => {
  it('linked and connected: nothing to do', () => {
    const l = linkLine({ ...base, enrolled: true, connected: true, running: true });
    expect(l).toMatchObject({ tone: 'ok', action: 'none' });
    expect(l.text).toMatch(/Legată de restaurant/);
  });

  it('linked, agent still connecting or offline', () => {
    expect(linkLine({ ...base, enrolled: true, running: true }).tone).toBe('wait');
    const off = linkLine({ ...base, enrolled: true });
    expect(off.tone).toBe('bad');
    expect(off.hint).toMatch(/Reconectează acum/);
  });

  it('opened on its own (Ctrl+Shift+F) and not linked: points to the POS, no button', () => {
    const l = linkLine(base);
    expect(l.action).toBe('none');
    expect(l.hint).toContain(LINK_FROM_POS_TEXT);
    expect(l.hint).toContain('se face automat');
  });

  it('opened from the admin page and the link failed: shows why + retry', () => {
    const l = linkLine({ ...base, auto: auto('error', 'Codul de legare a expirat.') });
    expect(l).toMatchObject({ action: 'retry', tone: 'bad', text: 'Codul de legare a expirat.' });
    expect(l.hint).toMatch(/se face automat/);
  });

  it('linking right now', () => {
    expect(linkLine({ ...base, auto: auto('linking') })).toMatchObject({ tone: 'wait', action: 'none' });
  });

  it('revoked from the admin: never says „legată”', () => {
    const standalone = linkLine({ ...base, enrolled: true, revoked: true });
    expect(standalone.text).toBe(REVOKED_TEXT);
    expect(standalone.action).toBe('none');
    expect(linkLine({ ...base, enrolled: true, revoked: true, auto: auto('ok') }).action).toBe('retry');
  });

  it('plain words: no „stație”, „bridge” or „agent” in what the owner reads', () => {
    const texts = [
      linkLine(base),
      linkLine({ ...base, enrolled: true }),
      linkLine({ ...base, enrolled: true, connected: true }),
      linkLine({ ...base, auto: auto('error', null) }),
      linkLine({ ...base, enrolled: true, revoked: true }),
    ].flatMap((l) => [l.text, l.hint ?? '']);
    texts.push(explainConnectionError('auth rejected 4001'));
    for (const t of texts) expect(t).not.toMatch(/stați|bridge|agent/i);
  });
});
