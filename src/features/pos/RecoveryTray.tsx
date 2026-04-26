/**
 * Recovery Tray — Sprint 8.
 *
 * Modal-style panel listing all open CARD_PAYMENT_UNKNOWN entries the
 * desktop has accumulated. The operator (or manager) reviews each row
 * and decides whether the terminal physically accepted the charge:
 *
 *   - Mark as PAID: registers a card payment server-side equivalent
 *     (Sprint 8 stops at the local resolution; backend reconciliation
 *     comes when the BT POS adapter ships and we can query the
 *     terminal for the auth status). The recovery row flips to
 *     status='resolved_paid' so the tray stops showing it.
 *
 *   - Mark as VOID: the terminal didn't actually charge. The recovery
 *     row flips to 'resolved_void'. The order is left unchanged.
 *
 *   - Retry status check: stub in Sprint 8 (real BT POS lookup later).
 *
 *   - View raw details: shows trace / auth_code / rrn so support can
 *     cross-check against a terminal printout.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, X, CheckCircle2, Ban, RefreshCw, Eye } from 'lucide-react';
import { useRecovery } from '@/store/recovery';
import { getSyncEngine } from '@/lib/sync/bootstrap';
import { formatMoney } from '@/core/pos-core';
import type { CardRecoveryRow } from '@/lib/db/cardRecovery';

export function RecoveryTray({ onClose }: { onClose: () => void }) {
  const rows = useRecovery((s) => s.rows);
  const refresh = useRecovery((s) => s.refresh);
  const resolve = useRecovery((s) => s.resolve);
  const [viewing, setViewing] = useState<CardRecoveryRow | null>(null);

  useEffect(() => {
    const engine = getSyncEngine();
    if (engine) void refresh(engine.exec);
  }, [refresh]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 shadow-2xl flex flex-col">
        <header className="flex items-center justify-between p-4 border-b border-white/10">
          <h3 className="text-base font-semibold text-white inline-flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-300" />
            Recovery — plăți cu status necunoscut
            {rows.length > 0 && (
              <span className="ml-2 inline-flex items-center justify-center rounded-full bg-amber-500/20 text-amber-200 text-[11px] font-semibold border border-amber-400/40 px-2 py-0.5">
                {rows.length}
              </span>
            )}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {rows.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-10 text-slate-400 text-sm gap-2">
            <CheckCircle2 className="h-8 w-8 text-emerald-400" />
            <p>Niciun caz de rezolvat. Plățile cu card sunt în regulă.</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {rows.map((row) => (
              <div
                key={row.id}
                className="rounded-xl border border-white/10 bg-white/[0.04] p-3 flex items-start gap-3"
              >
                <AlertTriangle className="h-4 w-4 text-amber-300 mt-1 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white">
                    Comanda <span className="font-mono text-[12px]">{row.order_id.slice(0, 8)}…</span>
                    <span className="ml-2 text-violet-200">{formatMoney(row.amount_cents)}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Raportat: {new Date(row.raised_at).toLocaleString()}
                  </div>
                  {row.terminal_auth_code && (
                    <div className="text-[11px] text-slate-400">
                      Auth: <span className="font-mono">{row.terminal_auth_code}</span>
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const engine = getSyncEngine();
                      if (engine) void resolve(engine.exec, row.id, 'resolved_paid', 'Confirmat manual');
                    }}
                    className="touch-target rounded-lg px-3 py-1.5 text-[12px] font-semibold bg-emerald-600/30 text-emerald-200 border border-emerald-400/40 hover:bg-emerald-600/50 inline-flex items-center gap-1.5"
                    title="Terminal a încasat — marchează plătit"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" /> Plătit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const engine = getSyncEngine();
                      if (engine) void resolve(engine.exec, row.id, 'resolved_void', 'Confirmat că nu s-a încasat');
                    }}
                    className="touch-target rounded-lg px-3 py-1.5 text-[12px] font-semibold bg-rose-600/30 text-rose-200 border border-rose-400/40 hover:bg-rose-600/50 inline-flex items-center gap-1.5"
                  >
                    <Ban className="h-3.5 w-3.5" /> Void
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewing(row)}
                    className="touch-target rounded-lg px-3 py-1.5 text-[12px] font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60 inline-flex items-center gap-1.5"
                  >
                    <Eye className="h-3.5 w-3.5" /> Detalii
                  </button>
                  <button
                    type="button"
                    disabled
                    className="touch-target rounded-lg px-3 py-1.5 text-[12px] font-semibold bg-violet-600/20 text-violet-300/70 border border-violet-400/20 inline-flex items-center gap-1.5 opacity-60"
                    title="Disponibil când adaptorul real BT POS e activ (Sprint 9+)"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Retry
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {viewing && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className="w-full max-w-md rounded-xl border border-white/10 bg-slate-950 p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-white">Detalii recovery</h4>
                <button
                  type="button"
                  onClick={() => setViewing(null)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <pre className="text-[11px] text-slate-300 bg-slate-900/60 rounded p-3 overflow-x-auto">
{JSON.stringify(viewing, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
