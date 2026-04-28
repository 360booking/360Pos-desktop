/**
 * Tiny toast system — POS desktop.
 *
 * Used to surface REST errors that previously got swallowed silently.
 * Subscribe-only API: anything in the app can call `pushToast({...})`
 * and the singleton container at the top of the React tree renders it.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export interface ToastInput {
  level?: ToastLevel;
  title?: string;
  message: string;
  /** Auto-dismiss after this many ms. Default 4000. Pass `null` to keep
   *  the toast until the operator clicks the close button. */
  ttlMs?: number | null;
}

interface ToastEntry extends ToastInput {
  id: string;
  level: ToastLevel;
}

const _entries: ToastEntry[] = [];
const _listeners = new Set<() => void>();

function notify() {
  for (const fn of _listeners) {
    try { fn(); } catch { /* swallow */ }
  }
}

export function pushToast(input: ToastInput): string {
  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const entry: ToastEntry = { id, level: input.level ?? 'info', ...input };
  _entries.push(entry);
  notify();
  const ttl = input.ttlMs === undefined ? 4000 : input.ttlMs;
  if (ttl !== null) {
    setTimeout(() => dismissToast(id), ttl);
  }
  return id;
}

export function dismissToast(id: string): void {
  const idx = _entries.findIndex((e) => e.id === id);
  if (idx >= 0) {
    _entries.splice(idx, 1);
    notify();
  }
}

export function subscribeToasts(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

export function ToastContainer() {
  const [, force] = useState(0);
  useEffect(() => subscribeToasts(() => force((n) => n + 1)), []);

  if (_entries.length === 0) return null;
  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {_entries.map((t) => (
        <ToastItem key={t.id} entry={t} />
      ))}
    </div>
  );
}

function ToastItem({ entry }: { entry: ToastEntry }) {
  const { Icon, accent } = stylesFor(entry.level);
  return (
    <div className={`rounded-lg border ${accent.border} ${accent.bg} px-3 py-2 shadow-lg shadow-black/40 text-xs text-slate-100 flex items-start gap-2`}>
      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${accent.icon}`} />
      <div className="flex-1 min-w-0">
        {entry.title && <div className={`text-sm font-semibold ${accent.title}`}>{entry.title}</div>}
        <div className="text-slate-200 break-words">{entry.message}</div>
      </div>
      <button
        type="button"
        onClick={() => dismissToast(entry.id)}
        className="text-slate-400 hover:text-slate-200"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function stylesFor(level: ToastLevel) {
  switch (level) {
    case 'success':
      return {
        Icon: CheckCircle2,
        accent: {
          border: 'border-emerald-400/30',
          bg: 'bg-emerald-950/80',
          icon: 'text-emerald-300',
          title: 'text-emerald-200',
        },
      };
    case 'warning':
      return {
        Icon: AlertTriangle,
        accent: {
          border: 'border-amber-400/30',
          bg: 'bg-amber-950/80',
          icon: 'text-amber-300',
          title: 'text-amber-200',
        },
      };
    case 'error':
      return {
        Icon: AlertTriangle,
        accent: {
          border: 'border-rose-400/40',
          bg: 'bg-rose-950/80',
          icon: 'text-rose-300',
          title: 'text-rose-200',
        },
      };
    default:
      return {
        Icon: Info,
        accent: {
          border: 'border-violet-400/30',
          bg: 'bg-slate-900/90',
          icon: 'text-violet-300',
          title: 'text-violet-200',
        },
      };
  }
}
