import {
  Server,
  Database,
  Receipt,
  CreditCard,
  Printer,
  RefreshCcw,
  Wifi,
  WifiOff,
  AlertTriangle,
  Skull,
} from 'lucide-react';
import { useDeviceStatus, type StatusLevel } from '@/store/deviceStatus';

/**
 * Top status bar — desktop-only addition documented in
 * docs/pos-ui-parity.md. Mirrors the web app's chrome density and palette
 * (bg-slate-950/60 backdrop-blur, border-white/10).
 */
const dotClass = (level: StatusLevel): string => {
  switch (level) {
    case 'ok':
      return 'bg-emerald-400';
    case 'warn':
      return 'bg-amber-300';
    case 'error':
      return 'bg-rose-400';
    default:
      return 'bg-slate-500';
  }
};

interface CellProps {
  icon: React.ReactNode;
  label: string;
  level: StatusLevel;
  detail?: string;
}

function Cell({ icon, label, level, detail }: CellProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/10 bg-slate-950/40 backdrop-blur">
      <span className="text-violet-300">{icon}</span>
      <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
        {label}
      </span>
      <span className={`h-2 w-2 rounded-full ${dotClass(level)}`} />
      {detail && <span className="text-[11px] text-slate-300 tabular-nums">{detail}</span>}
    </div>
  );
}

export function StatusBar() {
  const s = useDeviceStatus();
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-white/10 bg-slate-950/60 backdrop-blur">
      <div className="flex items-center gap-2 overflow-x-auto">
        <Cell
          icon={<Server className="h-3.5 w-3.5" />}
          label="Backend"
          level={s.backend}
          detail={s.backendLatencyMs != null ? `${s.backendLatencyMs}ms` : undefined}
        />
        <Cell icon={<Database className="h-3.5 w-3.5" />} label="DB" level={s.db} />
        <Cell icon={<Receipt className="h-3.5 w-3.5" />} label="Fiscal" level={s.fiscal} />
        <Cell
          icon={<CreditCard className="h-3.5 w-3.5" />}
          label="Card POS"
          level={s.payment}
        />
        <Cell icon={<Printer className="h-3.5 w-3.5" />} label="Printer" level={s.printer} />
        <Cell
          icon={<RefreshCcw className="h-3.5 w-3.5" />}
          label="Queue"
          level={s.queueDepth === 0 ? 'ok' : s.queueDepth > 20 ? 'warn' : 'unknown'}
          detail={String(s.queueDepth)}
        />
      </div>
      <div className="flex items-center gap-2">
        {s.sync.failed > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-400/40">
            <AlertTriangle className="h-3 w-3" /> {s.sync.failed} failed
          </span>
        )}
        {s.sync.dead > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold bg-rose-500/15 text-rose-300 border border-rose-400/40">
            <Skull className="h-3 w-3" /> {s.sync.dead} dead
          </span>
        )}
        <span
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono uppercase tracking-wider text-slate-400 border border-white/10 bg-slate-950/40"
          title="Sync transport (Sprint 2 default = in-memory)"
        >
          tx:{s.transportMode}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
            s.online
              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-400/40'
              : 'bg-rose-500/15 text-rose-300 border border-rose-400/40'
          }`}
        >
          {s.online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {s.online ? 'Online' : 'Offline'}
        </span>
      </div>
    </div>
  );
}
