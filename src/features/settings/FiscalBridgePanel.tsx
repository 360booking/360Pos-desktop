/**
 * Bridge enrollment + WSS state — Sprint 1.b.
 *
 * Mirrors what Python fiscal-bridge does at install time:
 *   1. user pastes ABCD-1234 enrollment code from the admin panel
 *   2. POST /api/fiscal-bridge/claim → device_token + websocket_url
 *   3. start the WSS loop (hello / heartbeat / job_result)
 *
 * The Python agent runs as a separate Windows Service today; here it lives
 * inside the Tauri binary, gated on FISCAL_USE_RUST.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle2, AlertTriangle, Loader2, Plug, RefreshCw, Download, Link2, Unlink } from 'lucide-react';
import { getConfig } from '@/lib/config';
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

interface ClaimResponse {
  device_token: string;
  bridge_id: string;
  tenant_id: string;
  websocket_url: string;
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

const DEFAULT_SERVER = 'https://360booking.ro';

export function FiscalBridgePanel() {
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [code, setCode] = useState('');
  const [model, setModel] = useState('simulator');
  const [state, setState] = useState<BridgeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimResponse | null>(null);
  const [cfg, setCfg] = useState<FiscalConfigBundle | null>(null);
  const [cfgBusy, setCfgBusy] = useState(false);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [pairing, setPairing] = useState<StationPairing | null>(null);
  const [pairFiscal, setPairFiscal] = useState('');
  const [pairTerminal, setPairTerminal] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [pairErr, setPairErr] = useState<string | null>(null);
  const deviceId = getConfig().deviceId ?? '';

  async function refresh() {
    try {
      const s = await invoke<BridgeState>('fiscal_bridge_state');
      setState(s);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void getCachedFiscalConfig()
      .then((c) => setCfg(c))
      .catch((e) => setCfgErr(String(e)));
  }, []);

  useEffect(() => {
    if (!deviceId) return;
    void refreshPairing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

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

  async function handleSavePairing() {
    if (!deviceId) {
      setPairErr('Stația nu are device_id încă — pairing imposibil.');
      return;
    }
    setPairBusy(true);
    setPairErr(null);
    try {
      await upsertStationPairing({
        device_id: deviceId,
        fiscal_device_id: pairFiscal.trim() || null,
        payment_terminal_id: pairTerminal.trim() || null,
        fiscal_provider: pairing?.fiscal_provider ?? model,
        payment_provider: pairing?.payment_provider ?? null,
      });
      await refreshPairing();
    } catch (e) {
      setPairErr(String(e));
    } finally {
      setPairBusy(false);
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

  async function handlePullConfig(deviceToken?: string) {
    setCfgBusy(true);
    setCfgErr(null);
    try {
      const token = deviceToken ?? claim?.device_token;
      if (!token) {
        setCfgErr('Trebuie un device_token (rulează claim întâi).');
        return;
      }
      const next = await pullFiscalConfig(server, token);
      setCfg(next);
    } catch (e) {
      setCfgErr(String(e));
    } finally {
      setCfgBusy(false);
    }
  }

  async function handleClaim() {
    setBusy(true);
    setErr(null);
    try {
      const r = await invoke<ClaimResponse>('fiscal_bridge_claim', {
        serverBaseUrl: server,
        code: code.trim().toUpperCase(),
        printerModel: model,
        deviceId: deviceId || null,
      });
      setClaim(r);
      await invoke('fiscal_bridge_run', {
        websocketUrl: r.websocket_url,
        deviceToken: r.device_token,
        printerModel: model,
      });
      // C12 — pull resolved protocol config alongside the WSS bring-up so the
      // station has cmd_codes cached locally before the first job arrives.
      await handlePullConfig(r.device_token);
      // B11 — claim already auto-pairs in Rust; refresh the UI so the new
      // fiscal_device_id shows up immediately.
      await refreshPairing();
      refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-100 mb-1 inline-flex items-center gap-2">
        <Plug className="h-5 w-5 text-violet-300" /> Bridge backend (port Python ws_client)
      </h2>
      <p className="text-sm text-slate-400 mb-6">
        Path-ul prin care backend-ul livrează job-uri fiscale spre stația desktop. Înlocuiește serviciul Windows Python cu un loop intern pos-desktop.
      </p>

      {state && (
        <div className="rounded-xl border border-white/10 bg-slate-900/40 p-4 mb-4 text-sm space-y-2">
          <div className="flex items-baseline gap-3">
            <span className="text-slate-400 w-44">Status</span>
            <span className={state.connected ? 'text-emerald-300' : 'text-amber-300'}>
              {state.connected ? 'CONECTAT' : state.configured ? 'configurat — în reconectare' : 'neconfigurat'}
            </span>
          </div>
          <Field label="Bridge ID" value={state.bridge_id ?? '—'} mono />
          <Field label="Tenant ID" value={state.tenant_id ?? '—'} mono />
          <Field label="Printer model" value={state.printer_model ?? '—'} />
          <Field
            label="Ultimul heartbeat"
            value={state.last_heartbeat_at ? new Date(state.last_heartbeat_at * 1000).toLocaleTimeString('ro-RO') : '—'}
          />
          <Field label="Close code" value={state.close_code ? String(state.close_code) : '—'} />
          {state.last_error && (
            <div className="text-xs text-rose-300 inline-flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5" /> {state.last_error}
            </div>
          )}
          <div className="pt-1">
            <button
              type="button"
              onClick={refresh}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>
        </div>
      )}

      <section className="rounded-xl border border-white/10 bg-slate-900/40 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-slate-100">Enrollment (cod cu durata 10 min)</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="text-xs text-slate-400 sm:col-span-1">
            Backend
            <input
              type="text"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              className="mt-1 w-full rounded bg-slate-800 border border-white/10 px-2 py-1.5 text-sm text-slate-100 font-mono"
            />
          </label>
          <label className="text-xs text-slate-400 sm:col-span-1">
            Cod (ABCD-1234)
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="F3KP-7XMA"
              className="mt-1 w-full rounded bg-slate-800 border border-white/10 px-2 py-1.5 text-sm text-slate-100 font-mono uppercase"
            />
          </label>
          <label className="text-xs text-slate-400 sm:col-span-1">
            Printer model
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="mt-1 w-full rounded bg-slate-800 border border-white/10 px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="simulator">simulator</option>
              <option value="datecs_dp25">datecs_dp25</option>
            </select>
          </label>
        </div>
        <div className="pt-1">
          <button
            type="button"
            onClick={handleClaim}
            disabled={busy || !code.trim()}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
            Claim + start WSS
          </button>
        </div>
        {claim && (
          <div className="text-xs text-emerald-300 inline-flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" /> Token primit, loop pornit (bridge {claim.bridge_id.slice(0, 8)}…).
          </div>
        )}
        {err && (
          <pre className="text-xs text-rose-300 font-mono whitespace-pre-wrap">{err}</pre>
        )}
      </section>

      <section className="rounded-xl border border-white/10 bg-slate-900/40 p-4 mt-4 space-y-3">
        <h3 className="text-sm font-semibold text-slate-100 inline-flex items-center gap-2">
          <Download className="h-4 w-4 text-violet-300" /> Config protocol (C12 — pull la startup)
        </h3>
        <p className="text-xs text-slate-400">
          Cmd_codes + encoding + BCC algo, rezolvate de backend din default + override per-tenant. Cache local: <code>fiscal-config.json</code> în app_data_dir. Fără hot-reload via WSS — pull doar la claim + manual.
        </p>
        {cfg ? (
          <div className="space-y-2 text-xs">
            <Field label="Bridge ID" value={cfg.bridge_id} mono />
            <Field label="Tenant ID" value={cfg.tenant_id} mono />
            <Field label="Printer model" value={cfg.printer_model ?? '—'} />
            <details className="pt-1">
              <summary className="cursor-pointer text-slate-300 hover:text-slate-100">protocol JSON</summary>
              <pre className="mt-2 rounded bg-slate-950/60 border border-white/10 p-2 text-[11px] font-mono text-slate-200 whitespace-pre-wrap">
{JSON.stringify(cfg.protocol, null, 2)}
              </pre>
            </details>
          </div>
        ) : (
          <p className="text-xs text-slate-500">Niciun config în cache — rulează claim sau apasă „Pull again".</p>
        )}
        <div>
          <button
            type="button"
            onClick={() => handlePullConfig()}
            disabled={cfgBusy || !claim}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60 disabled:opacity-50"
          >
            {cfgBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Pull again
          </button>
        </div>
        {cfgErr && (
          <pre className="text-xs text-rose-300 font-mono whitespace-pre-wrap">{cfgErr}</pre>
        )}
      </section>

      <section className="rounded-xl border border-white/10 bg-slate-900/40 p-4 mt-4 space-y-3">
        <h3 className="text-sm font-semibold text-slate-100 inline-flex items-center gap-2">
          <Link2 className="h-4 w-4 text-violet-300" /> Pairing stație (B11 — 1:1:1)
        </h3>
        <p className="text-xs text-slate-400">
          Audit Q2 — o stație = un singur fiscal device + un singur payment terminal. Auto-pair se face la „Claim + start WSS". Modifică manual doar dacă stația are deja un fiscal_device_id valid stampilat de admin sau dacă faci un swap controlat.
        </p>
        {!deviceId && (
          <p className="text-xs text-amber-300">Stația nu are încă device_id în config; salvează configul tenant sau rulează onboarding-ul mai întâi.</p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-xs text-slate-400">
            Fiscal device ID (bridge_id)
            <input
              type="text"
              value={pairFiscal}
              onChange={(e) => setPairFiscal(e.target.value)}
              placeholder="bridge-uuid"
              disabled={!deviceId || pairBusy}
              className="mt-1 w-full rounded bg-slate-800 border border-white/10 px-2 py-1.5 text-sm text-slate-100 font-mono disabled:opacity-50"
            />
          </label>
          <label className="text-xs text-slate-400">
            Payment terminal ID
            <input
              type="text"
              value={pairTerminal}
              onChange={(e) => setPairTerminal(e.target.value)}
              placeholder="(BT-ECR Sprint 2)"
              disabled={!deviceId || pairBusy}
              className="mt-1 w-full rounded bg-slate-800 border border-white/10 px-2 py-1.5 text-sm text-slate-100 font-mono disabled:opacity-50"
            />
          </label>
        </div>
        {pairing && (
          <div className="text-xs text-slate-300 space-y-1">
            <Field label="Device ID" value={pairing.device_id} mono />
            <Field label="Fiscal provider" value={pairing.fiscal_provider ?? '—'} />
            <Field label="Payment provider" value={pairing.payment_provider ?? '—'} />
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSavePairing}
            disabled={!deviceId || pairBusy}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
          >
            {pairBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
            Salvează pairing
          </button>
          <button
            type="button"
            onClick={handleUnpair}
            disabled={!deviceId || pairBusy || !pairing}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold bg-rose-500/10 text-rose-200 border border-rose-400/30 hover:bg-rose-500/20 disabled:opacity-50"
          >
            <Unlink className="h-3.5 w-3.5" /> Unpair
          </button>
        </div>
        {pairErr && (
          <pre className="text-xs text-rose-300 font-mono whitespace-pre-wrap">{pairErr}</pre>
        )}
      </section>
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="text-slate-400 w-44 shrink-0">{label}</span>
      <span className={`text-slate-100 ${mono ? 'font-mono text-xs' : ''}`}>{value ?? '—'}</span>
    </div>
  );
}
