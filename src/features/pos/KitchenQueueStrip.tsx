/**
 * Read-only kitchen queue strip — Sprint 6 / 5.
 *
 * Sits between StatusBar and the three panes; shows pending ticket count
 * grouped by station + the oldest ticket age. Discreet by design: no
 * actions, no expand-on-hover. The point is to let a waiter feel kitchen
 * pressure at a glance ("4 pending la bucătărie, oldest 6m") without
 * having to switch over to the KDS app.
 *
 * Documented as a desktop-only delta in pos-ui-parity.md (the web POS
 * has KitchenQueueStrip in POSPage.tsx; we mirror it but show only the
 * subset our pull endpoint exposes today — no median ETA yet).
 */
import { useMemo } from 'react';
import { Flame, Coffee, Clock, ChefHat } from 'lucide-react';
import { useRemote } from '@/store/remote';

interface StationStat {
  station: string;
  pending: number;
  preparing: number;
  oldestAgeMs: number | null;
}

const STATION_ICONS: Record<string, JSX.Element> = {
  bucatarie: <ChefHat className="h-3.5 w-3.5" />,
  kitchen: <ChefHat className="h-3.5 w-3.5" />,
  bar: <Coffee className="h-3.5 w-3.5" />,
  pizza: <Flame className="h-3.5 w-3.5" />,
};

function fmtAge(ms: number | null): string {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function KitchenQueueStrip() {
  const tickets = useRemote((s) => s.tickets);

  const stats: StationStat[] = useMemo(() => {
    const by = new Map<string, StationStat>();
    const now = Date.now();
    for (const t of tickets) {
      const ageMs = t.created_at ? now - Date.parse(t.created_at) : null;
      const cur = by.get(t.station) ?? {
        station: t.station,
        pending: 0,
        preparing: 0,
        oldestAgeMs: null,
      };
      if (t.status === 'pending') cur.pending += 1;
      else if (t.status === 'preparing') cur.preparing += 1;
      if (ageMs != null && (cur.oldestAgeMs == null || ageMs > cur.oldestAgeMs)) {
        cur.oldestAgeMs = ageMs;
      }
      by.set(t.station, cur);
    }
    return Array.from(by.values()).sort((a, b) => a.station.localeCompare(b.station));
  }, [tickets]);

  if (stats.length === 0) {
    return (
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-white/10 bg-slate-950/40 backdrop-blur text-[11px] text-slate-500">
        <ChefHat className="h-3.5 w-3.5 text-slate-600" />
        <span>Bucătăria liberă — niciun tichet activ.</span>
      </div>
    );
  }

  const totalPending = stats.reduce((sum, s) => sum + s.pending, 0);
  const totalPreparing = stats.reduce((sum, s) => sum + s.preparing, 0);
  const oldestOverall = stats.reduce<number | null>(
    (acc, s) => (s.oldestAgeMs != null && (acc == null || s.oldestAgeMs > acc) ? s.oldestAgeMs : acc),
    null,
  );

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 border-b border-white/10 bg-slate-950/40 backdrop-blur overflow-x-auto">
      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
        <ChefHat className="h-3.5 w-3.5 text-violet-400" /> Bucătărie
      </span>
      <span className="text-[11px] text-slate-300 tabular-nums">
        {totalPending} pending · {totalPreparing} prep
      </span>
      {oldestOverall != null && oldestOverall > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-300 tabular-nums">
          <Clock className="h-3 w-3" /> {fmtAge(oldestOverall)}
        </span>
      )}
      <span className="ml-2 h-3 w-px bg-white/10" />
      {stats.map((s) => (
        <span
          key={s.station}
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-white/10 bg-slate-950/40 text-[11px] text-slate-300"
        >
          <span className="text-violet-300">{STATION_ICONS[s.station] ?? <ChefHat className="h-3.5 w-3.5" />}</span>
          <span className="font-semibold capitalize">{s.station}</span>
          <span className="tabular-nums">{s.pending + s.preparing}</span>
          {s.oldestAgeMs != null && s.oldestAgeMs > 0 && (
            <span className="text-amber-300 tabular-nums">{fmtAge(s.oldestAgeMs)}</span>
          )}
        </span>
      ))}
    </div>
  );
}
