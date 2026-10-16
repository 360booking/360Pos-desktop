/**
 * „Împarte nota” — ca pos/SplitDialog.tsx din POS-ul web: notele mesei una
 * lângă alta (A, B, C…). Alegi nota în care muți, apoi atingi produsele din
 * celelalte note — fiecare atingere mută o bucată (POST /items/move, cu
 * `newCheck` pentru o notă nouă). „Împarte pe locuri” (POST /split-seats)
 * apare când produsele au locuri. Fiecare notă se încasează separat, cu
 * bonul ei. Serverul refuză notele cu încasări, reducere sau bon.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Users, X } from 'lucide-react';

import { formatMoney } from '@/core/pos-core';
import { isReachable } from '@/lib/reachability';
import {
  OfflineMutationError,
  restaurantOrdersApi,
  type RestaurantOrder,
} from '@/lib/api/restaurantOrders';

import {
  NEW_CHECK,
  applyMoveResult,
  canMoveItem,
  checkLetter,
  defaultTarget,
  hasSeats,
  isCheckLocked,
  moveRequest,
  tableChecks,
  visibleLines,
} from './tipSplit';

const cents = (v: number) => Math.round(v * 100);

export function SplitBillDialog({
  tableId,
  activeOrderId,
  onClose,
  onPay,
  onError,
}: {
  tableId: string;
  /** Nota din coș (server id) — „Împarte pe locuri” pornește de la ea. */
  activeOrderId: string | null;
  onClose: () => void;
  onPay: (orderId: string) => void;
  onError: (err: unknown, title?: string) => void;
}) {
  const [checks, setChecks] = useState<RestaurantOrder[] | null>(null);
  const [target, setTarget] = useState<string>(NEW_CHECK);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const all = await restaurantOrdersApi.list({ limit: 200 });
    const list = tableChecks(all, tableId);
    setChecks(list);
    return list;
  }, [tableId]);

  useEffect(() => {
    if (!isReachable()) {
      onError(new OfflineMutationError('splitBill'));
      onClose();
      return;
    }
    load()
      .then((list) => setTarget(defaultTarget(list)))
      .catch((err) => {
        onError(err, 'Nu am putut încărca notele mesei');
        onClose();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const letter = useMemo(
    () => new Map((checks ?? []).map((o, i) => [o.id, checkLetter(i)])),
    [checks],
  );
  const nextLetter = checkLetter(checks?.length ?? 0);
  const active = checks?.find((o) => o.id === activeOrderId) ?? null;

  const move = async (from: RestaurantOrder, itemId: string) => {
    if (busy) return;
    if (!isReachable()) {
      onError(new OfflineMutationError('splitBill'));
      return;
    }
    setBusy(true);
    try {
      const r = await restaurantOrdersApi.moveItems(from.id, [{ itemId, quantity: 1 }], moveRequest(target));
      setChecks((prev) => applyMoveResult(prev ?? [], r));
      // The new check becomes the target, so the next taps go there too.
      if (target === NEW_CHECK) setTarget(r.to.id);
    } catch (err) {
      onError(err, 'Nu am putut muta produsul');
    } finally {
      setBusy(false);
    }
  };

  const splitSeats = async () => {
    if (!active || busy) return;
    setBusy(true);
    try {
      const r = await restaurantOrdersApi.splitBySeats(active.id);
      const list = await load();
      setTarget(defaultTarget(list));
      if (r.orders.length < 2) onError(new Error('Toate produsele sunt pe același loc.'), 'Împarte pe locuri');
    } catch (err) {
      onError(err, 'Nu am putut împărți nota pe locuri');
    } finally {
      setBusy(false);
    }
  };

  const tableLabel = checks?.[0]?.tableNumber ?? '';

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="flex w-full max-w-6xl flex-col rounded-2xl border border-white/10 bg-slate-950/95 shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Împarte nota{tableLabel ? ` · Masa ${tableLabel}` : ''}</h3>
            <p className="text-sm text-slate-400">
              Alege nota în care muți, apoi atinge produsele. Fiecare notă se încasează separat, cu bonul ei.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Închide">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-5 py-3" role="group" aria-label="Muți în">
          <span className="text-sm text-slate-400">Muți în</span>
          {(checks ?? []).map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={target === o.id}
              onClick={() => setTarget(o.id)}
              className={`min-h-10 rounded-lg border px-3.5 text-sm font-semibold ${target === o.id ? 'border-violet-400 bg-violet-500/25 text-white' : 'border-white/10 text-slate-300 hover:text-white'}`}
            >
              Nota {letter.get(o.id)}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={target === NEW_CHECK}
            onClick={() => setTarget(NEW_CHECK)}
            className={`inline-flex min-h-10 items-center gap-1 rounded-lg border px-3.5 text-sm font-semibold ${target === NEW_CHECK ? 'border-violet-400 bg-violet-500/25 text-white' : 'border-dashed border-white/25 text-slate-300 hover:text-white'}`}
          >
            <Plus className="h-4 w-4" /> Notă nouă ({nextLetter})
          </button>
          {hasSeats(active) && (
            <button
              type="button"
              disabled={busy || !active || isCheckLocked(active)}
              onClick={() => void splitSeats()}
              className="ml-auto inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 text-sm font-semibold text-slate-200 hover:bg-white/[0.08] disabled:opacity-50"
            >
              <Users className="h-4 w-4" /> Împarte pe locuri
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {checks == null ? (
            <div className="text-sm text-slate-400">Se încarcă notele mesei…</div>
          ) : checks.length === 0 ? (
            <div className="text-sm text-slate-400">Masa nu are note deschise.</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {checks.map((o) => {
                const locked = isCheckLocked(o);
                const lines = visibleLines(o);
                return (
                  <section
                    key={o.id}
                    className={`flex min-w-0 flex-col gap-2 rounded-xl border p-3 ${target === o.id ? 'border-violet-400' : 'border-white/10'}`}
                  >
                    <div className="flex items-baseline justify-between">
                      <h4 className="text-base font-bold text-white">Nota {letter.get(o.id)}</h4>
                      <span className="text-xs text-slate-400">
                        {locked
                          ? 'are încasări — nu se mai împarte'
                          : `${lines.reduce((s, i) => s + i.quantity, 0)} produse`}
                      </span>
                    </div>
                    <ul className="space-y-1.5">
                      {lines.map((it) => {
                        const movable = canMoveItem(o, it, target);
                        return (
                          <li key={it.id}>
                            <button
                              type="button"
                              disabled={!movable || busy}
                              onClick={() => void move(o, it.id)}
                              title={movable ? 'Mută o bucată în nota aleasă' : undefined}
                              className={`flex min-h-11 w-full items-center gap-2 rounded-lg border px-2.5 text-left text-sm ${movable ? 'border-white/10 bg-white/[0.05] text-white hover:border-violet-400' : 'border-transparent text-slate-400'}`}
                            >
                              <span className="w-7 font-semibold tabular-nums">{it.quantity}×</span>
                              {it.seatNo ? (
                                <span className="rounded bg-white/10 px-1.5 text-xs font-semibold text-slate-300">L{it.seatNo}</span>
                              ) : null}
                              <span className="min-w-0 flex-1 truncate">{it.nameSnapshot}</span>
                              <span className="tabular-nums">{formatMoney(cents(it.lineTotal))}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="mt-auto flex items-baseline justify-between border-t border-white/10 pt-2">
                      <span className="text-sm text-slate-400">Total</span>
                      <span className="text-lg font-semibold tabular-nums text-white">{formatMoney(cents(o.total))}</span>
                    </div>
                    <button
                      type="button"
                      disabled={busy || o.total <= 0}
                      onClick={() => onPay(o.id)}
                      className="touch-target rounded-xl border border-emerald-400/30 bg-emerald-600/40 py-3 text-sm font-semibold text-emerald-100 hover:bg-emerald-600/60 disabled:opacity-50"
                    >
                      Încasează nota {letter.get(o.id)}
                    </button>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <footer className="flex justify-end border-t border-white/10 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="touch-target rounded-xl border border-white/10 bg-white/[0.06] px-6 py-2.5 text-sm font-semibold text-slate-100 hover:bg-white/[0.1]"
          >
            Gata
          </button>
        </footer>
      </div>
    </div>
  );
}
