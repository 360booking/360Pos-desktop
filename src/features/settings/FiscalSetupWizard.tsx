/**
 * Fiscal setup — single, opinionated 3-step flow on tab "Casa de marcat".
 *
 *   Pas 1 — Hardware (provider + COM + baud + operator + use_rust)
 *   Pas 2 — Conexiune backend (enrollment code → claim → WSS loop)
 *   Pas 3 — Test (connection / status / print test receipt)
 *
 * Replaces the older trio FiscalHardwareConfigPanel + FiscalBridgePanel +
 * FiscalDiagnosticPanel which lived on the same tab and overlapped (gate
 * checks in two places, claim + pairing fragmented, etc.). Each step has
 * a clear badge — todo / done / error — so the operator knows what's
 * gating the next step. Pull-config + manual pairing + raw probe stay
 * available behind a single "Setări avansate" disclosure.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Save,
  Plug,
  Settings as SettingsIcon,
  Wifi,
  Receipt,
  Send,
  ChevronDown,
  Link2,
} from 'lucide-react';
import {
  getFiscalRuntimeConfig,
  setFiscalRuntimeConfig,
  listSerialPorts,
  type FiscalRuntimeConfig,
} from '@/adapters/fiscal/runtime-config';
import { enableRustFiscalIfAllowed, getFiscal } from '@/adapters';
import type { FiscalReceiptResponse, FiscalStatus } from '@/adapters/fiscal/types';
import {
  getCachedFiscalConfig,
  pullFiscalConfig,
  type FiscalConfigBundle,
} from '@/adapters/fiscal/config';
import {
  clearStationPairing,
  getStationPairing,
  upsertStationPairing,
  type StationPairing,
} from '@/adapters/fiscal/pairing';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';

type AsyncState<T> =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'ok'; value: T }
  | { state: 'err'; error: string };

interface ClaimResponse {
  device_token: string;
  bridge_id: string;
  tenant_id: string;
  websocket_url: string;
}

interface ProbeAttempt {
  dialect: string;
  baud: number;
  ok: boolean;
  error: string | null;
}

interface RawDebugResult {
  dialect: string;
  baud: number;
  frame_sent_hex: string;
  bytes_received_hex: string;
  byte_count: number;
  interpretation: string;
}

interface ProbeReport {
  port: string;
  configured_baud: number;
  attempts: ProbeAttempt[];
  recommended_dialect: string | null;
  recommended_baud: number | null;
  all_nak_hint: boolean;
}

interface BridgeState {
  configured: boolean;
  connected: boolean;
  bridge_id: string | null;
  tenant_id: string | null;
  printer_model: string | null;
  last_heartbeat_at: number | null;
  last_error: string | null;
  close_code: number | null;
}

const PROVIDERS = [
  { value: 'simulator', label: 'Simulator (fără casă fizică)' },
  { value: 'datecs_dp25', label: 'Datecs DP-25 (FP-55)' },
  { value: 'datecs_fp', label: 'Datecs FP-700 / DP-150' },
];
const BAUDS = [9600, 19200, 38400, 57600, 115200];
const VARIANTS = [
  { value: 'fp55', label: 'FP-55 (default DP-25)' },
  { value: 'fp700', label: 'FP-700 (XOR BCC)' },
];
const DEFAULT_SERVER = 'https://360booking.ro';

function emptyHardware(): FiscalRuntimeConfig {
  return {
    provider: 'simulator',
    serial_port: null,
    baud: 9600,
    protocol_variant: 'fp55',
    operator: '1',
    operator_password: '0000',
    printer_model: null,
    use_rust: false,
    enable_raw_logs: false,
    vat_map_json: null,
    cmd_codes_json: null,
  };
}

function loggable(c: FiscalRuntimeConfig) {
  return {
    provider: c.provider,
    serial_port: c.serial_port,
    baud: c.baud,
    protocol_variant: c.protocol_variant,
    operator: c.operator,
    use_rust: c.use_rust,
    has_password: Boolean(c.operator_password),
  };
}

export function FiscalSetupWizard() {
  // ---------------- step 1: hardware ----------------
  const [hw, setHw] = useState<FiscalRuntimeConfig>(emptyHardware());
  const [hwLoaded, setHwLoaded] = useState(false);
  const [hwSavedAt, setHwSavedAt] = useState<string | null>(null);
  const [hwSave, setHwSave] = useState<AsyncState<FiscalRuntimeConfig>>({ state: 'idle' });
  const [ports, setPorts] = useState<string[]>([]);
  const [portsBusy, setPortsBusy] = useState(false);

  // ---------------- step 2: backend pairing ----------------
  const step2Ref = useRef<HTMLElement | null>(null);
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [code, setCode] = useState('');
  const [claim, setClaim] = useState<ClaimResponse | null>(null);
  const [bridgeState, setBridgeState] = useState<BridgeState | null>(null);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const [pairing, setPairing] = useState<StationPairing | null>(null);

  // ---------------- step 3: test ----------------
  const [conn, setConn] = useState<AsyncState<{ ok: boolean; detail: string }>>({ state: 'idle' });
  const [status, setStatus] = useState<AsyncState<FiscalStatus>>({ state: 'idle' });
  const [receipt, setReceipt] = useState<AsyncState<FiscalReceiptResponse>>({ state: 'idle' });

  // ---------------- advanced (collapsed) ----------------
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pullCfg, setPullCfg] = useState<FiscalConfigBundle | null>(null);
  const [pullBusy, setPullBusy] = useState(false);
  const [pullErr, setPullErr] = useState<string | null>(null);
  const [pairFiscal, setPairFiscal] = useState('');
  const [pairTerminal, setPairTerminal] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [pairErr, setPairErr] = useState<string | null>(null);
  const [probe, setProbe] = useState<AsyncState<ProbeReport>>({ state: 'idle' });
  const [rawDebug, setRawDebug] = useState<AsyncState<RawDebugResult[]>>({ state: 'idle' });

  const deviceId = getConfig().deviceId ?? '';

  // initial load
  useEffect(() => {
    void (async () => {
      try {
        const remote = await getFiscalRuntimeConfig();
        setHw({ ...emptyHardware(), ...stripNulls(remote) });
        setHwSavedAt(remote.updated_at ?? null);
        logger.info('fiscal-setup', 'loaded runtime config', loggable(remote));
      } catch (err) {
        logger.warn('fiscal-setup', 'getFiscalRuntimeConfig failed', { err: String(err) });
      }
      setHwLoaded(true);
      void refreshPorts();
      void refreshBridgeState();
      void getCachedFiscalConfig().then((c) => setPullCfg(c)).catch(() => {});
      if (deviceId) void refreshPairing();
    })();
    // Polling at 30s — kept gentle so the rest of the UI doesn't slow
    // down. Manual "Refresh status" button on step 2 covers tighter loops
    // when the operator is actively claiming.
    const id = setInterval(() => void refreshBridgeState(), 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshPorts() {
    setPortsBusy(true);
    try {
      const list = await listSerialPorts();
      setPorts(list);
      logger.debug('fiscal-setup', 'ports listed', { count: list.length, ports: list });
    } catch (err) {
      logger.warn('fiscal-setup', 'listSerialPorts failed', { err: String(err) });
    } finally {
      setPortsBusy(false);
    }
  }

  async function refreshBridgeState() {
    try {
      const s = await invoke<BridgeState>('fiscal_bridge_state');
      setBridgeState(s);
    } catch {
      /* not in tauri or bridge not configured yet */
    }
  }

  async function refreshPairing() {
    if (!deviceId) return;
    try {
      const p = await getStationPairing(deviceId);
      setPairing(p);
      setPairFiscal(p?.fiscal_device_id ?? '');
      setPairTerminal(p?.payment_terminal_id ?? '');
    } catch (e) {
      setPairErr(String(e));
    }
  }

  // ---------------- step 1 actions ----------------
  async function saveHardware() {
    setHwSave({ state: 'busy' });
    logger.info('fiscal-setup', 'save hardware requested', loggable(hw));
    try {
      const written = await setFiscalRuntimeConfig(hw);
      setHw({ ...emptyHardware(), ...stripNulls(written) });
      setHwSavedAt(written.updated_at ?? new Date().toISOString());
      setHwSave({ state: 'ok', value: written });
      const promoted = await enableRustFiscalIfAllowed();
      logger.info('fiscal-setup', 'save hardware ok', {
        ...loggable(written),
        rust_adapter_promoted: promoted,
      });
    } catch (err) {
      setHwSave({ state: 'err', error: String(err) });
      logger.error('fiscal-setup', 'save hardware failed', { err: String(err) });
    }
  }

  // ---------------- step 2 actions ----------------
  async function handleClaim() {
    setClaimBusy(true);
    setClaimErr(null);
    try {
      const r = await invoke<ClaimResponse>('fiscal_bridge_claim', {
        serverBaseUrl: server,
        code: code.trim().toUpperCase(),
        printerModel: hw.provider ?? 'simulator',
        deviceId: deviceId || null,
      });
      setClaim(r);
      await invoke('fiscal_bridge_run', {
        websocketUrl: r.websocket_url,
        deviceToken: r.device_token,
        printerModel: hw.provider ?? 'simulator',
      });
      try {
        const next = await pullFiscalConfig(server, r.device_token);
        setPullCfg(next);
      } catch (e) {
        logger.warn('fiscal-setup', 'pullFiscalConfig failed', { err: String(e) });
      }
      await refreshPairing();
      await refreshBridgeState();
      logger.info('fiscal-setup', 'claim + WSS started', { bridge_id: r.bridge_id });
    } catch (e) {
      setClaimErr(String(e));
      logger.error('fiscal-setup', 'claim failed', { err: String(e) });
    } finally {
      setClaimBusy(false);
    }
  }

  // ---------------- step 3 actions ----------------
  async function runTestConnection() {
    setConn({ state: 'busy' });
    try {
      const r = await invoke<{ ok: boolean; detail: string }>('fiscal_test_connection');
      setConn({ state: 'ok', value: r });
      logger.info('fiscal-setup', 'test_connection result', r);
    } catch (err) {
      setConn({ state: 'err', error: String(err) });
      logger.error('fiscal-setup', 'test_connection failed', { err: String(err) });
    }
  }

  async function runGetStatus() {
    setStatus({ state: 'busy' });
    try {
      const s = await getFiscal().status();
      setStatus({ state: 'ok', value: s });
    } catch (err) {
      setStatus({ state: 'err', error: String(err) });
    }
  }

  async function runPrintTest() {
    setReceipt({ state: 'busy' });
    try {
      const r = await getFiscal().printReceipt({
        mutationId: crypto.randomUUID(),
        orderId: `diag-${Date.now()}`,
        fiscalAttemptId: crypto.randomUUID(),
        operator: { code: hw.operator ?? '1', password: hw.operator_password ?? '0000' },
        lines: [
          { name: 'Test produs', quantity: 1, unitPriceCents: 100, vatGroup: 'A' },
        ],
        payments: [{ method: 'cash', amountCents: 100 }],
      });
      setReceipt({ state: 'ok', value: r });
    } catch (err) {
      setReceipt({ state: 'err', error: String(err) });
    }
  }

  // ---------------- advanced ----------------
  async function handlePullCfg() {
    if (!claim) {
      setPullErr('Pasul 2 (claim) trebuie făcut întâi.');
      return;
    }
    setPullBusy(true);
    setPullErr(null);
    try {
      const next = await pullFiscalConfig(server, claim.device_token);
      setPullCfg(next);
    } catch (e) {
      setPullErr(String(e));
    } finally {
      setPullBusy(false);
    }
  }

  async function handleSavePairing() {
    if (!deviceId) {
      setPairErr('Stația nu are device_id încă.');
      return;
    }
    setPairBusy(true);
    setPairErr(null);
    try {
      await upsertStationPairing({
        device_id: deviceId,
        fiscal_device_id: pairFiscal.trim() || null,
        payment_terminal_id: pairTerminal.trim() || null,
        fiscal_provider: pairing?.fiscal_provider ?? hw.provider ?? null,
        payment_provider: pairing?.payment_provider ?? null,
      });
      await refreshPairing();
    } catch (e) {
      setPairErr(String(e));
    } finally {
      setPairBusy(false);
    }
  }

  async function runRawDebug() {
    setRawDebug({ state: 'busy' });
    try {
      const r = await invoke<RawDebugResult[]>('fiscal_raw_debug');
      setRawDebug({ state: 'ok', value: r });
      logger.info('fiscal-setup', 'raw_debug done', { results: r });
    } catch (err) {
      setRawDebug({ state: 'err', error: String(err) });
      logger.error('fiscal-setup', 'raw_debug failed', { err: String(err) });
    }
  }

  async function runProbe() {
    setProbe({ state: 'busy' });
    try {
      const r = await invoke<ProbeReport>('fiscal_probe', {
        port: hw.serial_port ?? null,
        baud: hw.baud ?? null,
      });
      setProbe({ state: 'ok', value: r });
      logger.info('fiscal-setup', 'probe done', {
        all_nak_hint: r.all_nak_hint,
        recommended_dialect: r.recommended_dialect,
        recommended_baud: r.recommended_baud,
        attempts: r.attempts.length,
      });
    } catch (err) {
      setProbe({ state: 'err', error: String(err) });
    }
  }

  async function handleUnpair() {
    if (!deviceId) return;
    setPairBusy(true);
    setPairErr(null);
    try {
      await clearStationPairing(deviceId);
      await refreshPairing();
    } catch (e) {
      setPairErr(String(e));
    } finally {
      setPairBusy(false);
    }
  }

  // ---------------- step gating ----------------
  const requiresPort = hw.provider === 'datecs_dp25' || hw.provider === 'datecs_fp';
  const step1Done = useMemo(
    () => Boolean(hwSavedAt) && (!requiresPort || Boolean(hw.serial_port)),
    [hwSavedAt, requiresPort, hw.serial_port],
  );
  const step2Done = Boolean(bridgeState?.connected) || Boolean(claim);
  const step3Done = conn.state === 'ok' && conn.value.ok;

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold text-slate-100 inline-flex items-center gap-2">
          <Receipt className="h-5 w-5 text-violet-300" /> Casă de marcat — configurare
        </h2>
        <p className="text-sm text-slate-400 mt-1">
          Trei pași în ordine: hardware → backend → test. Fiecare pas trebuie verde înainte de următorul.
        </p>
      </header>

      {/* ============ PAS 1 — HARDWARE ============ */}
      <Step
        n={1}
        title="Configurare hardware"
        subtitle="Provider, COM port, baud, operator. Salvat local în SQLite."
        status={step1Done ? 'done' : hwSave.state === 'err' ? 'err' : 'todo'}
      >
        <div className="rounded-xl border border-white/10 bg-slate-900/40 p-4 space-y-3 text-sm">
          <Row label="Provider">
            <select
              value={hw.provider ?? 'simulator'}
              onChange={(e) => setHw({ ...hw, provider: e.target.value })}
              disabled={!hwLoaded}
              className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm w-full"
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </Row>

          <Row label="Port serial">
            <div className="flex gap-2 items-center w-full">
              <select
                value={hw.serial_port ?? ''}
                onChange={(e) =>
                  setHw({ ...hw, serial_port: e.target.value === '' ? null : e.target.value })
                }
                disabled={!hwLoaded}
                className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm flex-1"
              >
                <option value="">— alege —</option>
                {ports.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
                {hw.serial_port && !ports.includes(hw.serial_port) ? (
                  <option value={hw.serial_port}>{hw.serial_port} (salvat)</option>
                ) : null}
              </select>
              <button
                type="button"
                onClick={() => void refreshPorts()}
                disabled={portsBusy}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60"
              >
                {portsBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh
              </button>
              <input
                type="text"
                placeholder="manual: COM7"
                value={ports.includes(hw.serial_port ?? '') ? '' : (hw.serial_port ?? '')}
                onChange={(e) =>
                  setHw({ ...hw, serial_port: e.target.value.trim() === '' ? null : e.target.value.trim() })
                }
                className="bg-slate-800/80 border border-white/10 rounded-lg px-2.5 py-1.5 text-slate-100 text-xs w-32"
              />
            </div>
          </Row>

          <Row label="Baud rate">
            <select
              value={hw.baud ?? 9600}
              onChange={(e) => setHw({ ...hw, baud: parseInt(e.target.value, 10) })}
              disabled={!hwLoaded}
              className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm w-full"
            >
              {BAUDS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </Row>

          <Row label="Variantă protocol">
            <select
              value={hw.protocol_variant ?? 'fp55'}
              onChange={(e) => setHw({ ...hw, protocol_variant: e.target.value })}
              disabled={!hwLoaded}
              className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm w-full"
            >
              {VARIANTS.map((v) => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
          </Row>

          <Row label="Operator">
            <input
              type="text"
              value={hw.operator ?? ''}
              onChange={(e) => setHw({ ...hw, operator: e.target.value === '' ? null : e.target.value })}
              placeholder="1"
              className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm w-full"
            />
          </Row>

          <Row label="Parolă operator">
            <input
              type="password"
              value={hw.operator_password ?? ''}
              onChange={(e) =>
                setHw({ ...hw, operator_password: e.target.value === '' ? null : e.target.value })
              }
              placeholder="0000"
              className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm w-full"
            />
          </Row>

          <div className="border-t border-white/10 pt-3 space-y-2">
            <label className="flex items-center gap-3 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={hw.use_rust ?? false}
                onChange={(e) => setHw({ ...hw, use_rust: e.target.checked })}
                className="h-4 w-4"
              />
              <span>Activează adapterul Rust (obligatoriu pentru Datecs real)</span>
            </label>
            <label className="flex items-center gap-3 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={hw.enable_raw_logs ?? false}
                onChange={(e) => setHw({ ...hw, enable_raw_logs: e.target.checked })}
                className="h-4 w-4"
              />
              <span>Salvează raw request/response (debugging)</span>
            </label>
          </div>

          {requiresPort && !hw.serial_port && (
            <div className="text-xs text-amber-300 inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" /> Port serial obligatoriu pentru providerul Datecs.
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void saveHardware()}
            disabled={hwSave.state === 'busy' || !hwLoaded}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold bg-emerald-500/15 text-emerald-200 border border-emerald-400/30 hover:bg-emerald-500/25 disabled:opacity-50"
          >
            {hwSave.state === 'busy' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Salvează configurarea hardware
          </button>
          {hwSavedAt && hwSave.state !== 'err' && (
            <>
              <span className="text-xs text-emerald-300">Salvat {fmtTs(hwSavedAt)}</span>
              <button
                type="button"
                onClick={() => step2Ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25"
              >
                Treci la Pasul 2 →
              </button>
            </>
          )}
          {hwSave.state === 'err' && (
            <span className="text-xs text-rose-300 inline-flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" /> {hwSave.error}
            </span>
          )}
        </div>
      </Step>

      {/* ============ PAS 2 — BACKEND ============ */}
      <Step
        n={2}
        title="Conexiune cu backend"
        subtitle="Cod de înrolare 10 min generat din admin → Restaurant → Casă de marcat → Activează."
        status={step2Done ? 'done' : claimErr ? 'err' : 'todo'}
        hint={!step1Done ? 'Recomandat: salvează hardware-ul la Pasul 1 mai întâi.' : undefined}
        sectionRef={step2Ref}
      >
        <div className="rounded-xl border border-white/10 bg-slate-900/40 p-4 space-y-3 text-sm">
          <Row label="Cod înrolare">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="F3KP-7XMA"
              className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 font-mono uppercase text-sm w-full"
            />
          </Row>
          <Row label="Backend URL">
            <input
              type="text"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 font-mono text-xs w-full"
            />
          </Row>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => void handleClaim()}
              disabled={claimBusy || !code.trim()}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
            >
              {claimBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              Înrolează + start WSS
            </button>
            <button
              type="button"
              onClick={() => void refreshBridgeState()}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh status
            </button>
          </div>

          {claimErr && (
            <pre className="text-xs text-rose-300 font-mono whitespace-pre-wrap">{claimErr}</pre>
          )}

          {bridgeState && (
            <div className="border-t border-white/10 pt-3 space-y-1 text-xs">
              <KV
                k="Status WSS"
                v={
                  bridgeState.connected
                    ? 'CONECTAT'
                    : bridgeState.configured
                      ? 'configurat — în reconectare'
                      : 'neconfigurat'
                }
                vClass={bridgeState.connected ? 'text-emerald-300' : 'text-amber-300'}
              />
              <KV k="Bridge ID" v={bridgeState.bridge_id ?? '—'} mono />
              <KV k="Tenant ID" v={bridgeState.tenant_id ?? '—'} mono />
              <KV
                k="Ultim heartbeat"
                v={bridgeState.last_heartbeat_at ? new Date(bridgeState.last_heartbeat_at * 1000).toLocaleTimeString('ro-RO') : '—'}
              />
              {bridgeState.last_error && (
                <div className="text-rose-300 inline-flex items-center gap-1.5 pt-1">
                  <AlertTriangle className="h-3.5 w-3.5" /> {bridgeState.last_error}
                </div>
              )}
            </div>
          )}
        </div>
      </Step>

      {/* ============ PAS 3 — TEST ============ */}
      <Step
        n={3}
        title="Test conexiune cu casa de marcat"
        subtitle="Verificare comunicare + status fizic + bon test (1 RON, TVA 19%)."
        status={step3Done ? 'done' : conn.state === 'err' ? 'err' : 'todo'}
        hint={!step1Done ? 'Recomandat: salvează hardware-ul la Pasul 1.' : !step2Done ? 'Pentru fiscalizare reală via WSS: completează Pasul 2.' : undefined}
      >
        <div className="grid gap-3 md:grid-cols-3">
          <TestCard
            icon={<Wifi className="h-4 w-4 text-violet-300" />}
            title="Test conexiune"
            onRun={() => void runTestConnection()}
            state={conn}
            renderOk={(v) => (
              <div className={v.ok ? 'text-emerald-200' : 'text-rose-300'}>
                {v.ok ? '✓ Conectat' : '✗ Nu răspunde'}
                <div className="text-[11px] text-slate-400 mt-1">{v.detail}</div>
              </div>
            )}
          />
          <TestCard
            icon={<CheckCircle2 className="h-4 w-4 text-violet-300" />}
            title="Get status"
            onRun={() => void runGetStatus()}
            state={status}
            renderOk={(s) => (
              <pre className="text-[11px] text-emerald-200 font-mono whitespace-pre-wrap">
                {JSON.stringify(s, null, 2)}
              </pre>
            )}
          />
          <TestCard
            icon={<Send className="h-4 w-4 text-violet-300" />}
            title="Bon test (1 RON)"
            onRun={() => void runPrintTest()}
            state={receipt}
            renderOk={(r) => (
              <div className="text-[11px]">
                <div className={r.status === 'printed' ? 'text-emerald-300' : r.status === 'unknown' ? 'text-amber-300' : 'text-rose-300'}>
                  status: {r.status}
                </div>
                {r.fiscalNumber && <div className="text-slate-300">BF: {r.fiscalNumber}</div>}
                {r.errorMessage && <div className="text-rose-300">{r.errorMessage}</div>}
              </div>
            )}
          />
        </div>
      </Step>

      {/* ============ ADVANCED ============ */}
      <details className="rounded-xl border border-white/10 bg-slate-900/30" open={advancedOpen} onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer px-4 py-3 text-sm text-slate-300 inline-flex items-center gap-2 list-none">
          <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-0' : '-rotate-90'}`} />
          Setări avansate (pull config + pairing manual + Z-report)
        </summary>
        <div className="px-4 pb-4 space-y-4">
          <section className="rounded-lg border border-white/10 bg-slate-900/40 p-3 space-y-2 text-xs">
            <h4 className="text-slate-200 font-semibold inline-flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5" /> Pull config protocol (cmd_codes / encoding)
            </h4>
            <p className="text-slate-400">
              Backend-ul livrează codurile DDR per-tenant. Pull-ul se face automat după înrolare; aici doar reîmprospătare manuală.
            </p>
            {pullCfg ? (
              <div className="space-y-1 text-slate-300">
                <KV k="Bridge" v={pullCfg.bridge_id} mono />
                <KV k="Printer" v={pullCfg.printer_model ?? '—'} />
                <details>
                  <summary className="cursor-pointer text-slate-300 hover:text-slate-100">protocol JSON</summary>
                  <pre className="mt-2 rounded bg-slate-950/60 border border-white/10 p-2 text-[11px] font-mono text-slate-200 whitespace-pre-wrap">
{JSON.stringify(pullCfg.protocol, null, 2)}
                  </pre>
                </details>
              </div>
            ) : (
              <p className="text-slate-500">Niciun config în cache.</p>
            )}
            <button
              type="button"
              onClick={() => void handlePullCfg()}
              disabled={pullBusy || !claim}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60 disabled:opacity-50"
            >
              {pullBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Pull again
            </button>
            {pullErr && <pre className="text-xs text-rose-300 font-mono whitespace-pre-wrap">{pullErr}</pre>}
          </section>

          <section className="rounded-lg border border-white/10 bg-slate-900/40 p-3 space-y-2 text-xs">
            <h4 className="text-slate-200 font-semibold inline-flex items-center gap-2">
              <Link2 className="h-3.5 w-3.5" /> Pairing manual (1:1:1, audit Q2)
            </h4>
            <p className="text-slate-400">
              Auto-pair se face la înrolare. Folosește doar pentru swap controlat sau dacă admin-ul a stampilat manual un fiscal_device_id.
            </p>
            {!deviceId && <p className="text-amber-300">Stația nu are device_id; rulează login + bootstrap mai întâi.</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label>
                <span className="text-slate-400">Fiscal device ID</span>
                <input
                  type="text"
                  value={pairFiscal}
                  onChange={(e) => setPairFiscal(e.target.value)}
                  placeholder="bridge-uuid"
                  disabled={!deviceId || pairBusy}
                  className="mt-1 w-full rounded bg-slate-800 border border-white/10 px-2 py-1.5 text-slate-100 font-mono disabled:opacity-50"
                />
              </label>
              <label>
                <span className="text-slate-400">Payment terminal ID</span>
                <input
                  type="text"
                  value={pairTerminal}
                  onChange={(e) => setPairTerminal(e.target.value)}
                  placeholder="(BT-ECR Sprint 2)"
                  disabled={!deviceId || pairBusy}
                  className="mt-1 w-full rounded bg-slate-800 border border-white/10 px-2 py-1.5 text-slate-100 font-mono disabled:opacity-50"
                />
              </label>
            </div>
            {pairing && (
              <div className="text-slate-300">
                Pairing curent: fiscal={pairing.fiscal_device_id ?? '—'} terminal={pairing.payment_terminal_id ?? '—'}
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleSavePairing()}
                disabled={!deviceId || pairBusy}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
              >
                Salvează pairing
              </button>
              <button
                type="button"
                onClick={() => void handleUnpair()}
                disabled={!deviceId || pairBusy || !pairing}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60 disabled:opacity-50"
              >
                Unpair
              </button>
            </div>
            {pairErr && <pre className="text-xs text-rose-300 font-mono whitespace-pre-wrap">{pairErr}</pre>}
          </section>

          <section className="rounded-lg border border-white/10 bg-slate-900/40 p-3 space-y-2 text-xs">
            <h4 className="text-slate-200 font-semibold inline-flex items-center gap-2">
              <Wifi className="h-3.5 w-3.5" /> Probe casă (sweep dialect × baud)
            </h4>
            <p className="text-slate-400">
              Încearcă FP-55 + FP-700 pe baud-urile uzuale (9600, 19200, 38400, 57600, 115200) și raportează ce a răspuns.
              Dacă <strong>toate</strong> dau NAK = casa nu e validată ANAF (deși acum a fost verificată — atunci probabil
              parolă operator greșită sau dialect greșit pentru firmware-ul ăsta).
            </p>
            <button
              type="button"
              onClick={() => void runProbe()}
              disabled={probe.state === 'busy' || !hw.serial_port}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
            >
              {probe.state === 'busy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
              Rulează probe ({hw.serial_port ?? 'fără port'})
            </button>
            {probe.state === 'ok' && (
              <div className="space-y-2">
                <div className="rounded bg-slate-950/60 border border-white/10 p-2">
                  <div className="text-slate-300 mb-1">
                    Port: <code>{probe.value.port}</code> · baud configurat: <code>{probe.value.configured_baud}</code>
                  </div>
                  {probe.value.recommended_dialect && probe.value.recommended_baud ? (
                    <div className="text-emerald-300 font-semibold">
                      ✓ Combinație care răspunde: dialect={probe.value.recommended_dialect}, baud={probe.value.recommended_baud}
                      <div className="text-[11px] text-emerald-200/80 font-normal mt-0.5">
                        Setează în Pasul 1 → variantă protocol „{probe.value.recommended_dialect === 'fp700' ? 'FP-700' : 'FP-55'}", baud {probe.value.recommended_baud}, salvează.
                      </div>
                    </div>
                  ) : probe.value.all_nak_hint ? (
                    <div className="text-rose-300 font-semibold">
                      ✗ Toate combo-urile au dat NAK.
                      <div className="text-[11px] text-rose-200/80 font-normal mt-0.5">
                        Cauze posibile (în ordinea probabilității): operator/parolă greșite (cere tehnicianului ANAF ce a setat după verificare); firmware folosește alt dialect proprietar; bon deschis pe casă (rezolvi din meniul casei). Vezi memoria <code>feedback_fiscal_printer_nak_all_combos</code>.
                      </div>
                    </div>
                  ) : (
                    <div className="text-amber-300">Niciun răspuns OK; vezi detaliile.</div>
                  )}
                </div>
                <details>
                  <summary className="cursor-pointer text-slate-300 hover:text-slate-100">Detalii per combo ({probe.value.attempts.length})</summary>
                  <table className="mt-2 w-full text-[11px]">
                    <thead className="text-slate-400 border-b border-white/10">
                      <tr><th className="text-left py-1 pr-2">dialect</th><th className="text-left py-1 pr-2">baud</th><th className="text-left py-1 pr-2">rezultat</th><th className="text-left py-1">eroare</th></tr>
                    </thead>
                    <tbody>
                      {probe.value.attempts.map((a, i) => (
                        <tr key={i} className={a.ok ? 'text-emerald-300' : 'text-slate-400'}>
                          <td className="py-0.5 pr-2 font-mono">{a.dialect}</td>
                          <td className="py-0.5 pr-2 font-mono">{a.baud}</td>
                          <td className="py-0.5 pr-2">{a.ok ? '✓ OK' : '✗ fail'}</td>
                          <td className="py-0.5 text-rose-300">{a.error ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </div>
            )}
            {probe.state === 'err' && (
              <pre className="text-xs text-rose-300 font-mono whitespace-pre-wrap">{probe.error}</pre>
            )}
          </section>

          <section className="rounded-lg border border-rose-400/30 bg-rose-950/20 p-3 space-y-2 text-xs">
            <h4 className="text-slate-200 font-semibold inline-flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-rose-300" /> Raw bytes dump (cel mai jos nivel)
            </h4>
            <p className="text-slate-400">
              Trimite frame STATUS (cmd 0x4A) ÎN AMBELE dialecte (FP-55 + FP-700) și loghează byte-cu-byte ce întoarce
              casa. Folosit când probe-ul zice „toate NAK" — vrem să vedem dacă răspunsul e CHIAR 0x15 (NAK), sau alt
              byte interpretat ca NAK (firmware nou, alt dialect proprietar). Trimite-mi output-ul aici.
            </p>
            <button
              type="button"
              onClick={() => void runRawDebug()}
              disabled={rawDebug.state === 'busy' || !hw.serial_port}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold bg-rose-500/15 text-rose-200 border border-rose-400/30 hover:bg-rose-500/25 disabled:opacity-50"
            >
              {rawDebug.state === 'busy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Rulează raw bytes dump
            </button>
            {rawDebug.state === 'ok' && (
              <div className="space-y-2">
                {rawDebug.value.map((r, i) => (
                  <div key={i} className="rounded bg-black/40 border border-white/10 p-2 font-mono text-[11px] space-y-0.5">
                    <div className="text-slate-300">
                      <span className="text-violet-300">{r.dialect}</span> @ baud {r.baud}
                    </div>
                    <div><span className="text-slate-500">trimis:</span> <span className="text-emerald-200">{r.frame_sent_hex}</span></div>
                    <div><span className="text-slate-500">primit ({r.byte_count}b):</span> <span className={r.byte_count > 0 ? 'text-amber-200' : 'text-rose-300'}>{r.bytes_received_hex || '(nimic)'}</span></div>
                    <div className="text-slate-400">{r.interpretation}</div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    const text = rawDebug.value.map((r) =>
                      `=== ${r.dialect} @ ${r.baud} ===\nsent:    ${r.frame_sent_hex}\nrecv:    ${r.bytes_received_hex} (${r.byte_count} bytes)\ninterpret: ${r.interpretation}`
                    ).join('\n\n');
                    void navigator.clipboard.writeText(text);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60"
                >
                  Copy raw dump
                </button>
              </div>
            )}
            {rawDebug.state === 'err' && (
              <pre className="text-xs text-rose-300 font-mono whitespace-pre-wrap">{rawDebug.error}</pre>
            )}
          </section>

          <p className="text-[11px] text-slate-500">
            Z-report: trimitere protejată cu nonce + PIN admin (audit Q7) — disponibilă din meniul administrativ, nu din wizard.
          </p>
        </div>
      </details>

      <p className="text-[11px] text-slate-500 leading-relaxed">
        Notă: parola operator e stocată în clar în SQLite local (Sprint 1). Mutare în OS keychain (Stronghold) e ticket Sprint 11+.
      </p>
    </div>
  );
}

// =================== sub-components ===================

function Step({
  n,
  title,
  subtitle,
  status,
  hint,
  sectionRef,
  children,
}: {
  n: number;
  title: string;
  subtitle: string;
  status: 'todo' | 'done' | 'err';
  hint?: string;
  sectionRef?: React.MutableRefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const badge = status === 'done'
    ? <span className="inline-flex items-center gap-1 text-emerald-300 text-xs"><CheckCircle2 className="h-3.5 w-3.5" /> gata</span>
    : status === 'err'
      ? <span className="inline-flex items-center gap-1 text-rose-300 text-xs"><AlertTriangle className="h-3.5 w-3.5" /> eroare</span>
      : <span className="inline-flex items-center gap-1 text-slate-400 text-xs"><SettingsIcon className="h-3.5 w-3.5" /> de făcut</span>;
  return (
    <section
      ref={(el) => {
        if (sectionRef) sectionRef.current = el;
      }}
      className={`rounded-2xl border ${status === 'done' ? 'border-emerald-400/30' : status === 'err' ? 'border-rose-400/30' : 'border-white/10'} bg-slate-900/20 p-5`}
    >
      <header className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-start gap-3">
          <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${status === 'done' ? 'bg-emerald-500/20 text-emerald-200' : status === 'err' ? 'bg-rose-500/20 text-rose-200' : 'bg-slate-700/40 text-slate-200'}`}>
            {n}
          </div>
          <div>
            <h3 className="text-base font-semibold text-slate-100">{title}</h3>
            <p className="text-xs text-slate-400">{subtitle}</p>
          </div>
        </div>
        {badge}
      </header>
      {hint && (
        <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {hint}
        </div>
      )}
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
      <label className="text-xs uppercase tracking-wider text-slate-400 font-semibold">{label}</label>
      <div>{children}</div>
    </div>
  );
}

function KV({ k, v, mono, vClass }: { k: string; v: string; mono?: boolean; vClass?: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-slate-400 w-32">{k}</span>
      <span className={`${mono ? 'font-mono' : ''} ${vClass ?? 'text-slate-200'}`}>{v}</span>
    </div>
  );
}

function TestCard<T>({
  icon,
  title,
  onRun,
  state,
  renderOk,
}: {
  icon: React.ReactNode;
  title: string;
  onRun: () => void;
  state: AsyncState<T>;
  renderOk: (v: T) => React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-100 inline-flex items-center gap-2">
          {icon} {title}
        </span>
        <button
          type="button"
          onClick={onRun}
          disabled={state.state === 'busy'}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
        >
          {state.state === 'busy' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Run'}
        </button>
      </div>
      <div className="min-h-[40px]">
        {state.state === 'ok' && renderOk(state.value)}
        {state.state === 'err' && (
          <pre className="text-[11px] text-rose-300 font-mono whitespace-pre-wrap">{state.error}</pre>
        )}
        {state.state === 'idle' && <span className="text-[11px] text-slate-500">—</span>}
      </div>
    </div>
  );
}

function stripNulls(c: FiscalRuntimeConfig): Partial<FiscalRuntimeConfig> {
  const out: Partial<FiscalRuntimeConfig> = {};
  (Object.keys(c) as (keyof FiscalRuntimeConfig)[]).forEach((k) => {
    const v = c[k];
    if (v !== null && v !== undefined) {
      // @ts-expect-error narrow through Partial
      out[k] = v;
    }
  });
  return out;
}

function fmtTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('ro-RO');
}
