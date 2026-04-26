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
  CloudDownload,
  LifeBuoy,
  Settings,
} from 'lucide-react';
import { useDeviceStatus, type StatusLevel } from '@/store/deviceStatus';
import { useCatalog } from '@/store/catalog';
import { useRecovery } from '@/store/recovery';

/** A bootstrap older than this counts as stale — yellow dot. The
 * scheduler ticks every 30 minutes (BOOTSTRAP_REFRESH_MS) so we give it
 * a generous overlap before warning. */
const BOOTSTRAP_STALE_MS = 35 * 60 * 1000;

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

function bootstrapStatus(lastSuccessfulAt: string | null): { level: StatusLevel; detail?: string } {
  if (!lastSuccessfulAt) return { level: 'unknown', detail: 'never' };
  const ts = Date.parse(lastSuccessfulAt);
  if (Number.isNaN(ts)) return { level: 'unknown' };
  const ageMs = Date.now() - ts;
  if (ageMs < 0) return { level: 'ok' };
  if (ageMs < BOOTSTRAP_STALE_MS) {
    const m = Math.floor(ageMs / 60_000);
    return { level: 'ok', detail: m === 0 ? 'now' : `${m}m` };
  }
  const m = Math.floor(ageMs / 60_000);
  return { level: 'warn', detail: `${m}m` };
}

interface StatusBarProps {
  onOpenRecovery?: () => void;
  onOpenDiagnostics?: () => void;
}

export function StatusBar({ onOpenRecovery, onOpenDiagnostics }: StatusBarProps = {}) {
  const s = useDeviceStatus();
  const lastBootstrapAt = useCatalog((c) => c.lastSuccessfulAt);
  const recoveryCount = useRecovery((r) => r.rows.length);
  const bs = bootstrapStatus(lastBootstrapAt);
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
        <Cell
          icon={<CloudDownload className="h-3.5 w-3.5" />}
          label="Bootstrap"
          level={bs.level}
          detail={bs.detail}
        />
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
        {onOpenDiagnostics && (
          <button
            type="button"
            onClick={onOpenDiagnostics}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-slate-300 border border-white/10 bg-slate-950/40 hover:bg-slate-700/40"
            title="Diagnostics — copy snapshot for support"
          >
            <Settings className="h-3 w-3" />
          </button>
        )}
        {recoveryCount > 0 && onOpenRecovery && (
          <button
            type="button"
            onClick={onOpenRecovery}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold bg-amber-500/20 text-amber-200 border border-amber-400/40 hover:bg-amber-500/30"
            title="Plăți cu status necunoscut — apasă pentru recovery"
          >
            <LifeBuoy className="h-3 w-3" /> {recoveryCount} recovery
          </button>
        )}
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
