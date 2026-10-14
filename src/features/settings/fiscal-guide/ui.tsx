/**
 * Small presentational pieces shared by the guide (dark POS style).
 */
import type { ReactNode } from 'react';
import { AlertTriangle, Check, CheckCircle2, Loader2 } from 'lucide-react';

import type { Explained, StepState, Tone } from './logic';

export const btnPrimary =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50';
export const btnSecondary =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-100 hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50';
export const btnGhost =
  'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-sky-300 hover:bg-slate-800 disabled:opacity-50';
export const inputCls =
  'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500';

export function Dot({ tone }: { tone: Tone }) {
  const c =
    tone === 'ok' ? 'bg-emerald-400' : tone === 'bad' ? 'bg-rose-500' : tone === 'wait' ? 'bg-amber-400' : 'bg-slate-500';
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${c}`} />;
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin`} />;
}

export function StepBadge({ n, state, active }: { n: number; state: StepState; active: boolean }) {
  const cls =
    state === 'done'
      ? 'bg-emerald-500 text-slate-950'
      : state === 'error'
        ? 'bg-rose-500 text-white'
        : state === 'warn'
          ? 'bg-amber-400 text-slate-950'
          : active
            ? 'bg-sky-600 text-white'
            : 'bg-slate-700 text-slate-300';
  return (
    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${cls}`}>
      {state === 'done' ? <Check className="h-4 w-4" strokeWidth={3} /> : n}
    </span>
  );
}

export function OkBox({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-900/30 px-3 py-2.5 text-sm text-emerald-100">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function ProblemBox({ e, raw }: { e: Explained; raw?: string | null }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-rose-500/30 bg-rose-950/40 px-3 py-2.5 text-sm text-rose-100">
      <div className="flex items-start gap-2 font-semibold">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
        <span>{e.title}</span>
      </div>
      {e.checks.length > 0 && (
        <ul className="ml-6 list-disc space-y-0.5 text-rose-100/90">
          {e.checks.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      {raw ? <div className="ml-6 break-all font-mono text-[11px] text-rose-200/60">{raw}</div> : null}
    </div>
  );
}
