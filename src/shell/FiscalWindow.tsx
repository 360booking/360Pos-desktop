/**
 * Etapa 5 — the separate fiscal settings window (Ctrl+Shift+F from the POS).
 *
 * Tabs:
 *   Casă de marcat — live state of the printer + agent, reconnect, X report,
 *                    and the existing enrolment / hardware wizard;
 *   Stație         — tenant address, kiosk, start with Windows, agent.
 */
import { useCallback, useEffect, useState } from 'react';

import { FiscalSetupWizard } from '@/features/settings/FiscalSetupWizard';

import { errText, shellApi, type AgentSummary, type FiscalHealth } from './api';
import { StationSettings } from './StationSettings';

type Tab = 'fiscal' | 'station';

function ago(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return `acum ${s}s`;
  if (s < 3600) return `acum ${Math.round(s / 60)} min`;
  return new Date(ts * 1000).toLocaleString('ro-RO');
}

function Dot({ ok }: { ok: boolean | null | undefined }) {
  const c = ok === true ? 'bg-emerald-400' : ok === false ? 'bg-rose-500' : 'bg-slate-500';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${c}`} />;
}

function StatusCard() {
  const [h, setH] = useState<{ printer: FiscalHealth; agent: AgentSummary } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(() => {
    shellApi.fiscalHealth().then(setH).catch((e) => setMsg({ ok: false, text: errText(e) }));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const p = h?.printer;
  const a = h?.agent;
  const agentLabel =
    a?.resolved === 'rust' ? 'integrat (Rust)' : a?.resolved === 'sidecar' ? 'fiscal-bridge separat' : 'oprit';

  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 text-sm">
          <div className="font-semibold text-slate-200">Agent fiscal: {agentLabel}</div>
          {a?.resolved === 'rust' ? (
            <div className="flex items-center gap-2 text-slate-300">
              <Dot ok={a.connected} /> {a.connected ? 'conectat la server' : a.running ? 'se conectează…' : 'oprit'}
              {a.bridgeId ? <span className="text-xs text-slate-500">· {a.bridgeId.slice(0, 8)}</span> : null}
            </div>
          ) : a?.resolved === 'sidecar' ? (
            <div className="flex items-center gap-2 text-slate-300">
              <Dot ok={a.sidecarRunning} /> {a.sidecarRunning ? 'pornit' : 'nu rulează'}
            </div>
          ) : null}
          {a?.lastError && !a.connected ? <div className="text-xs text-amber-300">{a.lastError}</div> : null}
          {a && !a.hasSavedCredentials && a.resolved !== 'sidecar' ? (
            <div className="text-xs text-amber-300">Stația nu e înrolată încă — folosește „Bridge backend” mai jos.</div>
          ) : null}
        </div>
        <div className="space-y-1 text-sm">
          <div className="font-semibold text-slate-200">
            Casa de marcat {p?.provider && p.provider !== 'sidecar/off' ? `(${p.provider}${p.port ? ` · ${p.port}` : ''})` : ''}
          </div>
          {p?.monitored ? (
            <>
              <div className="flex items-center gap-2 text-slate-300">
                <Dot ok={p.online} /> {p.online ? 'răspunde' : 'nu răspunde'}
                {p.paperOk === false ? <span className="text-amber-300">· hârtie?</span> : null}
              </div>
              <div className="text-xs text-slate-500">
                Ultimul răspuns: {ago(p.lastOkAt)} · verificat {ago(p.lastCheckAt)}
              </div>
              {p.lastError && !p.online ? <div className="text-xs text-amber-300">{p.lastError}</div> : null}
            </>
          ) : (
            <div className="text-xs text-slate-400">
              {p?.provider === 'simulator'
                ? 'Simulator — nu se tipărește nimic real.'
                : 'Monitorizat doar când agentul integrat deține casa.'}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-semibold text-slate-100 hover:bg-slate-600 disabled:opacity-50"
          disabled={!!busy}
          onClick={() =>
            run('reconnect', async () => {
              const r = await shellApi.fiscalReconnect();
              setH(r);
              return r.printer.online === false ? 'Casa tot nu răspunde — verifică cablul și portul.' : 'Reconectat.';
            })
          }
        >
          {busy === 'reconnect' ? 'Se reconectează…' : 'Reconectează acum'}
        </button>
        <button
          className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-semibold text-slate-100 hover:bg-slate-600 disabled:opacity-50"
          disabled={!!busy}
          onClick={() =>
            run('x', async () => {
              const r = await shellApi.printXReport();
              if (r.status !== 'printed') throw new Error(r.error_message || `Raport X: ${r.status}`);
              return 'Raport X tipărit.';
            })
          }
        >
          {busy === 'x' ? 'Se tipărește…' : 'Raport X (local)'}
        </button>
      </div>
      {msg && (
        <div className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-900/40 text-emerald-200' : 'bg-rose-900/40 text-rose-200'}`}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

export function FiscalWindow() {
  const [tab, setTab] = useState<Tab>('fiscal');
  const tabBtn = (t: Tab, label: string) => (
    <button
      className={`rounded-lg px-4 py-2 text-sm font-semibold ${tab === t ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
      onClick={() => setTab(t)}
    >
      {label}
    </button>
  );
  return (
    <div className="h-full overflow-auto bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold">Casă de marcat și stație</h1>
          <div className="flex gap-2">
            {tabBtn('fiscal', 'Casă de marcat')}
            {tabBtn('station', 'Stație')}
          </div>
        </div>
        {tab === 'fiscal' ? (
          <div className="space-y-5">
            <StatusCard />
            <FiscalSetupWizard />
          </div>
        ) : (
          <StationSettings compact />
        )}
      </div>
    </div>
  );
}
