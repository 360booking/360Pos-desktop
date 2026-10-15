/**
 * „Avansat (service)” — collapsed by default. Holds every technical tool
 * the fiscal window had before the guide, unchanged in behaviour:
 *   - state of the integrated fiscal agent and of the printer watchdog;
 *   - the full service form (FiscalSetupWizard): raw config fields incl.
 *     protocol variant, enrolment with a custom server, test connection /
 *     status / test bill, pull config, manual pairing, probe sweep, raw
 *     bytes dump, password debug.
 * The service form is mounted only while the section is open, so its own
 * polling does not run in the normal view.
 */
import { useState } from 'react';
import { ChevronDown, Wrench } from 'lucide-react';

import { FiscalSetupWizard } from '@/features/settings/FiscalSetupWizard';
import type { AgentSummary, FiscalHealth } from '@/shell/api';

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
          <AgentPanel health={health} />
          <FiscalSetupWizard onChanged={onChanged} />
        </div>
      )}
    </section>
  );
}

function AgentPanel({ health }: { health: { printer: FiscalHealth; agent: AgentSummary } | null }) {
  const a = health?.agent;
  const p = health?.printer;

  return (
    <div className="space-y-1 rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-sm">
      <div className="font-semibold text-slate-200">Agent fiscal: integrat în aplicație</div>
      <div className="text-slate-400">
        {!a?.hasSavedCredentials
          ? 'stația nu e legată încă (pasul 2)'
          : a.connected
            ? 'conectat la server'
            : a.running
              ? 'se conectează…'
              : 'oprit'}
        {a?.bridgeId ? <span className="font-mono text-xs text-slate-500"> · {a.bridgeId}</span> : null}
      </div>
      {a?.lastError && !a.connected ? <div className="text-xs text-amber-300">{a.lastError}</div> : null}
      <div className="text-xs text-slate-500">
        Casa: {p?.provider ?? '—'}
        {p?.port ? ` · ${p.port}` : ''} · monitorizată: {p?.monitored ? 'da' : 'nu'} · ultimul răspuns {ago(p?.lastOkAt ?? null)} ·
        verificat {ago(p?.lastCheckAt ?? null)}
      </div>
      {/* Not answering: why. Answering: what the register reports (paper, cover, open bon). */}
      {p?.lastError ? <div className="text-xs text-amber-300">{p.lastError}</div> : null}
    </div>
  );
}
