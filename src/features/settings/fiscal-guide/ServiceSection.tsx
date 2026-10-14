/**
 * „Avansat (service)” — collapsed by default. Holds every technical tool
 * the fiscal window had before the guide, unchanged in behaviour:
 *   - agent mode + agent state (integrat (Rust) / fiscal-bridge separat);
 *   - the full service form (FiscalSetupWizard): raw config fields incl.
 *     protocol variant, enrolment with a custom server, test connection /
 *     status / test bill, pull config, manual pairing, probe sweep, raw
 *     bytes dump, password debug.
 * The service form is mounted only while the section is open, so its own
 * polling does not run in the normal view.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, Wrench } from 'lucide-react';

import { FiscalSetupWizard } from '@/features/settings/FiscalSetupWizard';
import { errText, shellApi, type AgentSummary, type FiscalHealth, type ShellConfig } from '@/shell/api';

import { inputCls } from './ui';

function ago(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return `acum ${s}s`;
  if (s < 3600) return `acum ${Math.round(s / 60)} min`;
  return new Date(ts * 1000).toLocaleString('ro-RO');
}

export function ServiceSection({
  health,
  onChanged,
}: {
  health: { printer: FiscalHealth; agent: AgentSummary } | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="scroll-mt-36 rounded-xl border border-slate-800 bg-slate-900/30">
      <button className="flex w-full items-center gap-2 px-4 py-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`} />
        <Wrench className="h-4 w-4 text-slate-400" />
        <span className="text-sm font-semibold text-slate-300">Avansat (service)</span>
        <span className="ml-2 truncate text-xs text-amber-300/80">
          Doar pentru tehnicianul casei. Schimbările de aici pot opri tipărirea bonurilor.
        </span>
      </button>
      {open && (
        <div className="space-y-5 border-t border-slate-800 p-4">
          <AgentPanel health={health} onChanged={onChanged} />
          <FiscalSetupWizard onChanged={onChanged} />
        </div>
      )}
    </section>
  );
}

function AgentPanel({
  health,
  onChanged,
}: {
  health: { printer: FiscalHealth; agent: AgentSummary } | null;
  onChanged: () => void;
}) {
  const [cfg, setCfg] = useState<ShellConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    shellApi
      .getConfig()
      .then((s) => setCfg(s.config))
      .catch((e) => setMsg({ ok: false, text: errText(e) }));
  }, []);

  const a = health?.agent;
  const p = health?.printer;
  const agentLabel =
    a?.resolved === 'rust' ? 'integrat (Rust)' : a?.resolved === 'sidecar' ? 'fiscal-bridge separat' : 'oprit';

  const save = async (fiscalAgent: ShellConfig['fiscalAgent']) => {
    if (!cfg) return;
    setBusy(true);
    setMsg(null);
    try {
      const s = await shellApi.setConfig({ ...cfg, fiscalAgent });
      setCfg(s.config);
      setMsg({ ok: true, text: 'Salvat. Unele schimbări se aplică după repornirea aplicației.' });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-sm md:grid-cols-2">
      <div className="space-y-1">
        <div className="font-semibold text-slate-200">Agent fiscal: {agentLabel}</div>
        {a?.resolved === 'rust' ? (
          <div className="text-slate-400">
            {a.connected ? 'conectat la server' : a.running ? 'se conectează…' : 'oprit'}
            {a.bridgeId ? <span className="font-mono text-xs text-slate-500"> · {a.bridgeId}</span> : null}
          </div>
        ) : a?.resolved === 'sidecar' ? (
          <div className="text-slate-400">{a.sidecarRunning ? 'pornit' : 'nu rulează'}</div>
        ) : null}
        {a?.lastError && !a.connected ? <div className="text-xs text-amber-300">{a.lastError}</div> : null}
        <div className="text-xs text-slate-500">
          Casa: {p?.provider ?? '—'}
          {p?.port ? ` · ${p.port}` : ''} · monitorizată: {p?.monitored ? 'da' : 'nu'} · ultimul răspuns {ago(p?.lastOkAt ?? null)} ·
          verificat {ago(p?.lastCheckAt ?? null)}
        </div>
        {p?.lastError && !p.online ? <div className="text-xs text-amber-300">{p.lastError}</div> : null}
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-semibold text-slate-300">Mod agent fiscal</span>
        <select
          className={inputCls}
          value={cfg?.fiscalAgent ?? 'auto'}
          disabled={!cfg || busy}
          onChange={(e) => void save(e.target.value as ShellConfig['fiscalAgent'])}
        >
          <option value="auto">Automat (recomandat)</option>
          <option value="rust">Integrat în aplicație</option>
          <option value="sidecar">fiscal-bridge separat</option>
          <option value="off">Oprit</option>
        </select>
        <span className="block text-[11px] text-slate-500">Aceeași setare ca în tabul Stația → Agent fiscal.</span>
        {msg && <span className={`block text-xs ${msg.ok ? 'text-emerald-300' : 'text-rose-300'}`}>{msg.text}</span>}
      </label>
    </div>
  );
}
