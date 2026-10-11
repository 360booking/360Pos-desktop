/**
 * Etapa 5 — offline till (local page, works with no internet at all).
 *
 * Shows the open orders the web POS cached on this station, lets the
 * cashier close one with cash/card and prints the fiscal receipt locally.
 * Every close is journaled (SQLite, src-tauri/src/offline.rs) and synced by
 * the web POS once the internet is back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  errText,
  lei,
  newMutationId,
  offlineApi,
  shellApi,
  type BridgeInfo,
  type CachedOrder,
  type JournalEntry,
} from './api';

type Tab = 'orders' | 'journal';

const SYNC_LABEL: Record<string, string> = {
  not_ready: '—',
  pending: 'de sincronizat',
  synced: 'sincronizat',
  conflict: 'conflict',
};
const FISCAL_LABEL: Record<string, string> = {
  printing: 'se tipărește',
  printed: 'tipărit',
  failed: 'eșuat',
  unknown: 'neclar — verifică rola',
};

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ro-RO');
}

function vatPct(v: number | null | undefined, fallback: number): string {
  const r = v ?? fallback;
  return `${Math.round(r * 1000) / 10}%${v == null ? '*' : ''}`;
}

export function OfflineTill() {
  const [tab, setTab] = useState<Tab>('orders');
  const [info, setInfo] = useState<BridgeInfo | null>(null);
  const [orders, setOrders] = useState<CachedOrder[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [selected, setSelected] = useState<CachedOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onlineSince = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [i, o, j] = await Promise.all([offlineApi.info(), offlineApi.listOrders(), offlineApi.journal(200)]);
      setInfo(i);
      setOrders(o);
      setJournal(j);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Internet back for 20s and nobody is in the middle of a close → return
  // to the web POS, which then syncs the journal.
  useEffect(() => {
    if (!info) return;
    if (!info.online) {
      onlineSince.current = null;
      return;
    }
    if (onlineSince.current == null) onlineSince.current = Date.now();
    const stable = Date.now() - onlineSince.current > 20_000;
    if (stable && !selected && info.posUrl && info.mode === 'web') {
      void shellApi.openPos();
    }
  }, [info, selected]);

  const review = journal.filter((j) => (j.needsReview && !j.reviewedAt) || j.fiscalStatus === 'unknown');

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3">
        <div className="text-lg font-bold">Casa offline</div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${info?.online ? 'bg-emerald-900/60 text-emerald-200' : 'bg-rose-900/60 text-rose-200'}`}
        >
          {info?.online ? 'Internet: revenit' : 'Internet: indisponibil'}
        </span>
        {info?.fiscal?.monitored ? (
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${info.fiscal.online ? 'bg-slate-800 text-slate-200' : 'bg-amber-900/60 text-amber-200'}`}
          >
            Casa de marcat: {info.fiscal.online ? 'răspunde' : 'nu răspunde'}
          </span>
        ) : null}
        {info?.fiscal?.provider === 'simulator' ? (
          <span className="rounded-full bg-amber-900/60 px-3 py-1 text-xs font-semibold text-amber-200">
            SIMULATOR — bonurile nu sunt reale
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${tab === 'orders' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300'}`}
            onClick={() => setTab('orders')}
          >
            Note deschise ({orders.length})
          </button>
          <button
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${tab === 'journal' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300'}`}
            onClick={() => setTab('journal')}
          >
            Jurnal offline{review.length ? ` · ${review.length} de verificat` : ''}
          </button>
          <button
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-semibold text-slate-300 hover:bg-slate-700"
            onClick={() => void shellApi.openFiscalSettings()}
          >
            Casă de marcat
          </button>
          <button
            className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-600 disabled:opacity-40"
            disabled={!info?.online}
            onClick={() => void shellApi.openPos()}
            title={info?.online ? '' : 'Fără internet'}
          >
            Înapoi la POS online
          </button>
        </div>
      </header>

      {error && <div className="bg-rose-950 px-5 py-2 text-sm text-rose-200">{error}</div>}

      <main className="min-h-0 flex-1 overflow-auto p-5">
        {tab === 'orders' ? (
          <OrdersGrid orders={orders} info={info} onPick={setSelected} />
        ) : (
          <JournalTable
            rows={journal}
            onChanged={() => void refresh()}
          />
        )}
      </main>

      {selected && info && (
        <CloseDialog
          order={selected}
          defaultVat={info.defaultVat}
          onClose={() => setSelected(null)}
          onDone={() => {
            setSelected(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function OrdersGrid({
  orders,
  info,
  onPick,
}: {
  orders: CachedOrder[];
  info: BridgeInfo | null;
  onPick: (o: CachedOrder) => void;
}) {
  if (!orders.length) {
    return (
      <div className="mx-auto max-w-xl space-y-2 pt-16 text-center text-slate-400">
        <div className="text-lg font-semibold text-slate-200">Nicio notă deschisă în cache</div>
        <p className="text-sm">
          Notele apar aici după ce POS-ul web a rulat online pe această stație.
          {info?.journal.lastCachedAt ? ` Ultima actualizare: ${fmtTime(info.journal.lastCachedAt)}.` : ''}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500">
        Situația notelor de la {fmtTime(info?.journal.lastCachedAt ?? null)}. Produsele nu se pot modifica offline.
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {orders.map((o) => (
          <button
            key={o.id}
            className={`space-y-2 rounded-xl border p-4 text-left transition ${o.offlineBlockReason ? 'border-slate-800 bg-slate-900/40 opacity-70' : 'border-slate-700 bg-slate-900 hover:border-sky-500'}`}
            onClick={() => onPick(o)}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-base font-bold">{o.tableLabel || 'Fără masă'}</span>
              <span className="text-lg font-bold text-sky-300">{lei(o.total, o.currency)}</span>
            </div>
            <div className="text-xs text-slate-400">
              {o.items.length} produse{o.waiterName ? ` · ${o.waiterName}` : ''}
            </div>
            {o.offlineBlockReason ? <div className="text-xs text-amber-300">{o.offlineBlockReason}</div> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function CloseDialog({
  order,
  defaultVat,
  onClose,
  onDone,
}: {
  order: CachedOrder;
  defaultVat: number;
  onClose: () => void;
  onDone: () => void;
}) {
  // One mutation id per dialog: a retry after a failed print reuses it, so
  // the journal (and later the server) can never see two payments.
  const mutationId = useMemo(() => newMutationId(), []);
  const [method, setMethod] = useState<'cash' | 'card'>('cash');
  const [cif, setCif] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<JournalEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const missingVat = order.items.some((i) => i.vatRate == null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await offlineApi.closeOrder({
        orderId: order.id,
        mutationId,
        method,
        customerCif: cif.trim().toUpperCase().replace(/\s+/g, '') || null,
      });
      setResult(r);
      if (r.fiscalStatus === 'failed') setError(r.fiscalError || 'Tipărirea a eșuat.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const done = result && result.fiscalStatus === 'printed';
  const unclear = result && (result.fiscalStatus === 'unknown' || result.fiscalStatus === 'printing');

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
      <div className="flex max-h-full w-full max-w-lg flex-col space-y-4 overflow-auto rounded-2xl border border-slate-700 bg-slate-900 p-5">
        <div className="flex items-baseline justify-between">
          <div className="text-lg font-bold">{order.tableLabel || 'Notă'}</div>
          <div className="text-xl font-bold text-sky-300">{lei(order.total, order.currency)}</div>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {order.items.map((it, idx) => (
              <tr key={idx} className="border-b border-slate-800">
                <td className="py-1.5 pr-2">{it.name}</td>
                <td className="py-1.5 pr-2 text-right text-slate-400">×{it.quantity}</td>
                <td className="py-1.5 pr-2 text-right text-slate-500">{vatPct(it.vatRate, defaultVat)}</td>
                <td className="py-1.5 text-right">{lei(it.lineTotal, order.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {missingVat && (
          <div className="text-xs text-amber-300">* cota TVA implicită a stației (produsul nu avea cotă în cache).</div>
        )}

        {order.offlineBlockReason ? (
          <div className="rounded-lg bg-amber-900/40 px-3 py-2 text-sm text-amber-200">{order.offlineBlockReason}</div>
        ) : done ? (
          <div className="rounded-lg bg-emerald-900/40 px-3 py-3 text-sm text-emerald-100">
            Bon fiscal <b>{result.fiscalNumber}</b> tipărit. Plata se trimite la server când revine internetul.
          </div>
        ) : unclear ? (
          <div className="rounded-lg bg-amber-900/40 px-3 py-3 text-sm text-amber-100">
            Casa nu a confirmat clar bonul. Verifică pe rolă dacă a ieșit, apoi marchează-l în Jurnal. Nu reîncerca până
            nu verifici.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              {(['cash', 'card'] as const).map((m) => (
                <button
                  key={m}
                  className={`rounded-xl py-3 text-base font-bold ${method === m ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                  onClick={() => setMethod(m)}
                  disabled={busy}
                >
                  {m === 'cash' ? 'Numerar' : 'Card (terminal separat)'}
                </button>
              ))}
            </div>
            <input
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              placeholder="CUI cumpărător (opțional)"
              value={cif}
              onChange={(e) => setCif(e.target.value)}
              disabled={busy}
            />
          </>
        )}

        {error && <div className="rounded-lg bg-rose-900/40 px-3 py-2 text-sm text-rose-200">{error}</div>}

        <div className="flex justify-end gap-2">
          {done || unclear ? (
            <button className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white" onClick={onDone}>
              Gata
            </button>
          ) : (
            <>
              <button className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-300" onClick={onClose} disabled={busy}>
                Renunță
              </button>
              {!order.offlineBlockReason && (
                <button
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
                  onClick={submit}
                  disabled={busy}
                >
                  {busy ? 'Se tipărește bonul…' : error ? 'Reîncearcă bonul' : 'Încasează și tipărește bonul'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function JournalTable({ rows, onChanged }: { rows: JournalEntry[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!rows.length) {
    return <div className="pt-16 text-center text-slate-400">Niciun bon emis offline pe această stație.</div>;
  }
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      window.alert(errText(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase text-slate-500">
        <tr>
          <th className="py-2 pr-3">Ora</th>
          <th className="py-2 pr-3">Masa</th>
          <th className="py-2 pr-3 text-right">Suma</th>
          <th className="py-2 pr-3">Plată</th>
          <th className="py-2 pr-3">Bon</th>
          <th className="py-2 pr-3">Sincronizare</th>
          <th className="py-2">Verificare</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const flagged = (r.needsReview && !r.reviewedAt) || r.fiscalStatus === 'unknown';
          return (
            <tr key={r.id} className={`border-t border-slate-800 align-top ${flagged ? 'bg-amber-950/30' : ''}`}>
              <td className="py-2 pr-3 text-slate-400">{fmtTime(r.createdAt)}</td>
              <td className="py-2 pr-3">{r.tableLabel || '—'}</td>
              <td className="py-2 pr-3 text-right">{lei(r.amount, r.currency)}</td>
              <td className="py-2 pr-3">{r.method === 'cash' ? 'numerar' : 'card'}</td>
              <td className="py-2 pr-3">
                {r.fiscalNumber ? <b>{r.fiscalNumber}</b> : FISCAL_LABEL[r.fiscalStatus] ?? r.fiscalStatus}
                {r.fiscalError ? <div className="text-xs text-rose-300">{r.fiscalError}</div> : null}
              </td>
              <td className="py-2 pr-3">
                {SYNC_LABEL[r.syncStatus] ?? r.syncStatus}
                {r.lastSyncError ? <div className="text-xs text-slate-500">{r.lastSyncError}</div> : null}
              </td>
              <td className="py-2">
                {r.reviewReason ? <div className="text-xs text-amber-200">{r.reviewReason}</div> : null}
                {r.fiscalStatus === 'unknown' && (
                  <ResolveUnknown
                    busy={busy === r.id}
                    onResolve={(printed, bf) => act(r.id, () => offlineApi.resolveUnknown(r.id, printed, bf))}
                  />
                )}
                <div className="mt-1 flex flex-wrap gap-1">
                  {flagged && r.fiscalStatus !== 'unknown' && (
                    <button
                      className="rounded bg-slate-700 px-2 py-1 text-xs font-semibold disabled:opacity-50"
                      disabled={busy === r.id}
                      onClick={() => act(r.id, () => offlineApi.markReviewed(r.id))}
                    >
                      Am verificat
                    </button>
                  )}
                  {r.syncStatus === 'conflict' && r.fiscalStatus === 'printed' && (
                    <button
                      className="rounded bg-slate-700 px-2 py-1 text-xs font-semibold disabled:opacity-50"
                      disabled={busy === r.id}
                      onClick={() => act(r.id, () => offlineApi.requeue(r.id))}
                      title="După ce ai corectat nota pe server"
                    >
                      Retrimite plata
                    </button>
                  )}
                  {r.reviewedAt ? <span className="text-xs text-slate-500">verificat {fmtTime(r.reviewedAt)}</span> : null}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ResolveUnknown({
  busy,
  onResolve,
}: {
  busy: boolean;
  onResolve: (printed: boolean, bf: string | null) => void;
}) {
  const [bf, setBf] = useState('');
  return (
    <div className="mt-1 space-y-1 rounded border border-amber-800/60 p-2">
      <div className="text-xs text-amber-200">Uită-te pe rolă: a ieșit bonul?</div>
      <div className="flex flex-wrap items-center gap-1">
        <input
          className="w-28 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
          placeholder="Nr. BF"
          value={bf}
          onChange={(e) => setBf(e.target.value)}
          disabled={busy}
        />
        <button
          className="rounded bg-emerald-700 px-2 py-1 text-xs font-semibold disabled:opacity-50"
          disabled={busy || !bf.trim()}
          onClick={() => onResolve(true, bf.trim())}
        >
          A ieșit
        </button>
        <button
          className="rounded bg-slate-700 px-2 py-1 text-xs font-semibold disabled:opacity-50"
          disabled={busy}
          onClick={() => onResolve(false, null)}
        >
          Nu a ieșit
        </button>
      </div>
    </div>
  );
}
