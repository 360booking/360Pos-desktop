/**
 * Ghidul „casa de marcat în 3 pași” — pure logic, no React, no Tauri.
 *
 * Kept apart from the component so every decision the owner sees (which
 * step is next, what the form is pre-filled with, what an error means in
 * plain Romanian, which VAT label the test bill shows) is unit-tested.
 */
import type { FiscalRuntimeConfig } from '@/adapters/fiscal/runtime-config';

// ---------------------------------------------------------------- models

export interface TillDefaults {
  baud: number;
  protocol_variant: string;
  operator: string;
  operator_password: string;
}

export interface TillModel {
  id: string;
  label: string;
  /** Runtime provider written to fiscal_runtime_config.provider. */
  provider: string | null;
  supported: boolean;
  /** Tried end-to-end on a real register. */
  verified: boolean;
  note?: string;
  /** Stored in fiscal_runtime_config.printer_model (free text, audit rows). */
  printerModel: string;
  defaults: TillDefaults;
}

/** Settings verified on the owner's Datecs DP-25X (April 2026). */
const DATECS_X_DEFAULTS: TillDefaults = {
  baud: 115200,
  protocol_variant: 'fp55',
  operator: '1',
  operator_password: '0001',
};

export const TILL_MODELS: TillModel[] = [
  {
    id: 'dp25x',
    label: 'Datecs DP-25X',
    provider: 'datecs_dp25',
    supported: true,
    verified: true,
    printerModel: 'Datecs DP-25X',
    defaults: DATECS_X_DEFAULTS,
  },
  {
    id: 'dp25',
    label: 'Datecs DP-25',
    provider: 'datecs_dp25',
    supported: true,
    verified: false,
    printerModel: 'Datecs DP-25',
    defaults: DATECS_X_DEFAULTS,
  },
  {
    id: 'dp150x',
    label: 'Datecs DP-150X',
    provider: 'datecs_dp25',
    supported: true,
    verified: false,
    note: 'Aceeași familie cu DP-25X. „Caută casa automat” găsește setările.',
    printerModel: 'Datecs DP-150X',
    defaults: DATECS_X_DEFAULTS,
  },
  {
    id: 'fp700x',
    label: 'Datecs FP-700X / FMP-350X',
    provider: null,
    supported: false,
    verified: false,
    note: 'În curând',
    printerModel: 'Datecs FP-700X',
    defaults: { ...DATECS_X_DEFAULTS, operator_password: '0000' },
  },
  {
    id: 'tremol',
    label: 'Tremol',
    provider: null,
    supported: false,
    verified: false,
    note: 'În curând',
    printerModel: 'Tremol',
    defaults: DATECS_X_DEFAULTS,
  },
  {
    id: 'daisy',
    label: 'Daisy / alte mărci',
    provider: null,
    supported: false,
    verified: false,
    note: 'În curând',
    printerModel: 'Daisy',
    defaults: DATECS_X_DEFAULTS,
  },
];

export const SUPPORTED_BAUDS = [9600, 19200, 38400, 57600, 115200];

export function findModel(id: string | null | undefined): TillModel | null {
  return TILL_MODELS.find((m) => m.id === id) ?? null;
}

/** Providers that talk to a physical register over a COM port. */
export function isRealProvider(provider: string | null | undefined): boolean {
  return provider === 'datecs_dp25' || provider === 'datecs_fp';
}

/**
 * Which model card is selected for a saved config. A Datecs config without
 * a recognised printer_model is the owner's DP-25X (the only one verified).
 * Anything else (simulator, FP-700 family set from Avansat) selects nothing.
 */
export function modelFromConfig(cfg: Pick<FiscalRuntimeConfig, 'provider' | 'printer_model'> | null): string | null {
  if (!cfg || cfg.provider !== 'datecs_dp25') return null;
  const pm = (cfg.printer_model ?? '').toLowerCase();
  const byLabel = TILL_MODELS.find((m) => m.supported && m.printerModel.toLowerCase() === pm);
  return byLabel ? byLabel.id : 'dp25x';
}

// ------------------------------------------------------------------ form

export interface GuideForm {
  modelId: string | null;
  serial_port: string | null;
  baud: number;
  protocol_variant: string;
  operator: string;
  operator_password: string;
}

const FACTORY_PASSWORDS = new Set(['', '0000', '0001']);

/** Form for a freshly picked model. Keeps a port the owner already chose
 *  and an operator/password that is not a factory value (set by service). */
export function defaultsForModel(modelId: string, current?: Partial<GuideForm> | null): GuideForm {
  const m = findModel(modelId);
  const d = m?.defaults ?? DATECS_X_DEFAULTS;
  const keepPassword = current?.operator_password && !FACTORY_PASSWORDS.has(current.operator_password);
  const keepOperator = current?.operator && current.operator !== '1' && current.operator.trim() !== '';
  return {
    modelId,
    serial_port: current?.serial_port ?? null,
    baud: d.baud,
    protocol_variant: d.protocol_variant,
    operator: keepOperator ? current!.operator! : d.operator,
    operator_password: keepPassword ? current!.operator_password! : d.operator_password,
  };
}

/** Form as loaded from SQLite: saved values win, model defaults fill holes. */
export function formFromConfig(cfg: FiscalRuntimeConfig | null): GuideForm {
  const modelId = modelFromConfig(cfg);
  const d = (findModel(modelId) ?? TILL_MODELS[0]).defaults;
  const real = isRealProvider(cfg?.provider);
  return {
    modelId,
    serial_port: cfg?.serial_port ?? null,
    baud: real && cfg?.baud ? cfg.baud : d.baud,
    protocol_variant: real && cfg?.protocol_variant ? cfg.protocol_variant : d.protocol_variant,
    operator: real && cfg?.operator ? cfg.operator : d.operator,
    operator_password: real && cfg?.operator_password ? cfg.operator_password : d.operator_password,
  };
}

/**
 * Row to write to fiscal_runtime_config. Same table, same fields as the
 * service form: only the hardware fields change; vat map, cmd codes and the
 * raw-log switch are carried over untouched. `use_rust` is switched on —
 * a real Datecs register needs the integrated driver.
 */
export function buildRuntimeConfig(base: FiscalRuntimeConfig, form: GuideForm): FiscalRuntimeConfig {
  const m = findModel(form.modelId);
  return {
    ...base,
    provider: m?.provider ?? base.provider,
    serial_port: form.serial_port,
    baud: form.baud,
    protocol_variant: form.protocol_variant,
    operator: form.operator.trim() || '1',
    operator_password: form.operator_password.trim() || (m?.defaults.operator_password ?? '0001'),
    printer_model: m?.printerModel ?? base.printer_model,
    use_rust: true,
  };
}

export function formProblem(form: GuideForm): string | null {
  const m = findModel(form.modelId);
  if (!m) return 'Alege modelul casei de marcat.';
  if (!m.supported) return `${m.label} nu e suportată încă.`;
  if (!form.serial_port) return 'Apasă „Caută casa automat” sau alege portul.';
  return null;
}

// ----------------------------------------------------------------- ports

export interface PortInfo {
  name: string;
  kind?: string;
  product?: string | null;
  manufacturer?: string | null;
}

/** "COM4 — USB Serial Device" (Windows repeats the port name in brackets). */
export function portLabel(p: PortInfo): string {
  const raw = (p.product || p.manufacturer || '').replace(/\s*\((COM\d+)\)\s*$/i, '').trim();
  if (raw) return `${p.name} — ${raw}`;
  if (p.kind === 'bluetooth') return `${p.name} — Bluetooth`;
  return p.name;
}

function portScore(p: PortInfo): number {
  const text = `${p.product ?? ''} ${p.manufacturer ?? ''}`.toLowerCase();
  if (text.includes('datecs')) return 0;
  if (p.kind === 'usb') return 1;
  if (p.kind === 'bluetooth' || text.includes('bluetooth')) return 3;
  return 2;
}

/** Search order: the saved port, then Datecs/USB ports, Bluetooth last. */
export function orderPortsForSearch(ports: PortInfo[], preferred?: string | null): PortInfo[] {
  const list = ports.map((p, i) => ({ p, i }));
  list.sort((a, b) => {
    const pa = preferred && a.p.name.toUpperCase() === preferred.toUpperCase() ? -1 : portScore(a.p);
    const pb = preferred && b.p.name.toUpperCase() === preferred.toUpperCase() ? -1 : portScore(b.p);
    return pa - pb || a.i - b.i;
  });
  return list.map((x) => x.p);
}

// ----------------------------------------------------------------- probe

export interface ProbeAttempt {
  dialect: string;
  baud: number;
  ok: boolean;
  error: string | null;
}

export interface ProbeReport {
  port: string;
  configured_baud: number;
  attempts: ProbeAttempt[];
  recommended_dialect: string | null;
  recommended_baud: number | null;
  all_nak_hint: boolean;
}

/** Port, baud and dialect that answered, or null when nothing did. */
export function probeToForm(report: ProbeReport): Pick<GuideForm, 'serial_port' | 'baud' | 'protocol_variant'> | null {
  if (!report.recommended_dialect || !report.recommended_baud) return null;
  return {
    serial_port: report.port,
    baud: report.recommended_baud,
    protocol_variant: report.recommended_dialect,
  };
}

export type ProbeOutcome = 'found' | 'refuses' | 'busy' | 'missing' | 'silent';

export function classifyProbe(report: ProbeReport): ProbeOutcome {
  if (probeToForm(report)) return 'found';
  if (report.all_nak_hint) return 'refuses';
  const errors = report.attempts.map((a) => (a.error ?? '').toLowerCase());
  if (errors.some((e) => /access is denied|acces.*refuzat|accesul.*refuzat|\bbusy\b|\bin use\b|permission denied|os error 5\b/.test(e))) {
    return 'busy';
  }
  if (errors.length > 0 && errors.every((e) => /open failed|cannot find|not found|no such file|nu găsește|os error 2\b/.test(e))) {
    return 'missing';
  }
  return 'silent';
}

export interface SearchSummary {
  ok: boolean;
  title: string;
  checks: string[];
}

/** One message for a whole automatic search (every port probed). */
export function summariseSearch(reports: ProbeReport[], portsSeen: number): SearchSummary {
  const found = reports.find((r) => classifyProbe(r) === 'found');
  if (found) {
    const f = probeToForm(found)!;
    return { ok: true, title: `Am găsit casa pe ${f.serial_port} (viteza ${f.baud}).`, checks: [] };
  }
  if (portsSeen === 0) {
    return {
      ok: false,
      title: 'Nu văd niciun port COM pe calculatorul ăsta.',
      checks: [
        'Cablul USB al casei e băgat în calculator și casa e pornită?',
        'E instalat driverul Datecs (vine pe CD sau de pe site-ul Datecs)?',
        'Încearcă alt port USB, apoi caută din nou.',
      ],
    };
  }
  const refuses = reports.find((r) => classifyProbe(r) === 'refuses');
  if (refuses) {
    return {
      ok: false,
      title: `Pe ${refuses.port} e ceva care răspunde, dar refuză comenzile.`,
      checks: [
        'Uită-te pe ecranul casei: dacă e un bon rămas deschis, închide-l sau anulează-l din meniul casei.',
        'Oprește casa, așteaptă 10 secunde și pornește-o din nou.',
        'Dacă problema rămâne, sună service-ul casei.',
      ],
    };
  }
  const busy = reports.find((r) => classifyProbe(r) === 'busy');
  if (busy) {
    return {
      ok: false,
      title: `Portul ${busy.port} e folosit de alt program.`,
      checks: [
        'Închide programele care vorbesc cu casa (DUDE, vechiul „360booking-bridge”, alt program de facturare).',
        'Apoi caută din nou.',
      ],
    };
  }
  return {
    ok: false,
    title: 'Casa nu a răspuns pe niciun port.',
    checks: [
      'Casa e pornită și arată ecranul de vânzare (nu un meniu)?',
      'Cablul e bine prins la ambele capete?',
      'Încearcă alt port USB, apoi caută din nou.',
    ],
  };
}

// ----------------------------------------------------------- error texts

export interface Explained {
  title: string;
  checks: string[];
}

/**
 * „Casa a refuzat …” — the register answered but refused the command
 * (DP-25X ErrorCode < 0). The Rust driver writes the whole Romanian text:
 *   `Casa a refuzat <ce>: <motiv>. <ce faci> (cod -NNN)`   (cod cunoscut)
 *   `Casa a refuzat <ce> (cod -NNN).`                      (cod necunoscut)
 * so the guide only splits it; the table lives in
 * src-tauri/src/fiscal/mapping/datecs_errors.rs.
 */
export function explainDeviceRefusal(raw: unknown): Explained | null {
  const text = String(raw ?? '');
  const m = /Casa a refuzat ([^:(]+?)(?:: ([^.]+)\. ([\s\S]*?))? \(cod (-?\d+)\)/.exec(text);
  if (!m) return null;
  const [, what, reason, hint, code] = m;
  if (reason) {
    return { title: `Casa a refuzat ${what}: ${reason}.`, checks: [hint.trim() || 'Încearcă din nou.'] };
  }
  return {
    title: `Casa a refuzat ${what} (cod ${code}).`,
    checks: [
      'Uită-te pe ecranul casei: un mesaj, un meniu sau un bon rămas deschis explică de obicei refuzul.',
      'Dacă se repetă, trimite-ne textul de mai jos (conține codul erorii).',
    ],
  };
}

/** Plain-Romanian reason + what to check, for any till error string. */
export function explainFiscalError(raw: unknown): Explained {
  const text = String(raw ?? '');
  const refused = explainDeviceRefusal(text);
  if (refused) return refused;
  const t = text.toLowerCase();
  if (/port serial (lipsește|neconfigurat)|serial port.*missing/.test(t)) {
    return { title: 'Nu e ales portul casei.', checks: ['Apasă „Caută casa automat” sau alege portul de mână.'] };
  }
  if (/access is denied|acces.*refuzat|accesul.*refuzat|permission denied|os error 5\b|port busy|\bin use\b/.test(t)) {
    return {
      title: 'Portul casei e ocupat de alt program.',
      checks: [
        'Închide DUDE, vechiul „360booking-bridge” sau alt program care folosește casa.',
        'Apoi apasă din nou.',
      ],
    };
  }
  if (/nu mai există|cannot find|not found|no such file|os error 2\b|the system cannot find/.test(t)) {
    return {
      title: 'Portul ales nu există acum.',
      checks: ['Verifică cablul USB al casei.', 'Apasă „Caută casa automat” — poate casa a primit alt port.'],
    };
  }
  if (/parol|password|er:04|er:05|operator inactiv/.test(t)) {
    return {
      title: 'Casa refuză operatorul sau parola.',
      checks: [
        'Valorile din fabrică sunt operator 1, parola 0001.',
        'Dacă service-ul casei le-a schimbat, cere-le de la el și scrie-le aici.',
      ],
    };
  }
  if (/hârtie|paper|er:1[0-2]|capac/.test(t)) {
    return { title: 'Casa nu are hârtie sau capacul e deschis.', checks: ['Pune o rolă nouă și închide capacul.'] };
  }
  if (/deja deschis|er:20|er:22/.test(t)) {
    return {
      title: 'Pe casă a rămas un bon deschis.',
      checks: ['Închide sau anulează bonul din meniul casei.', 'Sau oprește și pornește casa.'],
    };
  }
  if (/not fiscalized|nu este fiscalizat|er:33/.test(t)) {
    return { title: 'Casa nu este fiscalizată.', checks: ['Sună service-ul casei pentru fiscalizare.'] };
  }
  if (/memorie fiscal|fiscal memory/.test(t)) {
    return { title: 'Casa raportează o problemă de memorie fiscală.', checks: ['Sună service-ul casei.'] };
  }
  if (/printer busy|ocupat/.test(t)) {
    return { title: 'Casa e ocupată chiar acum.', checks: ['Așteaptă câteva secunde și încearcă din nou.'] };
  }
  if (/device nak|\bnak\b/.test(t)) {
    return {
      title: 'Casa răspunde, dar refuză comanda.',
      checks: [
        'Verifică pe ecranul casei să nu fie un bon sau un meniu deschis.',
        'Verifică operatorul și parola (din fabrică: 1 / 0001).',
        'Apasă „Caută casa automat” ca să găsesc din nou setările.',
      ],
    };
  }
  if (/timeout|timed out|no post marker|short frame|frame|read:|write:/.test(t)) {
    return {
      title: 'Casa nu răspunde.',
      checks: [
        'Casa e pornită?',
        'Cablul e bine prins la casă și la calculator?',
        'E portul bun? Apasă „Caută casa automat”.',
      ],
    };
  }
  if (/unknown fiscal provider/.test(t)) {
    return { title: 'Modelul ales nu e suportat încă.', checks: ['Alege Datecs DP-25X, DP-25 sau DP-150X.'] };
  }
  return {
    title: 'Casa nu a răspuns cum trebuie.',
    checks: ['Verifică dacă e pornită și dacă are cablul prins.', 'Dacă se repetă, trimite-ne textul de mai jos.'],
  };
}

/** Plain-Romanian reason for a failed „Leagă” (enrolment code claim). */
export function explainClaimError(raw: unknown): Explained {
  const t = String(raw ?? '').toLowerCase();
  if (/expired|410/.test(t)) {
    return {
      title: 'Codul a expirat (e valabil 10 minute).',
      checks: ['În admin apasă din nou „Activează” și copiază codul nou.'],
    };
  }
  if (/not found|404/.test(t)) {
    return {
      title: 'Codul nu e bun sau a fost deja folosit.',
      checks: ['Verifică să fie exact codul din admin.', 'Sau cere un cod nou: „Activează” în admin.'],
    };
  }
  if (/invalid code format|400/.test(t)) {
    return { title: 'Codul are 8 caractere, de forma ABCD-1234.', checks: ['Copiază-l din nou din admin.'] };
  }
  if (/post |error sending|dns|connect|timed out|network|tls|certificate/.test(t)) {
    return {
      title: 'Nu am putut ajunge la 360booking.',
      checks: ['Verifică internetul pe calculatorul ăsta.', 'Apoi apasă din nou „Leagă”.'],
    };
  }
  return { title: 'Legarea nu a reușit.', checks: ['Cere un cod nou din admin și încearcă din nou.'] };
}

// ------------------------------------------------------- enrolment code

export interface NormalisedCode {
  display: string;
  valid: boolean;
}

/** "abcd 1234" / "ABCD1234" / "ABCD-1234" → "ABCD-1234". */
export function normaliseEnrollmentCode(raw: string): NormalisedCode {
  const flat = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const display = flat.length > 4 ? `${flat.slice(0, 4)}-${flat.slice(4)}` : flat;
  return { display, valid: flat.length === 8 };
}

// ------------------------------------------------------------------ VAT

function asRate(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const pct = n <= 1 ? n * 100 : n;
  return pct > 50 ? null : Math.round(pct * 100) / 100;
}

/** Rate of VAT group A from a vat map, in any of the shapes we have seen:
 *  {"A": 0.21} · {"A": 21} · {"0.21": "A"} · {"21": "A"} · [{group, rate}]. */
export function groupARate(map: unknown): number | null {
  if (!map) return null;
  if (typeof map === 'string') {
    try {
      return groupARate(JSON.parse(map));
    } catch {
      return null;
    }
  }
  if (Array.isArray(map)) {
    for (const row of map) {
      if (row && typeof row === 'object') {
        const r = row as Record<string, unknown>;
        const g = String(r.group ?? r.grupa ?? r.letter ?? '').toUpperCase();
        if (g === 'A') return asRate(r.rate ?? r.cota ?? r.vat);
      }
    }
    return null;
  }
  if (typeof map !== 'object') return null;
  const obj = map as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (k.toUpperCase() === 'A') return asRate(v);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.toUpperCase() === 'A') return asRate(k);
  }
  return null;
}

/**
 * "TVA 21%" for the test bill (VAT group A), from the station's vat map or
 * the restaurant's pulled config; null when neither says — then the label
 * shows no percentage at all rather than a stale one.
 */
export function vatLabel(vatMapJson: string | null | undefined, protocol: Record<string, unknown> | null | undefined): string | null {
  const candidates: unknown[] = [vatMapJson];
  if (protocol) candidates.push(protocol.vat_map, protocol.vat_groups, protocol.vat_rates, protocol.vat);
  for (const c of candidates) {
    const r = groupARate(c);
    if (r !== null) return `TVA ${r.toLocaleString('ro-RO')}%`;
  }
  return null;
}

// ------------------------------------------------------------ step state

export type StepState = 'todo' | 'done' | 'error' | 'warn';

export interface GuideStatusInput {
  /** fiscal_runtime_config row exists (saved at least once). */
  configSaved: boolean;
  provider: string | null;
  serialPort: string | null;
  /** Last known answer of the register: true / false / unknown. */
  printerOk: boolean | null;
  /** Saved enrolment credentials exist on this station. */
  enrolled: boolean;
  /** The agent is connected to the server right now. */
  connected: boolean;
  /** The server refused the saved token (admin „Deconectează”). */
  revoked?: boolean;
  /** Test bill printed in this session, or the station was complete on open. */
  testDone: boolean;
}

export interface GuideSteps {
  steps: [StepState, StepState, StepState];
  /** First step that is not done; 'done' when all three are. */
  current: 1 | 2 | 3 | 'done';
}

export function deriveSteps(s: GuideStatusInput): GuideSteps {
  const configured = s.configSaved && isRealProvider(s.provider) && Boolean(s.serialPort);
  const s1: StepState = !configured ? 'todo' : s.printerOk === false ? 'error' : 'done';
  const s2: StepState = s.enrolled ? (s.connected ? 'done' : s.revoked ? 'error' : 'warn') : 'todo';
  const s3: StepState = s.testDone && s1 === 'done' ? 'done' : 'todo';
  const steps: [StepState, StepState, StepState] = [s1, s2, s3];
  const idx = steps.findIndex((x) => x !== 'done');
  return { steps, current: idx === -1 ? 'done' : ((idx + 1) as 1 | 2 | 3) };
}

/** Station already set up when the window opens → start on the summary. */
export function completeOnOpen(s: Omit<GuideStatusInput, 'testDone' | 'connected' | 'printerOk'>): boolean {
  return s.configSaved && isRealProvider(s.provider) && Boolean(s.serialPort) && s.enrolled;
}

// ------------------------------------------------------- summary labels

export interface HealthLike {
  monitored: boolean;
  online: boolean | null;
  lastCheckAt: number | null;
}

export interface LocalCheck {
  ok: boolean;
  /** unix seconds */
  at: number;
}

/** The more recent of the watchdog poll and this window's own test. */
export function printerAnswer(health: HealthLike | null, local: LocalCheck | null): boolean | null {
  const h = health && health.monitored && health.online !== null ? { ok: health.online, at: health.lastCheckAt ?? 0 } : null;
  if (h && local) return h.at > local.at ? h.ok : local.ok;
  if (local) return local.ok;
  if (h) return h.ok;
  return null;
}

export type Tone = 'ok' | 'bad' | 'wait' | 'off';

export function tillSummary(configured: boolean, answer: boolean | null): { text: string; tone: Tone } {
  if (!configured) return { text: 'neconfigurată', tone: 'off' };
  if (answer === true) return { text: 'răspunde', tone: 'ok' };
  if (answer === false) return { text: 'nu răspunde', tone: 'bad' };
  return { text: 'neverificată încă', tone: 'wait' };
}

export function linkSummary(
  enrolled: boolean,
  connected: boolean,
  running: boolean,
  revoked = false,
): { text: string; tone: Tone } {
  if (!enrolled) return { text: 'nelegată', tone: 'off' };
  if (connected) return { text: 'conectată', tone: 'ok' };
  if (revoked) return { text: 'anulată din admin', tone: 'bad' };
  if (running) return { text: 'se conectează…', tone: 'wait' };
  return { text: 'legată, dar fără conexiune acum', tone: 'bad' };
}

// --------------------------------------------- connection to the server

/** Shown on the „Legare” line when the server refused this app's token. */
export const REVOKED_TEXT = 'Legătura a fost anulată din admin — leag-o din nou';

// ------------------------------------------------- automatic link (2026-10-14)

/** Where the automatic link starts — shown when the window was opened on
 *  its own (Ctrl+Shift+F) and the app is not linked. */
export const LINK_FROM_POS_TEXT = 'Deschide Setări → Casa de marcat din POS';

/** Last automatic link, from `shell_fiscal_link_state` (null = none since
 *  the app started, i.e. the window was opened on its own). */
export interface AutoLinkState {
  state: 'linking' | 'ok' | 'error' | string;
  at: number;
  error: string | null;
  bridgeId: string | null;
}

export interface LinkLine {
  text: string;
  tone: Tone;
  /** Smaller explanation under the line. */
  hint: string | null;
  /** 'retry' = button „Reîncearcă legarea” (redoes the link via the admin
   *  page); 'none' = nothing to press here. */
  action: 'retry' | 'none';
}

/**
 * The „Legare” line that replaced step 2 („Leagă stația”): the link to the
 * restaurant is made automatically from Setări → Casa de marcat.
 */
export function linkLine(s: {
  enrolled: boolean;
  connected: boolean;
  running: boolean;
  revoked: boolean;
  auto: AutoLinkState | null;
}): LinkLine {
  if (s.auto?.state === 'linking') {
    return { text: 'Se leagă automat de restaurant…', tone: 'wait', hint: null, action: 'none' };
  }
  if (s.enrolled && !s.revoked) {
    if (s.connected) return { text: 'Legată de restaurant ✓', tone: 'ok', hint: null, action: 'none' };
    if (s.running) return { text: 'Legată — se conectează…', tone: 'wait', hint: null, action: 'none' };
    return {
      text: 'Legată, dar fără conexiune acum',
      tone: 'bad',
      hint: 'Verifică internetul, apoi apasă „Reconectează acum”.',
      action: 'none',
    };
  }
  const why = s.revoked ? REVOKED_TEXT : 'Nelegată încă';
  if (s.auto) {
    // Started from the admin page: the link can be redone from there.
    return {
      text: s.auto.state === 'error' && s.auto.error ? s.auto.error : why,
      tone: 'bad',
      hint: 'Legătura cu restaurantul se face automat. Apasă „Reîncearcă legarea”.',
      action: 'retry',
    };
  }
  return {
    text: why,
    tone: s.revoked ? 'bad' : 'off',
    hint: `Legătura cu restaurantul se face automat: ${LINK_FROM_POS_TEXT} → „Configurează casa de marcat”.`,
    action: 'none',
  };
}

/**
 * Why the agent cannot reach the server, in plain Romanian, from the raw
 * error the Rust WSS loop keeps (`bridge.last_error`). Shown in the summary
 * bar as „Nu mă pot conecta la server: <motiv>”.
 */
export function explainConnectionError(raw: unknown): string {
  const text = String(raw ?? '').trim();
  const t = text.toLowerCase();
  if (!t) return 'motiv necunoscut';
  if (/auth rejected|http 40[13]|\b40[13]\b|re-enroll|revoked|4001|4403/.test(t)) {
    return 'legătura a fost anulată din admin — leag-o din nou din POS: Setări → Casa de marcat';
  }
  if (/certificate|unknownissuer|unknown issuer|invalid peer|webpki|tls|ssl|handshake/.test(t)) {
    return 'certificatul de securitate al serverului nu e recunoscut pe acest calculator (TLS/certificat). Actualizează aplicația; dacă persistă, verifică antivirusul sau proxy-ul';
  }
  if (/dns|failed to lookup|no such host|name resolution|nodename|os error 11001|getaddrinfo/.test(t)) {
    return 'nu găsesc adresa 360booking.ro (DNS) — verifică internetul';
  }
  if (/refused|os error 10061|connection reset|os error 10054/.test(t)) {
    return 'serverul a refuzat conexiunea — poate un firewall, antivirus sau proxy';
  }
  if (/timed out|timeout|os error 10060/.test(t)) {
    return 'serverul nu răspunde (timeout) — verifică internetul';
  }
  if (/network is unreachable|os error 10051|no route|os error 10065/.test(t)) {
    return 'calculatorul nu are internet';
  }
  if (/proxy/.test(t)) {
    return 'un proxy blochează conexiunea';
  }
  if (/replaced by another bridge|4000/.test(t)) {
    return 'altă aplicație (alt calculator) s-a legat cu același restaurant';
  }
  if (/http 5\d\d|server close/.test(t)) {
    return 'serverul 360booking are o problemă temporară — reîncerc singur';
  }
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
