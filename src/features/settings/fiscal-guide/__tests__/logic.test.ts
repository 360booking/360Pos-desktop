import { describe, expect, it } from 'vitest';

import type { FiscalRuntimeConfig } from '@/adapters/fiscal/runtime-config';

import {
  TILL_MODELS,
  buildRuntimeConfig,
  classifyProbe,
  completeOnOpen,
  defaultsForModel,
  deriveSteps,
  explainClaimError,
  explainFiscalError,
  formFromConfig,
  formProblem,
  groupARate,
  isoToDdmmyy,
  periodicRangeProblem,
  previousMonthRange,
  linkSummary,
  modelFromConfig,
  normaliseEnrollmentCode,
  orderPortsForSearch,
  portLabel,
  printerAnswer,
  printerNotice,
  probeToForm,
  summariseSearch,
  tillSummary,
  vatLabel,
  type GuideStatusInput,
  type ProbeReport,
} from '../logic';

const baseCfg = (over: Partial<FiscalRuntimeConfig> = {}): FiscalRuntimeConfig => ({
  provider: 'simulator',
  serial_port: null,
  baud: 9600,
  protocol_variant: 'fp55',
  operator: '1',
  operator_password: '0001',
  printer_model: null,
  use_rust: false,
  enable_raw_logs: false,
  vat_map_json: null,
  cmd_codes_json: null,
  ...over,
});

const status = (over: Partial<GuideStatusInput> = {}): GuideStatusInput => ({
  configSaved: false,
  provider: 'simulator',
  serialPort: null,
  printerOk: null,
  enrolled: false,
  connected: false,
  testDone: false,
  ...over,
});

const report = (over: Partial<ProbeReport> = {}): ProbeReport => ({
  port: 'COM4',
  configured_baud: 115200,
  attempts: [],
  recommended_dialect: null,
  recommended_baud: null,
  all_nak_hint: false,
  ...over,
});

describe('models + defaults', () => {
  it('offers DP-25X / DP-25 / DP-150X, others greyed out', () => {
    const supported = TILL_MODELS.filter((m) => m.supported).map((m) => m.label);
    expect(supported).toEqual(['Datecs DP-25X', 'Datecs DP-25', 'Datecs DP-150X']);
    expect(TILL_MODELS.filter((m) => !m.supported).every((m) => m.provider === null)).toBe(true);
    expect(TILL_MODELS.filter((m) => m.supported).every((m) => m.provider === 'datecs_dp25')).toBe(true);
  });

  it('prefills the values verified on the owner DP-25X', () => {
    const f = defaultsForModel('dp25x');
    expect(f).toMatchObject({ baud: 115200, protocol_variant: 'fp55', operator: '1', operator_password: '0001' });
    expect(defaultsForModel('dp150x').operator_password).toBe('0001');
    expect(defaultsForModel('dp25').baud).toBe(115200);
  });

  it('keeps the chosen port and a service-set password when switching model', () => {
    const f = defaultsForModel('dp25', { serial_port: 'COM4', operator: '3', operator_password: '7777' });
    expect(f).toMatchObject({ modelId: 'dp25', serial_port: 'COM4', operator: '3', operator_password: '7777' });
    // factory passwords are replaced by the model default
    expect(defaultsForModel('dp25x', { operator_password: '0000' }).operator_password).toBe('0001');
  });

  it('recognises the model from a saved config', () => {
    expect(modelFromConfig(baseCfg())).toBeNull();
    expect(modelFromConfig(baseCfg({ provider: 'datecs_dp25' }))).toBe('dp25x');
    expect(modelFromConfig(baseCfg({ provider: 'datecs_dp25', printer_model: 'Datecs DP-150X' }))).toBe('dp150x');
    expect(modelFromConfig(baseCfg({ provider: 'datecs_fp' }))).toBeNull();
  });

  it('loads a saved Datecs config as-is and a fresh install with DP-25X defaults', () => {
    const saved = formFromConfig(baseCfg({ provider: 'datecs_dp25', serial_port: 'COM4', baud: 115200, operator_password: '0001', updated_at: 'x' }));
    expect(saved).toMatchObject({ modelId: 'dp25x', serial_port: 'COM4', baud: 115200 });
    const fresh = formFromConfig(null);
    expect(fresh).toMatchObject({ modelId: null, serial_port: null, baud: 115200, operator: '1', operator_password: '0001' });
  });
});

describe('buildRuntimeConfig — same table, same fields', () => {
  it('writes provider, port, baud, dialect, operator, model and keeps the rest', () => {
    const base = baseCfg({ vat_map_json: '{"A":0.21}', cmd_codes_json: '{"x":1}', enable_raw_logs: true });
    const out = buildRuntimeConfig(base, { ...defaultsForModel('dp25x'), serial_port: 'COM4' });
    expect(out).toEqual({
      ...base,
      provider: 'datecs_dp25',
      serial_port: 'COM4',
      baud: 115200,
      protocol_variant: 'fp55',
      operator: '1',
      operator_password: '0001',
      printer_model: 'Datecs DP-25X',
      use_rust: true,
    });
  });

  it('never writes an empty operator or password', () => {
    const out = buildRuntimeConfig(baseCfg(), { ...defaultsForModel('dp25x'), serial_port: 'COM3', operator: ' ', operator_password: '' });
    expect(out.operator).toBe('1');
    expect(out.operator_password).toBe('0001');
  });

  it('blocks saving without model or port', () => {
    expect(formProblem(formFromConfig(null))).toMatch(/modelul/);
    expect(formProblem(defaultsForModel('dp25x'))).toMatch(/Caută casa automat/);
    expect(formProblem({ ...defaultsForModel('dp25x'), serial_port: 'COM4' })).toBeNull();
    expect(formProblem({ ...defaultsForModel('tremol'), serial_port: 'COM4' })).toMatch(/nu e suportată/);
  });
});

describe('step state', () => {
  it('fresh install → step 1', () => {
    const s = deriveSteps(status());
    expect(s.steps).toEqual(['todo', 'todo', 'todo']);
    expect(s.current).toBe(1);
  });

  it('till saved and answering → step 2', () => {
    const s = deriveSteps(status({ configSaved: true, provider: 'datecs_dp25', serialPort: 'COM4', printerOk: true }));
    expect(s.steps[0]).toBe('done');
    expect(s.current).toBe(2);
  });

  it('till saved but not answering → step 1 in error', () => {
    const s = deriveSteps(status({ configSaved: true, provider: 'datecs_dp25', serialPort: 'COM4', printerOk: false }));
    expect(s.steps[0]).toBe('error');
    expect(s.current).toBe(1);
  });

  it('unknown answer (not monitored yet) does not block', () => {
    expect(deriveSteps(status({ configSaved: true, provider: 'datecs_dp25', serialPort: 'COM4' })).steps[0]).toBe('done');
  });

  it('simulator is never a configured till', () => {
    expect(deriveSteps(status({ configSaved: true, provider: 'simulator', serialPort: 'COM4', printerOk: true })).current).toBe(1);
  });

  it('enrolled but offline → step 2 warns', () => {
    const s = deriveSteps(status({ configSaved: true, provider: 'datecs_dp25', serialPort: 'COM4', enrolled: true }));
    expect(s.steps[1]).toBe('warn');
    expect(s.current).toBe(2);
  });

  it('enrolled + connected → step 3, then done after the test bill', () => {
    const ready = status({ configSaved: true, provider: 'datecs_dp25', serialPort: 'COM4', printerOk: true, enrolled: true, connected: true });
    expect(deriveSteps(ready).current).toBe(3);
    expect(deriveSteps({ ...ready, testDone: true })).toEqual({ steps: ['done', 'done', 'done'], current: 'done' });
  });

  it('opens on the summary only when configured and enrolled', () => {
    const base = { configSaved: true, provider: 'datecs_dp25', serialPort: 'COM4', enrolled: true };
    expect(completeOnOpen(base)).toBe(true);
    expect(completeOnOpen({ ...base, enrolled: false })).toBe(false);
    expect(completeOnOpen({ ...base, serialPort: null })).toBe(false);
    expect(completeOnOpen({ ...base, provider: 'simulator' })).toBe(false);
  });
});

describe('summary labels', () => {
  it('prefers the most recent of watchdog and local test', () => {
    expect(printerAnswer(null, null)).toBeNull();
    expect(printerAnswer({ monitored: false, online: true, lastCheckAt: 10 }, null)).toBeNull();
    expect(printerAnswer({ monitored: true, online: false, lastCheckAt: 10 }, { ok: true, at: 20 })).toBe(true);
    expect(printerAnswer({ monitored: true, online: false, lastCheckAt: 30 }, { ok: true, at: 20 })).toBe(false);
  });

  it('shows what the answering register reports about itself', () => {
    const h = (over: Partial<{ monitored: boolean; online: boolean | null; lastError: string | null }>) => ({
      monitored: true,
      online: true,
      lastCheckAt: 10,
      lastError: null,
      ...over,
    });
    expect(printerNotice(null)).toBeNull();
    expect(printerNotice(h({}))).toBeNull();
    expect(printerNotice(h({ lastError: 'Casa nu mai are hârtie — pune o rolă nouă și închide capacul.' }))).toBe(
      'Casa nu mai are hârtie — pune o rolă nouă și închide capacul.',
    );
    // Not answering: the connection error belongs to the other line.
    expect(printerNotice(h({ online: false, lastError: 'Portul COM4 nu mai există' }))).toBeNull();
    expect(printerNotice(h({ monitored: false, lastError: 'x' }))).toBeNull();
  });

  it('words the till and link state plainly', () => {
    expect(tillSummary(false, null).text).toBe('neconfigurată');
    expect(tillSummary(true, true)).toEqual({ text: 'răspunde', tone: 'ok' });
    expect(tillSummary(true, false)).toEqual({ text: 'nu răspunde', tone: 'bad' });
    expect(linkSummary(false, false, false).text).toBe('nelegată');
    expect(linkSummary(true, true, true)).toEqual({ text: 'conectată', tone: 'ok' });
    expect(linkSummary(true, false, true).tone).toBe('wait');
    for (const s of [tillSummary(true, null), linkSummary(true, false, false)]) {
      expect(s.text).not.toMatch(/rust|wss|sidecar|backend/i);
    }
  });
});

describe('ports + probe', () => {
  it('labels ports with the Windows product name', () => {
    expect(portLabel({ name: 'COM4', kind: 'usb', product: 'USB Serial Device (COM4)' })).toBe('COM4 — USB Serial Device');
    expect(portLabel({ name: 'COM5', kind: 'bluetooth' })).toBe('COM5 — Bluetooth');
    expect(portLabel({ name: 'COM1' })).toBe('COM1');
  });

  it('searches the saved port first, Datecs/USB next, Bluetooth last', () => {
    const order = orderPortsForSearch(
      [
        { name: 'COM1', kind: 'pci' },
        { name: 'COM7', kind: 'bluetooth' },
        { name: 'COM3', kind: 'usb', product: 'USB-SERIAL CH340' },
        { name: 'COM9', kind: 'usb', product: 'Datecs Virtual Serial Port' },
      ],
      'com1',
    ).map((p) => p.name);
    expect(order).toEqual(['COM1', 'COM9', 'COM3', 'COM7']);
  });

  it('maps the combination that answered into the form', () => {
    const r = report({ port: 'COM4', recommended_dialect: 'fp55', recommended_baud: 115200 });
    expect(probeToForm(r)).toEqual({ serial_port: 'COM4', baud: 115200, protocol_variant: 'fp55' });
    expect(probeToForm(report())).toBeNull();
    expect(classifyProbe(r)).toBe('found');
  });

  it('classifies a probe that did not find the till', () => {
    const nak = { dialect: 'fp55', baud: 9600, ok: false, error: 'Device NAK' };
    expect(classifyProbe(report({ attempts: [nak], all_nak_hint: true }))).toBe('refuses');
    expect(classifyProbe(report({ attempts: [{ ...nak, error: 'open failed: communication error: open COM4: Access is denied.' }] }))).toBe('busy');
    expect(classifyProbe(report({ attempts: [{ ...nak, error: 'open failed: The system cannot find the file specified.' }] }))).toBe('missing');
    expect(classifyProbe(report({ attempts: [{ ...nak, error: 'communication error: frame timeout after 1.2s' }] }))).toBe('silent');
  });

  it('summarises a whole search', () => {
    const found = report({ port: 'COM4', recommended_dialect: 'fp55', recommended_baud: 115200 });
    expect(summariseSearch([report({ port: 'COM1' }), found], 2)).toMatchObject({ ok: true, title: expect.stringContaining('COM4') });
    expect(summariseSearch([], 0).title).toMatch(/niciun port COM/);
    expect(summariseSearch([report({ all_nak_hint: true, attempts: [{ dialect: 'fp55', baud: 1, ok: false, error: 'Device NAK' }] })], 1).title).toMatch(
      /refuză/,
    );
    expect(summariseSearch([report({ attempts: [{ dialect: 'fp55', baud: 1, ok: false, error: 'Access is denied' }] })], 1).title).toMatch(
      /alt program/,
    );
    expect(summariseSearch([report()], 1).title).toMatch(/nu a răspuns/);
  });
});

describe('error messages', () => {
  const cases: Array<[string, RegExp]> = [
    ['configuration error: Port serial lipsește (Settings → Casă de marcat → Port serial)', /Nu e ales portul/],
    ['communication error: open COM4: Access is denied.', /ocupat de alt program/],
    ['communication error: open COM9: The system cannot find the file specified.', /nu există/],
    ['Portul COM4 nu mai există (cablu/USB?). communication error: …', /nu există/],
    ['configuration error: ER:04 — parolă operator greșită', /operatorul sau parola/],
    ['paper error: ER:10 — hârtie terminată', /hârtie/],
    ['invalid command: ER:20 — bon fiscal deja deschis', /bon deschis/],
    ['not fiscalized: ER:33 — casa nu este fiscalizată ANAF', /nu este fiscalizată/],
    ['invalid command: device NAK', /refuză comanda/],
    ['communication error: frame timeout after 3s', /Casa nu răspunde/],
    ['printer busy', /ocupată/],
    ['something odd', /nu a răspuns cum trebuie/],
  ];
  it.each(cases)('%s', (raw, re) => {
    const e = explainFiscalError(raw);
    expect(e.title).toMatch(re);
    expect(e.title).not.toMatch(/rust|wss|sidecar|backend/i);
  });

  it('every till problem says what to check', () => {
    for (const [raw] of cases) expect(explainFiscalError(raw).checks.length).toBeGreaterThan(0);
  });

  it('surfaces the register refusal from the Rust driver (DP-25X ErrorCode)', () => {
    const z =
      'Casa a refuzat bonul: Este necesar raportul Z (au trecut 24 de ore). ' +
      'Fă raportul Z de la casă sau din Rapoarte fiscale → Z, apoi încearcă din nou. (cod -111024)';
    expect(explainFiscalError(z)).toEqual({
      title: 'Casa a refuzat bonul: Este necesar raportul Z (au trecut 24 de ore).',
      checks: ['Fă raportul Z de la casă sau din Rapoarte fiscale → Z, apoi încearcă din nou.'],
    });
    const x =
      'Casa a refuzat raportul X: Comanda are parametri pe care casa nu îi acceptă (eroare de sintaxă). ' +
      'Trimite-ne diagnosticul din „Avansat (service)”: casa așteaptă alt format. (cod -112001)';
    expect(explainFiscalError(x).title).toBe(
      'Casa a refuzat raportul X: Comanda are parametri pe care casa nu îi acceptă (eroare de sintaxă).',
    );
    expect(explainFiscalError(x).checks[0]).toMatch(/Avansat \(service\)/);
    // A refusal is never shown as the generic "casa nu a răspuns".
    const unknown = explainFiscalError('Casa a refuzat bonul (cod -100999).');
    expect(unknown.title).toBe('Casa a refuzat bonul (cod -100999).');
    expect(unknown.checks.length).toBeGreaterThan(0);
    // Paper end decoded from the status bytes still reads as a paper problem.
    const paper = explainFiscalError(
      'Casa a refuzat bonul: Casa nu mai are hârtie. Pune o rolă nouă, închide capacul și încearcă din nou. (cod -100999)',
    );
    expect(paper.title).toMatch(/hârtie/);
  });

  it('explains enrolment failures', () => {
    expect(explainClaimError('configuration error: enrollment code expired: {"detail":"Enrollment code expired"}').title).toMatch(/expirat/);
    expect(explainClaimError('configuration error: enrollment code not found: x').title).toMatch(/nu e bun/);
    expect(explainClaimError('communication error: HTTP 400: {"detail":"Invalid code format"}').title).toMatch(/8 caractere/);
    expect(explainClaimError('communication error: POST https://360booking.ro/api/fiscal-bridge/claim: error sending request').title).toMatch(
      /internet|360booking/,
    );
  });
});

describe('enrolment code', () => {
  it('normalises pasted codes', () => {
    expect(normaliseEnrollmentCode(' f3kp-7xma ')).toEqual({ display: 'F3KP-7XMA', valid: true });
    expect(normaliseEnrollmentCode('F3KP7XMA')).toEqual({ display: 'F3KP-7XMA', valid: true });
    expect(normaliseEnrollmentCode('F3KP 7XMA extra')).toEqual({ display: 'F3KP-7XMA', valid: true });
    expect(normaliseEnrollmentCode('F3K')).toEqual({ display: 'F3K', valid: false });
  });
});

describe('VAT label of the test bill', () => {
  it('reads group A from the station vat map in any known shape', () => {
    expect(groupARate('{"A":0.21,"B":0.11}')).toBe(21);
    expect(groupARate({ A: 21 })).toBe(21);
    expect(groupARate({ '0.21': 'A', '0.11': 'B' })).toBe(21);
    expect(groupARate([{ group: 'B', rate: 0.11 }, { group: 'A', rate: 0.19 }])).toBe(19);
    expect(groupARate('not json')).toBeNull();
    expect(groupARate({ B: 0.11 })).toBeNull();
  });

  it('uses the vat map, then the pulled config, else no percentage', () => {
    expect(vatLabel('{"A":0.21}', null)).toBe('TVA 21%');
    expect(vatLabel(null, { protocol: 'fp55', vat_map: { A: 0.21 } })).toBe('TVA 21%');
    expect(vatLabel(null, { protocol: 'fp55', cmd_codes: {} })).toBeNull();
    expect(vatLabel(null, null)).toBeNull();
  });

  it('never shows the outdated 19% unless the restaurant config says so', () => {
    expect(vatLabel(null, { protocol: 'fp55' })).not.toBe('TVA 19%');
  });
});

describe('periodic report range', () => {
  it('defaults to the previous calendar month', () => {
    expect(previousMonthRange(new Date(2026, 9, 15))).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(previousMonthRange(new Date(2026, 0, 3))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(previousMonthRange(new Date(2028, 2, 1))).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('converts ISO dates to DDMMYY for the agent', () => {
    expect(isoToDdmmyy('2026-10-01')).toBe('011026');
    expect(isoToDdmmyy('')).toBeNull();
    expect(isoToDdmmyy('01.10.2026')).toBeNull();
  });

  it('explains a bad range in Romanian', () => {
    expect(periodicRangeProblem('2026-09-01', '2026-09-30', '2026-10-15')).toBeNull();
    expect(periodicRangeProblem('', '2026-09-30', '2026-10-15')).toMatch(/Alege/);
    expect(periodicRangeProblem('2026-09-30', '2026-09-01', '2026-10-15')).toMatch(/după/);
    expect(periodicRangeProblem('2026-10-01', '2026-10-16', '2026-10-15')).toMatch(/viitor/);
  });
});
