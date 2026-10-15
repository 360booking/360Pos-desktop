/**
 * Ghidul casei de marcat — what the restaurant owner sees in the window
 * „Casa de marcat”, opened from the POS: Setări → Casa de marcat →
 * „Configurează casa de marcat” (or Ctrl+Shift+F, for service).
 *
 *   1. Găsește casa de marcat — model, automatic port search, save + test
 *   „Legare” — a status line, no longer a step to do by hand (2026-10-14):
 *      the admin page links the app to the restaurant automatically
 *      (fresh code → desktopBridge.fiscal.link). The manual code field
 *      lives only in „Avansat (service)”.
 *   3. Bon de test — a real 1-leu bill
 *
 * Everything technical (raw fields, protocol variant, pull config, manual
 * pairing, probe sweep, raw bytes, agent state) lives unchanged in the
 * collapsed „Avansat (service)” section at the bottom.
 *
 * No new storage: the guide writes the same fiscal_runtime_config row as the
 * service form and enrols through the same commands, so the offline till,
 * the agent auto-start and web POS printing keep working as before.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCopy, FolderOpen, Link2, Printer, RefreshCw, Search, ShieldAlert, Usb } from 'lucide-react';

import { enableRustFiscalIfAllowed } from '@/adapters';
import { getCachedFiscalConfig } from '@/adapters/fiscal/config';
import { RustFiscalAdapter } from '@/adapters/fiscal/rust';
import {
  getFiscalRuntimeConfig,
  setFiscalRuntimeConfig,
  type FiscalRuntimeConfig,
} from '@/adapters/fiscal/runtime-config';
import { logger } from '@/lib/logger';
import { errText, shellApi, type AgentSummary, type FiscalHealth } from '@/shell/api';

import { guideApi, listPorts, type BridgeState, type SavedBridgeCredentials } from './api';
import {
  SUPPORTED_BAUDS,
  TILL_MODELS,
  buildRuntimeConfig,
  completeOnOpen,
  defaultsForModel,
  deriveSteps,
  explainConnectionError,
  explainFiscalError,
  findModel,
  formFromConfig,
  formProblem,
  isRealProvider,
  linkLine,
  linkSummary,
  portLabel,
  isoToDdmmyy,
  localIsoDate,
  periodicRangeProblem,
  previousMonthRange,
  printerAnswer,
  printerNotice,
  registerChips,
  summariseDetect,
  detectProgressText,
  tillSummary,
  vatLabel,
  type AutoLinkState,
  type Explained,
  type GuideForm,
  type LocalCheck,
  type DetectProgress,
  type DetectSummary,
  type PortInfo,
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
    // No "simulator" default (2026-10-14): an unsaved station has no register.
    provider: null,
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

const STEP_TITLES = ['Găsește casa de marcat', 'Legătura cu restaurantul', 'Bon de test'] as const;

export function FiscalGuide() {
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
  const [search, setSearch] = useState<{ progress: DetectProgress | null } | null>(null);
  const [searchResult, setSearchResult] = useState<DetectSummary | null>(null);
  const [manual, setManual] = useState(false);
  const [portsBusy, setPortsBusy] = useState(false);
  const [saveTest, setSaveTest] = useState<Outcome>(IDLE);
  const [localCheck, setLocalCheck] = useState<LocalCheck | null>(null);
  const [tick, setTick] = useState(0);

  // ------------------------------------------------------------ „Legare”
  const [autoLink, setAutoLink] = useState<AutoLinkState | null>(null);
  const [retrying, setRetrying] = useState(false);
  const lastLinkAt = useRef(0);

  // ------------------------------------------------------------ step 3
  const [bill, setBill] = useState<Outcome>(IDLE);
  const [xrep, setXrep] = useState<Outcome>(IDLE);
  const [testDone, setTestDone] = useState(false);

  // ------------------------------------------------------------ reports + help
  const [zStep, setZStep] = useState<0 | 1 | 2>(0);
  const [zrep, setZrep] = useState<Outcome>(IDLE);
  const [perRange, setPerRange] = useState(() => previousMonthRange(new Date()));
  const [perRep, setPerRep] = useState<Outcome>(IDLE);
  const [diag, setDiag] = useState<Outcome>(IDLE);
  const [diagText, setDiagText] = useState<string | null>(null);

  // ------------------------------------------------------------ layout
  const [openStep, setOpenStep] = useState<1 | 2 | 3 | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const refreshHealth = useCallback(() => {
    shellApi.fiscalHealth().then(setHealth).catch(() => {});
    guideApi.bridgeState().then(setBridge).catch(() => {});
    shellApi
      .fiscalLinkState()
      .then((l) => {
        setAutoLink(l);
        // A link that just finished saved new credentials: show them.
        if (l && l.state === 'ok' && l.at !== lastLinkAt.current) {
          lastLinkAt.current = l.at;
          guideApi.savedCredentials().then(setCreds).catch(() => {});
          getCachedFiscalConfig()
            .then((c) => setProtocol(c?.protocol ?? null))
            .catch(() => {});
        }
      })
      .catch(() => {});
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
  const searchActive = search !== null;
  useEffect(() => {
    if (!searchActive) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [searchActive]);

  // ------------------------------------------------------------ derived
  const configSaved = Boolean(cfg?.updated_at);
  const enrolled = Boolean(creds) || Boolean(health?.agent.hasSavedCredentials);
  const connected = Boolean(bridge?.connected) || Boolean(health?.agent.connected);
  const agentRunning = Boolean(bridge?.configured) || Boolean(health?.agent.running);
  // The server refused the saved token (admin „Deconectează”): step 2 must
  // not keep saying „Stația e legată ✓”.
  const revoked = !connected && (Boolean(bridge?.revoked) || Boolean(health?.agent.revoked));
  const connError = enrolled && !connected ? (bridge?.last_error ?? health?.agent.lastError ?? null) : null;
  const answer = printerAnswer(health?.printer ?? null, localCheck);
  const notice = printerNotice(health?.printer ?? null);
  const chips = health?.printer.monitored ? registerChips(health.printer.register) : [];
  const tillConfigured = configSaved && isRealProvider(cfg?.provider) && Boolean(cfg?.serial_port);
  const { steps, current } = deriveSteps({
    configSaved,
    provider: cfg?.provider ?? null,
    serialPort: cfg?.serial_port ?? null,
    printerOk: answer,
    enrolled,
    connected,
    revoked,
    testDone,
  });
  // Step 2 is no longer a card: when only the link is missing, the next
  // thing to do here is the test bill.
  const shownStep = openStep ?? (current === 'done' ? null : current === 2 ? (testDone ? null : 3) : current);
  const vat = useMemo(() => vatLabel(cfg?.vat_map_json ?? null, protocol), [cfg?.vat_map_json, protocol]);
  const model = findModel(form.modelId);
  const savedModel = findModel(formFromConfig(cfg).modelId);
  const till = tillSummary(tillConfigured, answer);
  const linkS = linkSummary(enrolled, connected, agentRunning, revoked);
  const line = linkLine({ enrolled, connected, running: agentRunning, revoked, auto: autoLink });

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

  /** „Caută casa automat” — the app probes the ports itself (STATUS only)
   *  and saves port + speed when the register answers. `includeOthers` =
   *  the owner confirmed „Încearcă și celelalte porturi”. */
  async function autoSearch(includeOthers = false) {
    setSearchResult(null);
    setSaveTest(IDLE);
    setTick(0);
    setSearch({ progress: null });
    const unlisten = await guideApi
      .onDetectProgress((p) => {
        setSearch({ progress: p });
      })
      .catch(() => null);
    try {
      const r = await guideApi.detect(includeOthers);
      logger.info('fiscal-guide', 'detect', {
        found: r.found?.port ?? null,
        baud: r.found?.baud ?? null,
        dialect: r.found?.dialect ?? null,
        vid: r.found?.vid ?? null,
        pid: r.found?.pid ?? null,
        saved: r.saved,
        tried: r.tried.map((t) => `${t.port}:${t.outcome}`),
        not_tried: r.not_tried.map((t) => t.port),
        excluded: r.excluded.map((t) => t.port),
      });
      if (r.found) {
        const f = r.found;
        setForm((cur) => ({ ...cur, serial_port: f.port, baud: f.baud, protocol_variant: f.dialect }));
        if (r.saved) {
          setLocalCheck({ ok: true, at: nowSec() });
          try {
            setCfg(await getFiscalRuntimeConfig());
          } catch {
            /* shown again on the next load */
          }
          await enableRustFiscalIfAllowed().catch(() => false);
        }
      }
      setSearchResult(summariseDetect(r));
    } catch (err) {
      setSearchResult({
        ok: false,
        title: 'Căutarea nu a putut porni.',
        checks: [errText(err)],
        askOthers: false,
        notice: null,
      });
    } finally {
      unlisten?.();
      setSearch(null);
      void listPorts()
        .then(setPorts)
        .catch(() => {});
      refreshHealth();
    }
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

  // ------------------------------------------------------------ „Legare” actions
  /** Redo the automatic link: the POS window opens Setări → Casa de marcat,
   *  which asks the server for a fresh code (needs the administrator). */
  async function retryLink() {
    setRetrying(true);
    try {
      await shellApi.openFiscalLinkPage();
    } catch (err) {
      logger.warn('fiscal-guide', 'open link page failed', { err: errText(err) });
    } finally {
      setTimeout(() => setRetrying(false), 1500);
    }
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

  async function printZ() {
    setZStep(0);
    setZrep({ state: 'busy' });
    try {
      const token = await shellApi.requestZConfirm();
      const r = await shellApi.printZReport(token);
      if (r.status !== 'printed') throw new Error(r.error_message || `Raport Z: ${r.status}`);
      logger.info('fiscal-guide', 'Z report printed');
      setZrep({ state: 'ok', text: 'Raportul Z a ieșit ✓ — ziua fiscală e închisă.' });
    } catch (err) {
      logger.error('fiscal-guide', 'Z report failed', { err: errText(err) });
      setZrep({ state: 'err', e: explainFiscalError(errText(err)), raw: errText(err) });
    }
  }

  async function printPeriodic() {
    const problem = periodicRangeProblem(perRange.from, perRange.to, localIsoDate(new Date()));
    if (problem) {
      setPerRep({ state: 'err', e: { title: problem, checks: [] }, raw: '' });
      return;
    }
    setPerRep({ state: 'busy' });
    try {
      const r = await shellApi.printPeriodicReport(isoToDdmmyy(perRange.from)!, isoToDdmmyy(perRange.to)!);
      if (r.status !== 'printed') throw new Error(r.error_message || `Raport periodic: ${r.status}`);
      setPerRep({ state: 'ok', text: 'Raportul periodic (memoria fiscală) a ieșit ✓' });
    } catch (err) {
      setPerRep({ state: 'err', e: explainFiscalError(errText(err)), raw: errText(err) });
    }
  }

  async function copyDiagnostics() {
    setDiag({ state: 'busy' });
    let text: string;
    try {
      text = await shellApi.diagnostics();
    } catch (err) {
      setDiag({ state: 'err', e: { title: 'Nu am putut aduna diagnosticul.', checks: [] }, raw: errText(err) });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setDiagText(null);
      setDiag({ state: 'ok', text: 'Diagnosticul e copiat ✓ — lipește-l (Ctrl+V) în mesajul către 360booking.' });
    } catch {
      // Clipboard refused: show the text so it can be selected by hand.
      setDiagText(text);
      setDiag({ state: 'ok', text: 'Selectează textul de mai jos (Ctrl+A, Ctrl+C) și trimite-l la 360booking.' });
    }
  }

  async function openLogs() {
    try {
      const dir = await shellApi.openLogDir();
      setDiag({ state: 'ok', text: `Am deschis folderul de jurnale: ${dir}` });
    } catch (err) {
      setDiag({ state: 'err', e: { title: 'Nu am putut deschide folderul de jurnale.', checks: [] }, raw: errText(err) });
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
          {chips.length > 0 ? (
            <div className="flex basis-full flex-wrap gap-1.5" aria-label="Starea casei">
              {chips.map((c) => (
                <span
                  key={c.text}
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    c.tone === 'bad' ? 'bg-rose-500/20 text-rose-200' : 'bg-amber-400/20 text-amber-200'
                  }`}
                >
                  {c.text}
                </span>
              ))}
            </div>
          ) : null}
          {notice ? <div className="basis-full text-xs text-amber-300">{notice}</div> : null}
          <div className="flex items-center gap-2 text-sm">
            <Dot tone={linkS.tone} />
            <span className="text-slate-300">Legătura cu restaurantul:</span>
            <span className="font-semibold text-slate-100">{linkS.text}</span>
          </div>
          <button className={`${btnGhost} ml-auto`} onClick={() => void reconnect()} disabled={reconnecting}>
            {reconnecting ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Reconectează acum
          </button>
        </div>
        {connError ? (
          <div className="mt-2 text-sm text-rose-300" role="status">
            Nu mă pot conecta la server: {explainConnectionError(connError)}
          </div>
        ) : null}
        <ol className="mt-3 flex items-center gap-2">
          {STEP_TITLES.map((t, i) => {
            const n = (i + 1) as 1 | 2 | 3;
            const active = shownStep === n;
            return (
              <li key={t} className="flex min-w-0 flex-1 items-center gap-2">
                <button
                  className={`flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left ${n === 2 ? 'cursor-default' : 'hover:bg-slate-800'} ${active ? 'bg-slate-800' : ''}`}
                  onClick={() => (n === 2 ? undefined : setOpenStep(n))}
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
            <button className={btnSecondary} onClick={() => setOpenStep(3)}>
              Tipărește un bon de test
            </button>
            <button className={btnGhost} onClick={() => setOpenStep(1)}>
              Schimbă setările casei
            </button>
          </div>
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
                <button className={btnPrimary} onClick={() => void autoSearch(false)} disabled={searching || !model?.supported}>
                  {searching ? <Spinner /> : <Search className="h-4 w-4" />} Caută casa automat
                </button>
                {searching ? (
                  <button className={btnSecondary} onClick={() => void guideApi.cancelDetect().catch(() => {})}>
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
                      {search.progress ? detectProgressText(search.progress).title : 'Caut porturile casei…'}
                    </div>
                    <div className="text-xs text-sky-200/70">
                      {search.progress ? detectProgressText(search.progress).sub : 'doar citesc starea casei, nu tipăresc nimic'} · {tick} s
                    </div>
                  </div>
                </div>
              )}
              {searchResult && !search && (
                <div className="space-y-2">
                  {searchResult.ok ? (
                    <OkBox>
                      {searchResult.title}
                      {searchResult.notice ? <div className="mt-1 text-amber-200">{searchResult.notice}</div> : null}
                    </OkBox>
                  ) : (
                    <ProblemBox e={searchResult} />
                  )}
                  {searchResult.askOthers ? (
                    <button className={btnSecondary} onClick={() => void autoSearch(true)} disabled={searching}>
                      <Search className="h-4 w-4" /> Încearcă și celelalte porturi
                    </button>
                  ) : null}
                </div>
              )}

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

      {/* ======== „Legare” — automatic, a status line (was step 2) ======== */}
      {loaded && (
        <section className={`rounded-xl border ${line.tone === 'ok' ? 'border-emerald-500/30' : line.tone === 'bad' ? 'border-rose-500/40' : 'border-slate-800'} bg-slate-900/60 p-4`}>
          <div className="flex flex-wrap items-center gap-3">
            <StepBadge n={2} state={steps[1]} active={false} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-slate-100">Legare:</span>
                <Dot tone={line.tone} />
                <span className="text-slate-200">{line.text}</span>
                {line.tone === 'wait' && autoLink?.state === 'linking' ? <Spinner className="h-3.5 w-3.5" /> : null}
              </div>
              {line.hint ? <p className="mt-0.5 text-xs text-slate-400">{line.hint}</p> : null}
              {creds?.claimed_at && enrolled && !revoked ? (
                <p className="mt-0.5 text-xs text-slate-500">Legată la {fmtDate(creds.claimed_at)}</p>
              ) : null}
            </div>
            {line.action === 'retry' ? (
              <button className={btnSecondary} onClick={() => void retryLink()} disabled={retrying}>
                {retrying ? <Spinner /> : <Link2 className="h-4 w-4" />} Reîncearcă legarea
              </button>
            ) : null}
          </div>
        </section>
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
            </div>
            <p className="text-xs text-slate-400">Raportul X și raportul Z sunt mai jos, la „Rapoarte fiscale”.</p>
            <Result o={bill} />
          </div>
        </StepCard>
      )}

      {/* ======== Rapoarte fiscale (only from this app, never from the web) ======== */}
      {loaded && (
        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="text-base font-semibold text-slate-100">Rapoarte fiscale</h3>
          <p className="text-sm text-slate-400">
            Rapoartele X, Z și raportul periodic se dau doar de aici, de pe calculatorul cu casa de marcat.
          </p>
          {!tillConfigured && <p className="text-sm text-amber-300">Mai întâi fă pasul 1, ca să știu pe ce casă tipăresc.</p>}
          <div className="flex flex-wrap gap-2">
            <button className={btnSecondary} onClick={() => void printX()} disabled={xrep.state === 'busy' || !tillConfigured}>
              {xrep.state === 'busy' ? <Spinner /> : <Printer className="h-4 w-4" />} Raport X (nu închide ziua)
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/40 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-900/50 disabled:opacity-50"
              onClick={() => setZStep(1)}
              disabled={zrep.state === 'busy' || !tillConfigured || zStep !== 0}
            >
              {zrep.state === 'busy' ? <Spinner /> : <Printer className="h-4 w-4" />} Raport Z (închide ziua)
            </button>
          </div>
          {zStep === 1 && (
            <div className="space-y-3 rounded-lg border border-rose-500/40 bg-rose-950/40 p-3 text-sm text-rose-100">
              <div className="font-semibold">Închide ziua fiscală — nu se poate anula</div>
              <p>Raportul Z închide ziua pe casa de marcat și se trimite la ANAF. Se dă o singură dată pe zi, la final.</p>
              <div className="flex flex-wrap gap-2">
                <button className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500" onClick={() => setZStep(2)}>
                  Da, vreau să închid ziua
                </button>
                <button className={btnSecondary} onClick={() => setZStep(0)}>
                  Renunță
                </button>
              </div>
            </div>
          )}
          {zStep === 2 && (
            <div className="space-y-3 rounded-lg border border-rose-500/60 bg-rose-950/60 p-3 text-sm text-rose-100">
              <div className="font-semibold">Ești sigur? Închide ziua fiscală — nu se poate anula.</div>
              <p>Apasă „Tipărește raportul Z” doar dacă ai terminat toate bonurile de azi.</p>
              <div className="flex flex-wrap gap-2">
                <button className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500" onClick={() => void printZ()}>
                  Tipărește raportul Z
                </button>
                <button className={btnSecondary} onClick={() => setZStep(0)}>
                  Renunță
                </button>
              </div>
            </div>
          )}
          <Result o={xrep} />
          <Result o={zrep} />
          <div className="flex flex-wrap items-end gap-2 border-t border-slate-800 pt-3 text-sm">
            <label className="flex flex-col gap-1 text-slate-400">
              De la
              <input
                type="date"
                className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100"
                value={perRange.from}
                onChange={(e) => setPerRange((r) => ({ ...r, from: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-slate-400">
              Până la
              <input
                type="date"
                className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100"
                value={perRange.to}
                onChange={(e) => setPerRange((r) => ({ ...r, to: e.target.value }))}
              />
            </label>
            <button className={btnSecondary} onClick={() => void printPeriodic()} disabled={perRep.state === 'busy' || !tillConfigured}>
              {perRep.state === 'busy' ? <Spinner /> : <Printer className="h-4 w-4" />} Raport periodic (memoria fiscală)
            </button>
          </div>
          <Result o={perRep} />
        </section>
      )}

      {/* ======== Ajutor: diagnostic + jurnale ======== */}
      {loaded && (
        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="text-base font-semibold text-slate-100">Ajutor</h3>
          <p className="text-sm text-slate-400">
            Dacă ceva nu merge, apasă „Copiază diagnosticul” și lipește textul în mesajul către 360booking.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className={btnSecondary} onClick={() => void copyDiagnostics()} disabled={diag.state === 'busy'}>
              {diag.state === 'busy' ? <Spinner /> : <ClipboardCopy className="h-4 w-4" />} Copiază diagnosticul
            </button>
            <button className={btnGhost} onClick={() => void openLogs()}>
              <FolderOpen className="h-4 w-4" /> Deschide folderul de jurnale
            </button>
          </div>
          <Result o={diag} />
          {diagText ? (
            <textarea
              readOnly
              className={`${inputCls} h-48 font-mono text-xs`}
              value={diagText}
              onFocus={(e) => e.currentTarget.select()}
            />
          ) : null}
        </section>
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
