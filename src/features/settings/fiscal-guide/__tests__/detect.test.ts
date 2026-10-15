import { describe, expect, it } from 'vitest';

import {
  detectProgressText,
  registerChips,
  summariseDetect,
  type DetectReport,
  type RegisterStatus,
} from '../logic';

function report(over: Partial<DetectReport> = {}): DetectReport {
  return {
    ports_seen: 2,
    found: null,
    saved: false,
    save_error: null,
    tried: [],
    not_tried: [],
    excluded: [],
    cancelled: false,
    included_others: false,
    ...over,
  };
}

const FOUND = {
  port: 'COM4',
  label: 'COM4 — USB Serial Device',
  baud: 115200,
  dialect: 'fp55',
  vid: 0x2222,
  pid: 0x3333,
  product: 'USB Serial Device (COM4)',
  manufacturer: null,
  notice: null,
  reply_hex: '30 09',
};

describe('summariseDetect', () => {
  it('found and saved', () => {
    const s = summariseDetect(report({ found: FOUND, saved: true, tried: [] }));
    expect(s.ok).toBe(true);
    expect(s.title).toBe('Am găsit casa pe COM4 — USB Serial Device (viteza 115200) și am salvat setările.');
    expect(s.askOthers).toBe(false);
  });

  it('found with a notice from the register', () => {
    const s = summariseDetect(report({ found: { ...FOUND, notice: 'Hârtia din casă e pe terminate' }, saved: true }));
    expect(s.notice).toMatch(/pe terminate/);
  });

  it('found but not saved', () => {
    const s = summariseDetect(report({ found: FOUND, saved: false, save_error: 'sqlite busy' }));
    expect(s.ok).toBe(false);
    expect(s.title).toMatch(/nu am putut salva/);
  });

  it('no ports at all', () => {
    expect(summariseDetect(report({ ports_seen: 0 })).title).toMatch(/niciun port COM/);
  });

  it('only unlikely ports: asks before trying them', () => {
    const s = summariseDetect(
      report({ not_tried: [{ port: 'COM1', label: 'COM1', class: 'other', reason: 'port COM al calculatorului' }] }),
    );
    expect(s.askOthers).toBe(true);
    expect(s.title).toMatch(/nu seamănă/);
    expect(s.checks.join(' ')).toMatch(/Portul COM1 nu seamănă/);
    expect(s.checks.join(' ')).toMatch(/Bluetooth/);
  });

  it('silent likely ports + others left: offers the others', () => {
    const s = summariseDetect(
      report({
        tried: [{ port: 'COM5', label: 'COM5', class: 'usb_serial', outcome: 'silent', attempts: 10, detail: 'frame timeout' }],
        not_tried: [
          { port: 'COM1', label: 'COM1', class: 'other', reason: '' },
          { port: 'COM6', label: 'COM6', class: 'other', reason: '' },
        ],
      }),
    );
    expect(s.title).toBe('Casa nu a răspuns pe niciun port.');
    expect(s.askOthers).toBe(true);
    expect(s.checks.join(' ')).toMatch(/Porturile COM1, COM6/);
  });

  it('refusing and busy ports', () => {
    expect(
      summariseDetect(report({ tried: [{ port: 'COM5', label: 'COM5', class: 'usb_serial', outcome: 'refuses', attempts: 10, detail: 'NAK' }] }))
        .title,
    ).toMatch(/refuză comenzile/);
    expect(
      summariseDetect(report({ tried: [{ port: 'COM5', label: 'COM5', class: 'saved', outcome: 'busy', attempts: 1, detail: 'Access is denied' }] }))
        .title,
    ).toMatch(/folosit de alt program/);
  });

  it('cancelled', () => {
    expect(summariseDetect(report({ cancelled: true })).title).toMatch(/oprită/);
  });
});

describe('detectProgressText', () => {
  it('names the port and says nothing is printed', () => {
    const t = detectProgressText({ port: 'COM4', label: 'COM4 — Datecs', baud: 9600, dialect: 'fp55', port_index: 2, port_total: 3 });
    expect(t.title).toBe('Încerc COM4 — Datecs la 9600…');
    expect(t.sub).toMatch(/Portul 2 din 3/);
    expect(t.sub).toMatch(/nu tipăresc/);
  });
});

function reg(over: Partial<RegisterStatus> = {}): RegisterStatus {
  return {
    state: 'ok',
    connected: true,
    paperOut: false,
    paperNearEnd: false,
    coverOpen: false,
    fiscalMemoryNearFull: false,
    fiscalMemoryError: false,
    zReportRequired: false,
    printerError: false,
    receiptOpen: false,
    message: null,
    codes: [],
    checkedAt: 1,
    ...over,
  };
}

describe('registerChips', () => {
  it('nothing when all is well or unknown', () => {
    expect(registerChips(reg())).toEqual([]);
    expect(registerChips(null)).toEqual([]);
    expect(registerChips(undefined)).toEqual([]);
  });

  it('blocking problems first, warnings after', () => {
    const chips = registerChips(reg({ state: 'blocked', paperNearEnd: true, coverOpen: true, zReportRequired: true }));
    expect(chips.map((c) => c.text)).toEqual(['capac deschis', 'raport Z necesar', 'hârtie pe terminate']);
    expect(chips[0].tone).toBe('bad');
    expect(chips[2].tone).toBe('wait');
  });

  it('paper out, memory, printer error, open receipt', () => {
    const t = registerChips(
      reg({ state: 'blocked', paperOut: true, printerError: true, fiscalMemoryError: true, fiscalMemoryNearFull: true, receiptOpen: true }),
    ).map((c) => c.text);
    expect(t).toEqual([
      'fără hârtie',
      'eroare imprimantă',
      'memorie fiscală: service',
      'memorie fiscală aproape plină',
      'bon rămas deschis',
    ]);
  });

  it('no answer', () => {
    expect(registerChips(reg({ state: 'no_answer', connected: false })).map((c) => c.text)).toEqual(['nu răspunde']);
    expect(registerChips(reg({ state: 'no_answer', connected: false, zReportRequired: true })).length).toBe(2);
  });
});
