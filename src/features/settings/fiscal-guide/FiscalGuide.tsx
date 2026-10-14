/**
 * Ghidul „Casa de marcat în 3 pași” — what the restaurant owner sees in the
 * fiscal window (Ctrl+Shift+F → Casa de marcat).
 *
 *   1. Conectează casa de marcat — model, automatic port search, save + test
 *   2. Leagă stația de restaurant — activation code from the web admin
 *   3. Bon de test — a real 1-leu bill, X report
 *
 * Everything technical (raw fields, protocol variant, pull config, manual
 * pairing, probe sweep, raw bytes, agent mode) lives unchanged in the
 * collapsed „Avansat (service)” section at the bottom.
 *
 * No new storage: the guide writes the same fiscal_runtime_config row as the
 * service form and enrols through the same commands, so the offline till,
 * the agent auto-start and web POS printing keep working as before.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardPaste, Link2, Printer, RefreshCw, Search, ShieldAlert, Usb } from 'lucide-react';

import { enableRustFiscalIfAllowed } from '@/adapters';
import { getCachedFiscalConfig, pullFiscalConfig } from '@/adapters/fiscal/config';
import { RustFiscalAdapter } from '@/adapters/fiscal/rust';
import {
  getFiscalRuntimeConfig,
  setFiscalRuntimeConfig,
  type FiscalRuntimeConfig,
} from '@/adapters/fiscal/runtime-config';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { errText, shellApi, type AgentSummary, type FiscalHealth } from '@/shell/api';

import { DEFAULT_SERVER, guideApi, listPorts, type BridgeState, type SavedBridgeCredentials } from './api';
import {
  SUPPORTED_BAUDS,
  TILL_MODELS,
  buildRuntimeConfig,
  classifyProbe,
  completeOnOpen,
  defaultsForModel,
  deriveSteps,
  explainClaimError,
  explainFiscalError,
  findModel,
  formFromConfig,
  formProblem,
  isRealProvider,
  linkSummary,
  normaliseEnrollmentCode,
  orderPortsForSearch,
  portLabel,
  printerAnswer,
  probeToForm,
  summariseSearch,
  tillSummary,
  vatLabel,
  type Explained,
  type GuideForm,
  type LocalCheck,
  type PortInfo,
  type ProbeReport,
  type SearchSummary,
  type StepState,
} from './logic';
import { ServiceSection } from './ServiceSection';
import {
  Dot,
  OkBox,
  ProblemBox,
  Spinner,
  StepBadge,
  btnGhost,
  btnPrimary,
  btnSecondary,
  inputCls,
} from './ui';

type Health = { printer: FiscalHealth; agent: AgentSummary };
type Outcome = { state: 'idle' } | { state: 'busy' } | { state: 'ok'; text: string } | { state: 'err'; e: Explained; raw: string };

const IDLE: Outcome = { state: 'idle' };
const nowSec = () => Math.floor(Date.now() / 1000);

function emptyRuntimeConfig(): FiscalRuntimeConfig {
  return {
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
  };
}

const STEP_TITLES = ['Conectează casa de marcat', 'Leagă stația de restaurant', 'Bon de test'] as const;

export function FiscalGuide() {
  const deviceId = getConfig().deviceId ?? '';

  // ------------------------------------------------------------ loaded state
  const [loaded, setLoaded] = useState(false);
  const [cfg, setCfg] = useState<FiscalRuntimeConfig | null>(null);
  const [form, setForm] = useState<GuideForm>(() => formFromConfig(null));
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [creds, setCreds] = useState<SavedBridgeCredentials | null>(null);
  const [bridge, setBridge] = useState<BridgeState | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [protocol, setProtocol] = useState<Record<string, unknown> | null>(null);

  // ------------------------------------------------------------ step 1
  const [search, setSearch] = useState<{ port: string; baud: number; i: number; total: number; since: number } | null>(null);
  const [searchResult, setSearchResult] = useState<SearchSummary | null>(null);
  const stopSearch = useRef(false);
  const [manual, setManual] = useState(false);
  const [portsBusy, setPortsBusy] = useState(false);
  const [saveTest, setSaveTest] = useState<Outcome>(IDLE);
  const [localCheck, setLocalCheck] = useState<LocalCheck | null>(null);
  const [tick, setTick] = useState(0);

  // ------------------------------------------------------------ step 2
  const [code, setCode] = useState('');
  const [link, setLink] = useState<Outcome>(IDLE);
  const [confirmRelink, setConfirmRelink] = useState(false);
  const codeRef = useRef<HTMLInputElement | null>(null);

  // ------------------------------------------------------------ step 3
  const [bill, setBill] = useState<Outcome>(IDLE);
  const [xrep, setXrep] = useState<Outcome>(IDLE);
  const [testDone, setTestDone] = useState(false);

  // ------------------------------------------------------------ layout
  const [openStep, setOpenStep] = useState<1 | 2 | 3 | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const refreshHealth = useCallback(() => {
    shellApi.fiscalHealth().then(setHealth).catch(() => {});
    guideApi.bridgeState().then(setBridge).catch(() => {});
  }, []);

  const reloadConfig = useCallback(async () => {
    try {
      const c = await getFiscalRuntimeConfig();
      setCfg(c);
      setForm(formFromConfig(c));
      return c;
    } catch (err) {
      logger.warn('fiscal-guide', 'getFiscalRuntimeConfig failed', { err: String(err) });
      return null;
    }
  }, []);

  const reloadAll = useCallback(async () => {
    await reloadConfig();
    guideApi.savedCredentials().then(setCreds).catch(() => {});
    getCachedFiscalConfig()
      .then((c) => setProtocol(c?.protocol ?? null))
      .catch(() => {});
    refreshHealth();
  }, [reloadConfig, refreshHealth]);

  // initial load + agent auto-restart + polling
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const c = await reloadConfig();
      void listPorts()
        .then((p) => !cancelled && setPorts(p))
        .catch(() => {});
      void getCachedFiscalConfig()
        .then((x) => !cancelled && setProtocol(x?.protocol ?? null))
        .catch(() => {});
      refreshHealth();
      // Same auto-restart as the service form: re-attach the agent from the
      // saved enrolment so a reinstall never needs a new code. Idempotent —
      // fiscal_bridge_run is a no-op when the loop already runs.
      let saved: SavedBridgeCredentials | null = null;
      try {
        saved = await guideApi.savedCredentials();
        if (!cancelled) setCreds(saved);
        if (saved) {
          await guideApi.run(saved.websocket_url, saved.device_token, saved.printer_model ?? c?.provider ?? 'datecs_dp25');
          logger.info('fiscal-guide', 'auto-restarted WSS from saved credentials', {
            bridge_id: saved.bridge_id,
            tenant_id: saved.tenant_id,
            claimed_at: saved.claimed_at,
          });
        }
      } catch (err) {
        logger.warn('fiscal-guide', 'auto-restart failed', { err: String(err) });
      }
      if (cancelled) return;
      // Already configured + enrolled → open on the summary.
      if (
        completeOnOpen({
          configSaved: Boolean(c?.updated_at),
          provider: c?.provider ?? null,
          serialPort: c?.serial_port ?? null,
          enrolled: Boolean(saved),
        })
      ) {
        setTestDone(true);
      }
      setLoaded(true);
    })();
    // Fast poll for the first 30 s (the agent handshake takes ~3–5 s), then calm.
    let elapsed = 0;
    let id: ReturnType<typeof setInterval> = setInterval(() => {
      refreshHealth();
      elapsed += 2_000;
      if (elapsed >= 30_000) {
        clearInterval(id);
        id = setInterval(refreshHealth, 5_000);
      }
    }, 2_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [reloadConfig, refreshHealth]);

  // seconds counter while searching
  useEffect(() => {
    if (!search) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [search]);

  // ------------------------------------------------------------ derived
  const configSaved = Boolean(cfg?.updated_at);
  const enrolled = Boolean(creds) || Boolean(health?.agent.hasSavedCredentials);
  const connected = Boolean(bridge?.connected) || Boolean(health?.agent.connected);
  const agentRunning = Boolean(bridge?.configured) || Boolean(health?.agent.running);
  const answer = printerAnswer(health?.printer ?? null, localCheck);
  const tillConfigured = configSaved && isRealProvider(cfg?.provider) && Boolean(cfg?.serial_port);
  const { steps, current } = deriveSteps({
    configSaved,
    provider: cfg?.provider ?? null,
    serialPort: cfg?.serial_port ?? null,
    printerOk: answer,
    enrolled,
    connected,
    testDone,
  });
  const shownStep = openStep ?? (current === 'done' ? null : current);
  const vat = useMemo(() => vatLabel(cfg?.vat_map_json ?? null, protocol), [cfg?.vat_map_json, protocol]);
  const model = findModel(form.modelId);
  const savedModel = findModel(formFromConfig(cfg).modelId);
  const till = tillSummary(tillConfigured, answer);
  const linkS = linkSummary(enrolled, connected, agentRunning);

  // ------------------------------------------------------------ step 1 actions
  async function refreshPorts() {
    setPortsBusy(true);
    try {
      setPorts(await listPorts());
    } catch (err) {
      logger.warn('fiscal-guide', 'listPorts failed', { err: String(err) });
    } finally {
      setPortsBusy(false);
    }
  }

  async function autoSearch() {
    stopSearch.current = false;
    setSearchResult(null);
    setSaveTest(IDLE);
    let list: PortInfo[] = [];
    try {
      list = await listPorts();
      setPorts(list);
    } catch (err) {
      logger.warn('fiscal-guide', 'listPorts failed', { err: String(err) });
    }
    const ordered = orderPortsForSearch(list, form.serial_port ?? cfg?.serial_port ?? null);
    const baud = model?.defaults.baud ?? 115200;
    const reports: ProbeReport[] = [];
    for (let i = 0; i < ordered.length; i++) {
      if (stopSearch.current) break;
      const p = ordered[i];
      setTick(0);
      setSearch({ port: p.name, baud, i: i + 1, total: ordered.length, since: nowSec() });
      try {
        const r = await guideApi.probe(p.name, baud);
        reports.push(r);
        logger.info('fiscal-guide', 'probe', {
          port: p.name,
          outcome: classifyProbe(r),
          dialect: r.recommended_dialect,
          baud: r.recommended_baud,
        });
        const hit = probeToForm(r);
        if (hit) {
          setForm((f) => ({ ...f, ...hit }));
          break;
        }
      } catch (err) {
        reports.push({
          port: p.name,
          configured_baud: baud,
          attempts: [{ dialect: '-', baud, ok: false, error: errText(err) }],
          recommended_dialect: null,
          recommended_baud: null,
          all_nak_hint: false,
        });
      }
    }
    setSearch(null);
    setSearchResult(stopSearch.current && !reports.some((r) => probeToForm(r)) ? null : summariseSearch(reports, list.length));
  }

  async function saveAndTest() {
    const problem = formProblem(form);
    if (problem) {
      setSaveTest({ state: 'err', e: { title: problem, checks: [] }, raw: '' });
      return;
    }
    setSaveTest({ state: 'busy' });
    // Stay on step 1 until the test answers, even though the saved row
    // already counts as "configured".
    setOpenStep(1);
    try {
      const next = buildRuntimeConfig(cfg ?? emptyRuntimeConfig(), form);
      logger.info('fiscal-guide', 'save', {
        provider: next.provider,
        serial_port: next.serial_port,
        baud: next.baud,
        protocol_variant: next.protocol_variant,
        operator: next.operator,
        has_password: Boolean(next.operator_password),
      });
      const written = await setFiscalRuntimeConfig(next);
      setCfg(written);
      await enableRustFiscalIfAllowed().catch(() => false);
    } catch (err) {
      setSaveTest({ state: 'err', e: { title: 'Nu am putut salva setările.', checks: ['Închide fereastra și încearcă din nou.'] }, raw: errText(err) });
      return;
    }
    try {
      const r = await guideApi.testConnection();
      setLocalCheck({ ok: r.ok, at: nowSec() });
      if (r.ok) {
        setSaveTest({ state: 'ok', text: 'Casa răspunde ✓' });
        setOpenStep(null);
      } else {
        setSaveTest({ state: 'err', e: explainFiscalError(r.detail), raw: r.detail });
      }
    } catch (err) {
      setLocalCheck({ ok: false, at: nowSec() });
      setSaveTest({ state: 'err', e: explainFiscalError(errText(err)), raw: errText(err) });
    }
    refreshHealth();
  }

  // ------------------------------------------------------------ step 2 actions
  async function pasteCode() {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setCode(normaliseEnrollmentCode(t).display);
    } catch {
      codeRef.current?.focus();
    }
  }

  async function linkStation() {
    const c = normaliseEnrollmentCode(code);
    if (!c.valid) {
      setLink({ state: 'err', e: { title: 'Codul are 8 caractere, de forma ABCD-1234.', checks: ['Copiază-l din nou din admin.'] }, raw: '' });
      return;
    }
    setLink({ state: 'busy' });
    const server = creds?.server_base_url || DEFAULT_SERVER;
    const printerModel = cfg?.provider && cfg.provider !== 'simulator' ? cfg.provider : (model?.provider ?? 'datecs_dp25');
    try {
      const r = await guideApi.claim(server, c.display, printerModel, deviceId || null);
      await guideApi.run(r.websocket_url, r.device_token, printerModel);
      logger.info('fiscal-guide', 'claim + WSS started', { bridge_id: r.bridge_id });
      try {
        const pulled = await pullFiscalConfig(server, r.device_token);
        setProtocol(pulled.protocol ?? null);
      } catch (e) {
        logger.warn('fiscal-guide', 'pullFiscalConfig failed', { err: String(e) });
      }
      // Apply the agent mode now that credentials exist: stops the old
      // bundled fiscal-bridge and (re)starts the integrated agent if the
      // previous loop had ended.
      await shellApi.fiscalReconnect().then(setHealth).catch(() => {});
      setCreds(await guideApi.savedCredentials().catch(() => null));
      setCode('');
      setLink({ state: 'ok', text: 'Stația e legată ✓' });
      setOpenStep(null);
    } catch (err) {
      setLink({ state: 'err', e: explainClaimError(errText(err)), raw: errText(err) });
      logger.error('fiscal-guide', 'claim failed', { err: String(err) });
    }
    refreshHealth();
  }

  async function relink() {
    setConfirmRelink(false);
    try {
      await guideApi.clearCredentials();
      logger.info('fiscal-guide', 'saved credentials cleared — re-enrollment required');
    } catch (err) {
      setLink({ state: 'err', e: { title: 'Nu am putut șterge legătura veche.', checks: [] }, raw: errText(err) });
      return;
    }
    setCreds(null);
    setLink(IDLE);
    setOpenStep(2);
    refreshHealth();
    setTimeout(() => codeRef.current?.focus(), 50);
  }

  // ------------------------------------------------------------ step 3 actions
  async function printTestBill() {
    setBill({ state: 'busy' });
    try {
      const r = await new RustFiscalAdapter().printReceipt({
        mutationId: crypto.randomUUID(),
        orderId: `ghid-test-${Date.now()}`,
        fiscalAttemptId: crypto.randomUUID(),
        operator: { code: cfg?.operator ?? '1', password: cfg?.operator_password ?? '0001' },
        lines: [{ name: 'Produs test', quantity: 1, unitPriceCents: 100, vatGroup: 'A' }],
        payments: [{ method: 'cash', amountCents: 100 }],
      });
      if (r.status === 'printed') {
        setBill({ state: 'ok', text: r.fiscalNumber ? `Bonul a ieșit ✓ (bon nr. ${r.fiscalNumber})` : 'Bonul a ieșit ✓' });
        setLocalCheck({ ok: true, at: nowSec() });
        setTestDone(true);
        setOpenStep(null);
      } else if (r.status === 'unknown') {
        setBill({
          state: 'err',
          e: { title: 'Nu știu sigur dacă bonul a ieșit.', checks: ['Uită-te pe rolă înainte să mai încerci, ca să nu iasă de două ori.'] },
          raw: r.errorMessage ?? '',
        });
      } else {
        setBill({ state: 'err', e: explainFiscalError(r.errorMessage ?? r.errorCode), raw: r.errorMessage ?? '' });
      }
    } catch (err) {
      setBill({ state: 'err', e: explainFiscalError(errText(err)), raw: errText(err) });
    }
    refreshHealth();
  }

  async function printX() {
    setXrep({ state: 'busy' });
    try {
      const r = await shellApi.printXReport();
      if (r.status !== 'printed') throw new Error(r.error_message || `Raport X: ${r.status}`);
      setXrep({ state: 'ok', text: 'Raportul X a ieșit ✓ (ziua rămâne deschisă)' });
    } catch (err) {
      setXrep({ state: 'err', e: explainFiscalError(errText(err)), raw: errText(err) });
    }
  }

  async function reconnect() {
    setReconnecting(true);
    try {
      setHealth(await shellApi.fiscalReconnect());
    } catch {
      /* the summary shows the state */
    } finally {
      setReconnecting(false);
      refreshHealth();
    }
  }

  // ------------------------------------------------------------ render
  const searching = search !== null;

  return (
    <div className="space-y-4">
      {/* ======== summary + step indicator (always visible) ======== */}
      <div className="sticky top-0 z-10 -mx-1 rounded-xl border border-slate-800 bg-slate-900/95 p-3 shadow-lg shadow-slate-950/50 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <Dot tone={till.tone} />
            <span className="text-slate-300">Casa de marcat:</span>
            <span className="font-semibold text-slate-100">{till.text}</span>
            {tillConfigured && savedModel ? (
              <span className="truncate text-xs text-slate-500">
                {savedModel.label} · {cfg?.serial_port}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Dot tone={linkS.tone} />
            <span className="text-slate-300">Legătura cu 360booking:</span>
            <span className="font-semibold text-slate-100">{linkS.text}</span>
          </div>
          <button className={`${btnGhost} ml-auto`} onClick={() => void reconnect()} disabled={reconnecting}>
            {reconnecting ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Reconectează acum
          </button>
        </div>
        <ol className="mt-3 flex items-center gap-2">
          {STEP_TITLES.map((t, i) => {
            const n = (i + 1) as 1 | 2 | 3;
            const active = shownStep === n;
            return (
              <li key={t} className="flex min-w-0 flex-1 items-center gap-2">
                <button
                  className={`flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-slate-800 ${active ? 'bg-slate-800' : ''}`}
                  onClick={() => setOpenStep(n)}
                >
                  <StepBadge n={n} state={steps[i]} active={active} />
                  <span className={`truncate text-sm ${active ? 'font-semibold text-slate-100' : 'text-slate-400'}`}>{t}</span>
                </button>
                {i < 2 && <span className={`h-px flex-1 ${steps[i] === 'done' ? 'bg-emerald-500/60' : 'bg-slate-700'}`} />}
              </li>
            );
          })}
        </ol>
      </div>

      {!loaded && (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Spinner /> Se încarcă…
        </div>
      )}

      {/* ======== done ======== */}
      {loaded && current === 'done' && shownStep === null && (
        <div className="space-y-4 rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-5">
          <div>
            <div className="text-xl font-bold text-emerald-100">Gata! Casa de marcat e pregătită.</div>
            <p className="mt-1 text-sm text-emerald-100/80">
              Bonurile din POS-ul web se tipăresc pe {savedModel?.label ?? 'casa de marcat'}
              {cfg?.serial_port ? ` (${cfg.serial_port})` : ''}. Dacă pică internetul, folosește Casa offline (Ctrl+Shift+O).
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={btnSecondary} onClick={() => void printX()} disabled={xrep.state === 'busy'}>
              {xrep.state === 'busy' ? <Spinner /> : <Printer className="h-4 w-4" />} Raport X (nu închide ziua)
            </button>
            <button className={btnSecondary} onClick={() => setOpenStep(3)}>
              Tipărește un bon de test
            </button>
            <button className={btnGhost} onClick={() => setOpenStep(1)}>
              Schimbă setările casei
            </button>
          </div>
          <Result o={xrep} />
        </div>
      )}

      {/* ======== step 1 ======== */}
      {loaded && (
        <StepCard
          n={1}
          state={steps[0]}
          open={shownStep === 1}
          onOpen={() => setOpenStep(1)}
          title={STEP_TITLES[0]}
          summary={
            tillConfigured
              ? `${savedModel?.label ?? cfg?.provider} pe ${cfg?.serial_port} · ${till.text}`
              : 'Alegi modelul, găsesc portul, verific că răspunde.'
          }
        >
          <div className="space-y-5">
            <section className="space-y-2">
              <h4 className="text-sm font-semibold text-slate-200">Ce casă de marcat ai?</h4>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                {TILL_MODELS.map((m) => {
                  const selected = form.modelId === m.id;
                  return (
                    <button
                      key={m.id}
                      disabled={!m.supported || searching}
                      onClick={() => setForm(defaultsForModel(m.id, form))}
                      className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                        selected
                          ? 'border-sky-500 bg-sky-600/20 text-white'
                          : m.supported
                            ? 'border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500'
                            : 'cursor-not-allowed border-slate-800 bg-slate-900/40 text-slate-600'
                      }`}
                    >
                      <div className="font-semibold">{m.label}</div>
                      <div className="text-xs opacity-80">
                        {m.verified ? 'verificată la noi ✓' : m.supported ? 'suportată' : m.note}
                      </div>
                    </button>
                  );
                })}
              </div>
              {model?.note && model.supported ? <p className="text-xs text-slate-400">{model.note}</p> : null}
              {!form.modelId && cfg?.provider && isRealProvider(cfg.provider) ? (
                <p className="text-xs text-amber-300">Casa e configurată din „Avansat” ({cfg.provider}). Alege modelul ca s-o configurezi din ghid.</p>
              ) : null}
            </section>

            <section className="space-y-2">
              <h4 className="text-sm font-semibold text-slate-200">Unde e legată de calculator?</h4>
              <p className="text-xs text-slate-400">Casa trebuie să fie pornită și legată cu cablul USB.</p>
              <div className="flex flex-wrap items-center gap-2">
                <button className={btnPrimary} onClick={() => void autoSearch()} disabled={searching || !model?.supported}>
                  {searching ? <Spinner /> : <Search className="h-4 w-4" />} Caută casa automat
                </button>
                {searching ? (
                  <button className={btnSecondary} onClick={() => (stopSearch.current = true)}>
                    Oprește căutarea
                  </button>
                ) : (
                  <button className={btnGhost} onClick={() => setManual((v) => !v)}>
                    <Usb className="h-4 w-4" /> Aleg eu portul
                  </button>
                )}
                {form.serial_port && !searching ? (
                  <span className="text-sm text-slate-300">
                    Port ales: <b className="text-slate-100">{form.serial_port}</b> · viteza {form.baud}
                  </span>
                ) : null}
              </div>

              {search && (
                <div className="flex items-start gap-3 rounded-lg border border-sky-500/30 bg-sky-950/30 px-3 py-2.5 text-sm text-sky-100">
                  <Spinner className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-semibold">
                      Încerc {search.port} la {search.baud}…
                    </div>
                    <div className="text-xs text-sky-200/70">
                      Portul {search.i} din {search.total} · apoi celelalte viteze · {tick} s
                    </div>
                  </div>
                </div>
              )}
              {searchResult && !search && (searchResult.ok ? <OkBox>{searchResult.title}</OkBox> : <ProblemBox e={searchResult} />)}

              {manual && !searching && (
                <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3 sm:grid-cols-[1fr_auto_160px] sm:items-end">
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold text-slate-300">Port</span>
                    <select
                      className={inputCls}
                      value={form.serial_port ?? ''}
                      onChange={(e) => setForm({ ...form, serial_port: e.target.value || null })}
                    >
                      <option value="">— alege —</option>
                      {ports.map((p) => (
                        <option key={p.name} value={p.name}>
                          {portLabel(p)}
                        </option>
                      ))}
                      {form.serial_port && !ports.some((p) => p.name === form.serial_port) ? (
                        <option value={form.serial_port}>{form.serial_port} (salvat, nu e conectat acum)</option>
                      ) : null}
                    </select>
                  </label>
                  <button className={btnSecondary} onClick={() => void refreshPorts()} disabled={portsBusy}>
                    {portsBusy ? <Spinner /> : <RefreshCw className="h-4 w-4" />} Reîmprospătează
                  </button>
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold text-slate-300">Viteză (baud)</span>
                    <select className={inputCls} value={form.baud} onChange={(e) => setForm({ ...form, baud: Number(e.target.value) })}>
                      {SUPPORTED_BAUDS.map((b) => (
                        <option key={b} value={b}>
                          {b}
                          {b === model?.defaults.baud ? ' (recomandat)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {ports.length === 0 && (
                    <p className="text-xs text-amber-300 sm:col-span-3">
                      Nu văd niciun port. Verifică cablul USB și driverul casei, apoi apasă „Reîmprospătează”.
                    </p>
                  )}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h4 className="text-sm font-semibold text-slate-200">Operator și parolă</h4>
              <div className="grid max-w-md grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-xs text-slate-400">Operator</span>
                  <input className={inputCls} value={form.operator} onChange={(e) => setForm({ ...form, operator: e.target.value })} />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-slate-400">Parolă</span>
                  <input
                    className={`${inputCls} font-mono`}
                    value={form.operator_password}
                    onChange={(e) => setForm({ ...form, operator_password: e.target.value })}
                  />
                </label>
              </div>
              <p className="text-xs text-slate-400">
                Valorile din fabrică; schimbă-le doar dacă le-a modificat service-ul casei.
              </p>
            </section>

            <div className="space-y-3 border-t border-slate-800 pt-4">
              <button className={btnPrimary} onClick={() => void saveAndTest()} disabled={saveTest.state === 'busy' || searching}>
                {saveTest.state === 'busy' ? <Spinner /> : null} Salvează și testează
              </button>
              <Result o={saveTest} />
            </div>
          </div>
        </StepCard>
      )}

      {/* ======== step 2 ======== */}
      {loaded && (
        <StepCard
          n={2}
          state={steps[1]}
          open={shownStep === 2}
          onOpen={() => setOpenStep(2)}
          title={STEP_TITLES[1]}
          summary={
            enrolled
              ? `Stația e legată ✓ — ${connected ? 'conectat la server' : agentRunning ? 'se conectează…' : 'fără conexiune acum'}`
              : 'O singură dată, cu un cod din adminul 360booking.'
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-slate-300">
              Ca bonurile din POS-ul web să ajungă la casa asta, stația trebuie legată o singură dată de contul restaurantului.
            </p>

            {enrolled && !confirmRelink ? (
              <div className="space-y-3">
                <OkBox>
                  <div className="font-semibold">
                    Stația e legată ✓ — {connected ? 'conectat la server' : agentRunning ? 'se conectează la server…' : 'fără conexiune acum'}
                  </div>
                  {creds?.claimed_at ? <div className="text-xs text-emerald-200/70">Legată la {fmtDate(creds.claimed_at)}</div> : null}
                  {!connected && !agentRunning ? (
                    <div className="text-xs text-emerald-200/70">Verifică internetul; apasă „Reconectează acum” sus.</div>
                  ) : null}
                </OkBox>
                <Result o={link} hideOk />
                <button className={btnGhost} onClick={() => setConfirmRelink(true)}>
                  <Link2 className="h-4 w-4" /> Leagă din nou
                </button>
              </div>
            ) : enrolled && confirmRelink ? (
              <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-950/30 p-3 text-sm text-amber-100">
                <div className="font-semibold">Legi stația din nou?</div>
                <p>
                  Legătura de acum se șterge și ai nevoie de un cod nou din admin. Fă asta doar dacă ai schimbat restaurantul sau
                  te-a rugat service-ul.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400" onClick={() => void relink()}>
                    Da, leagă din nou
                  </button>
                  <button className={btnSecondary} onClick={() => setConfirmRelink(false)}>
                    Renunță
                  </button>
                </div>
              </div>
            ) : (
              <>
                <ol className="ml-5 list-decimal space-y-1 text-sm text-slate-300">
                  <li>
                    Pe telefon sau pe alt calculator, intră în adminul 360booking: <b className="text-slate-100">Restaurant → Fiscal</b>.
                  </li>
                  <li>
                    La <b className="text-slate-100">Casa de marcat (bridge)</b> apasă <b className="text-slate-100">Activează</b>, apoi{' '}
                    <b className="text-slate-100">Copiază</b> codul (e valabil 10 minute).
                  </li>
                  <li>Lipește codul aici și apasă „Leagă”.</li>
                </ol>
                <p className="text-xs text-slate-500">Nu descărca nimic de pe pagina din admin — aplicația asta face legătura singură.</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={codeRef}
                    className={`${inputCls.replace('w-full ', '')} w-52 font-mono text-lg uppercase tracking-widest`}
                    placeholder="ABCD-1234"
                    value={code}
                    onChange={(e) => setCode(normaliseEnrollmentCode(e.target.value).display)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void linkStation();
                    }}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button className={btnSecondary} onClick={() => void pasteCode()}>
                    <ClipboardPaste className="h-4 w-4" /> Lipește
                  </button>
                  <button
                    className={btnPrimary}
                    onClick={() => void linkStation()}
                    disabled={link.state === 'busy' || !normaliseEnrollmentCode(code).valid}
                  >
                    {link.state === 'busy' ? <Spinner /> : <Link2 className="h-4 w-4" />} Leagă
                  </button>
                </div>
                <Result o={link} />
              </>
            )}
          </div>
        </StepCard>
      )}

      {/* ======== step 3 ======== */}
      {loaded && (
        <StepCard
          n={3}
          state={steps[2]}
          open={shownStep === 3}
          onOpen={() => setOpenStep(3)}
          title={STEP_TITLES[2]}
          summary={testDone ? 'Bonul de test a ieșit ✓' : 'Un bon fiscal real de 1 leu, ca să vezi că totul merge.'}
        >
          <div className="space-y-4">
            <p className="text-sm text-slate-300">
              Bonul de test e un bon fiscal adevărat: 1 leu, plătit numerar, cota A{vat ? ` (${vat})` : ''}. Apare în raportul zilei —
              e normal.
            </p>
            {!tillConfigured && (
              <p className="text-sm text-amber-300">Mai întâi fă pasul 1, ca să știu pe ce casă tipăresc.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <button className={btnPrimary} onClick={() => void printTestBill()} disabled={bill.state === 'busy' || !tillConfigured}>
                {bill.state === 'busy' ? <Spinner /> : <Printer className="h-4 w-4" />} Tipărește un bon de test de 1 leu
              </button>
              <button className={btnSecondary} onClick={() => void printX()} disabled={xrep.state === 'busy' || !tillConfigured}>
                {xrep.state === 'busy' ? <Spinner /> : null} Raport X (nu închide ziua)
              </button>
            </div>
            <Result o={bill} />
            <Result o={xrep} />
          </div>
        </StepCard>
      )}

      {/* ======== Avansat (service) ======== */}
      <ServiceSection health={health} onChanged={() => void reloadAll()} />
    </div>
  );
}

function StepCard({
  n,
  state,
  open,
  onOpen,
  title,
  summary,
  children,
}: {
  n: 1 | 2 | 3;
  state: StepState;
  open: boolean;
  onOpen: () => void;
  title: string;
  summary: string;
  children: React.ReactNode;
}) {
  const border =
    state === 'done'
      ? 'border-emerald-500/30'
      : state === 'error'
        ? 'border-rose-500/40'
        : state === 'warn'
          ? 'border-amber-500/40'
          : open
            ? 'border-sky-600/50'
            : 'border-slate-800';
  return (
    <section className={`rounded-xl border ${border} bg-slate-900/60`}>
      <header className="flex items-center gap-3 p-4">
        <StepBadge n={n} state={state} active={open} />
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-slate-100">
            Pasul {n}. {title}
          </h3>
          {!open && <p className="truncate text-sm text-slate-400">{summary}</p>}
        </div>
        {!open && (
          <button className={btnGhost} onClick={onOpen}>
            {state === 'done' ? 'Modifică' : 'Deschide'}
          </button>
        )}
        {state === 'error' && !open ? <ShieldAlert className="h-4 w-4 text-rose-400" /> : null}
      </header>
      {open && <div className="border-t border-slate-800 p-4">{children}</div>}
    </section>
  );
}

function Result({ o, hideOk = false }: { o: Outcome; hideOk?: boolean }) {
  if (o.state === 'ok') return hideOk ? null : <OkBox>{o.text}</OkBox>;
  if (o.state === 'err') return <ProblemBox e={o.e} raw={o.raw} />;
  return null;
}

function fmtDate(s: string): string {
  const d = new Date(s.includes('T') || s.endsWith('Z') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('ro-RO');
}
