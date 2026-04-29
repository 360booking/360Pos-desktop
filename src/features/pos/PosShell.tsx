import { useEffect, useMemo, useState } from 'react';
import { Plus, Minus, Trash2, Users, Utensils, Receipt, Send, CreditCard, Banknote, Lock } from 'lucide-react';
import { StatusBar } from './StatusBar';
import RestaurantAlertBanner from './RestaurantAlertBanner';
import { KitchenQueueStrip } from './KitchenQueueStrip';
import { ClaimOrderModal } from './ClaimOrderModal';
import { PaymentModal } from './PaymentModal';
import { RecoveryTray } from './RecoveryTray';
import { NewOrderSheet } from './NewOrderSheet';
import { DiagnosticsModal } from './DiagnosticsModal';
import { SettingsScreen } from '@/features/settings/SettingsScreen';
import { useRecovery } from '@/store/recovery';
import { useCatalogBootstrap } from './useCatalogBootstrap';
import { useOrderActions } from './useOrderActions';
import { useCatalog } from '@/store/catalog';
import { useRemote } from '@/store/remote';
import { pushToast } from '@/features/ui/Toast';
import { useAuthStore } from '@/store/auth';
import { getSyncEngine } from '@/lib/sync/bootstrap';
import { runBootstrap } from '@/lib/sync/runBootstrap';
import {
  readLastBootstrap,
  readLastBootstrapRestaurantId,
  rememberBootstrap,
} from '@/lib/sync/lastBootstrap';
import type { ProductRow, TableRow } from '@/lib/db/catalogQueries';
import type { RemoteOrderRow } from '@/lib/db/remoteQueries';
import {
  computeTotals,
  formatMoney,
  rateToFloat,
  ROMANIAN_DEFAULT_VAT_BP,
  type Order,
  type OrderTotals,
} from '@/core/pos-core';

/**
 * Three-pane POS shell. Class strings match POSPage.tsx so the visual
 * footprint is identical. Sprint 4 / 3 wires the cart to the live
 * outbox: clicking a product runs addItem through the dispatch chain,
 * the resulting events land in SQLite events + sync_outbox, and the
 * worker pushes them to /api/pos/sync/push as soon as the device is
 * online. The cart pane reads from the same useCurrentOrder store.
 */
export function PosShell() {
  useCatalogBootstrap();
  const actions = useOrderActions();
  const totals = useMemo<OrderTotals>(
    () => (actions.order ? computeTotals(actions.order) : EMPTY_TOTALS),
    [actions.order],
  );

  // Modal states. ClaimOrderModal opens when the operator taps a remote
  // table whose lock is held by another device. PaymentModal opens from
  // the cart's Cash button. RecoveryTray opens from the StatusBar pill.
  const [claimTarget, setClaimTarget] = useState<RemoteOrderRow | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [newOrderOpen, setNewOrderOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Hydrate the recovery list once on mount so the StatusBar pill
  // reflects pre-existing rows from a prior session.
  useEffect(() => {
    const e = getSyncEngine();
    if (e) void useRecovery.getState().refresh(e.exec);
  }, []);

  // Mirror printer config locally so the offline kitchen-print fallback
  // has fresh data even when the network drops mid-shift. Best-effort —
  // a failure here only means we'll keep the previously-cached config.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { kitchenPrintersApi } = await import('@/lib/api/kitchenPrinters');
        const { writePrintersCache } = await import('@/lib/print/cache');
        const list = await kitchenPrintersApi.list();
        if (!cancelled) await writePrintersCache(list);
      } catch {
        /* offline / 401 / 403 — keep stale cache */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sprint 11.8 — auto-refresh the cart when the pull cycle brings
  // updated state for the currently-active order (e.g. KDS marked it
  // "ready", waiter on another device added a line). Mirrors browser
  // POS behaviour where activeOrder is just .find() over the orders
  // list, so any list refresh propagates instantly.
  const remoteOrdersForRefresh = useRemote((s) => s.orders);
  const activeOrderId = actions.order?.id ?? null;
  useEffect(() => {
    if (!activeOrderId) return;
    const remote = remoteOrdersForRefresh.find((o) => o.id === activeOrderId);
    if (!remote) return;
    // Server says the order is closed/paid → drop it from the cart.
    if (remote.is_open !== 1) {
      actions.clear();
      return;
    }
    // Otherwise re-load from remote to pick up status / new items.
    void actions.resumeOrder(activeOrderId);
    // We deliberately exclude `actions` from deps — the resumeOrder
    // identity is stable across renders via useCallback, and including
    // it would cause this effect to run on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrderId, remoteOrdersForRefresh]);

  function handleTablePick(tableId: string) {
    // Sprint 11.8 — match the browser POS pattern (selectOrStartOnTable):
    // an open remote order on this table is RESUMED into the cart, not
    // shadowed by a new draft. This stops the desktop from creating a
    // duplicate RestaurantOrder server-side every time the operator
    // taps an occupied table, and it brings the existing items
    // (including the "Trimis" lock state per line) back into the cart
    // so the "Trimite update (N)" button reflects reality.
    const remote = useRemote
      .getState()
      .orders.find((o) => o.table_id === tableId && o.is_open === 1);
    if (remote && !remote.current_device_can_edit) {
      // Foreign-locked → don't auto-create a new draft, prompt for claim.
      setClaimTarget(remote);
      return;
    }
    if (remote) {
      void actions.resumeOrder(remote.id);
      return;
    }
    void actions.newOrder(tableId);
  }

  function onClaimedFromModal() {
    const claimedId = claimTarget?.id ?? null;
    setClaimTarget(null);
    // Trigger a fresh pull so the cache flips currentDeviceCanEdit
    // immediately without waiting for the 8s tick.
    const engine = getSyncEngine();
    void engine?.pullScheduler.runNow();
    // Sprint 11.8 — after claiming, resume the existing order into the
    // cart (mirror browser POS behaviour: claim = take over editing).
    if (claimedId) void actions.resumeOrder(claimedId);
  }

  return (
    <div className="flex flex-col h-screen bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-950 text-slate-100">
      <StatusBar
        onOpenRecovery={() => setRecoveryOpen(true)}
        onOpenDiagnostics={() => setDiagnosticsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <RestaurantAlertBanner />
      <KitchenQueueStrip />
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <TablesPane
          onPickTable={handleTablePick}
          onPickNewOrder={() => setNewOrderOpen(true)}
          activeOrder={actions.order}
          totals={totals}
        />
        <MenuPane
          onPickProduct={(p) => {
            void actions.addProduct(p).catch((err: unknown) => {
              const msg = (err as { message?: string })?.message ?? String(err);
              pushToast({
                level: 'error',
                title: 'Nu am putut adăuga produsul',
                message: msg,
              });
            });
          }}
        />
        <CartPane
          order={actions.order}
          totals={totals}
          onCash={() => setPaymentOpen(true)}
          onClear={() => actions.clear()}
          onIncrement={(id) =>
            void actions.incrementQuantity(id).catch((err: unknown) => {
              pushToast({ level: 'error', message: (err as { message?: string })?.message ?? String(err) });
            })
          }
          onDecrement={(id) =>
            void actions.decrementQuantity(id).catch((err: unknown) => {
              pushToast({ level: 'error', message: (err as { message?: string })?.message ?? String(err) });
            })
          }
          onRemove={(id) =>
            void actions.removeItem(id).catch((err: unknown) => {
              pushToast({ level: 'error', message: (err as { message?: string })?.message ?? String(err) });
            })
          }
          onSendToKitchen={() =>
            void actions.sendOrderToKitchen().catch((err: unknown) => {
              pushToast({ level: 'error', title: 'Trimitere kitchen eșuată', message: (err as { message?: string })?.message ?? String(err) });
            })
          }
          onCancel={() => {
            if (!actions.order) return;
            if (!confirm('Anulezi comanda? Nu se va mai factura.')) return;
            void actions.cancelCurrentOrder().catch((err: unknown) => {
              alert(
                (err as { message?: string })?.message
                  ?? 'Nu am putut anula comanda.',
              );
            });
          }}
        />
      </div>
      {claimTarget && (
        <ClaimOrderModal
          orderId={claimTarget.id}
          ownerDeviceId={claimTarget.owner_device_id}
          expiresAt={claimTarget.owner_expires_at}
          canForce={
            ['super_admin', 'tenant_admin'].includes(
              useCatalog.getState().currentUser?.role ?? '',
            )
          }
          onClose={() => setClaimTarget(null)}
          onClaimed={onClaimedFromModal}
        />
      )}
      {paymentOpen && actions.order && (
        <PaymentModal
          orderId={actions.order.id}
          totals={totals}
          onClose={() => setPaymentOpen(false)}
          onCash={(amt, over) => actions.payCashAmount(amt, over)}
          onCardOutcome={(amt, status, terminal) =>
            actions.recordCardOutcome(amt, status, terminal)
          }
        />
      )}
      {recoveryOpen && <RecoveryTray onClose={() => setRecoveryOpen(false)} />}
      {diagnosticsOpen && <DiagnosticsModal onClose={() => setDiagnosticsOpen(false)} />}
      {settingsOpen && <SettingsScreen onClose={() => setSettingsOpen(false)} />}
      {newOrderOpen && (
        <NewOrderSheet
          onClose={() => setNewOrderOpen(false)}
          onPickTable={() => {
            // No-op — operator continues with the existing tap-on-table
            // flow. The sheet closes itself.
          }}
          onPickWalkIn={(name, notes) => {
            void actions.newOrderWithCustomer('walkin', {
              customerName: name,
              notes,
            });
          }}
          onPickDelivery={(c) => {
            void actions.newOrderWithCustomer('home_delivery', c);
          }}
        />
      )}
    </div>
  );
}

const EMPTY_TOTALS: OrderTotals = {
  subtotalCents: 0,
  discountCents: 0,
  tipCents: 0,
  vatCents: 0,
  totalCents: 0,
  paidCents: 0,
  remainingCents: 0,
  changeDueCents: 0,
};

/* ─── Left pane: tables ──────────────────────────────────────────────────── */

interface TablesPaneProps {
  onPickTable: (tableId: string) => void;
  onPickNewOrder: () => void;
  activeOrder: Order | null;
  totals: OrderTotals;
}

type TableSlotStatus =
  | 'empty'
  | 'open'
  | 'unsent'
  | 'sent'
  | 'partial'
  | 'paid';

function statusForActive(order: Order, totals: OrderTotals): TableSlotStatus {
  if (order.state === 'paid' || order.state === 'closed') return 'paid';
  if (totals.paidCents > 0 && totals.remainingCents > 0) return 'partial';
  const active = order.items.filter((it) => !it.voidedAt);
  if (active.length === 0) return 'open';
  if (active.some((it) => !it.sentAt)) return 'unsent';
  return 'sent';
}

const STATUS_PILL: Record<TableSlotStatus, { label: string; className: string }> = {
  empty: { label: 'Liberă', className: 'text-emerald-300' },
  open: { label: 'Deschisă', className: 'text-violet-300' },
  unsent: { label: 'Netrimis', className: 'text-amber-300' },
  sent: { label: 'Trimis', className: 'text-emerald-300' },
  partial: { label: 'Plată parțială', className: 'text-amber-300' },
  paid: { label: 'Plătită', className: 'text-emerald-300' },
};
const STATUS_DOT: Record<TableSlotStatus, string> = {
  empty: 'bg-emerald-400',
  open: 'bg-violet-400',
  unsent: 'bg-amber-300',
  sent: 'bg-emerald-400',
  partial: 'bg-amber-300',
  paid: 'bg-slate-400',
};

function statusForRemote(
  o: RemoteOrderRow,
  itemsByOrder: Map<string, { sent: number; total: number }>,
): TableSlotStatus {
  if (o.payment_status === 'paid') return 'paid';
  if (o.payment_status === 'partial') return 'partial';
  if (o.status === 'sent' || o.status === 'preparing' || o.status === 'ready' || o.status === 'served') {
    // Some lines may have been added after the first send → 'unsent' badge
    // is the right visual cue ("Trimite update").
    const counts = itemsByOrder.get(o.id);
    if (counts && counts.total > counts.sent) return 'unsent';
    return 'sent';
  }
  // Draft / open: an empty draft is not 'unsent' yet — only flag galben
  // when there are at least some items that haven't been pushed to the
  // kitchen. An empty draft shows as 'open' (violet) so the operator
  // knows the table is taken but nothing's been cooked yet.
  const counts = itemsByOrder.get(o.id);
  if (counts && counts.total > 0 && counts.total > counts.sent) return 'unsent';
  return 'open';
}

function TablesPane({ onPickTable, onPickNewOrder, activeOrder, totals }: TablesPaneProps) {
  const tables = useCatalog((s) => s.tables);
  const hydrated = useCatalog((s) => s.hydrated);
  const remoteOrders = useRemote((s) => s.orders);
  const remoteItems = useRemote((s) => s.items);

  // Map tableId → the remote order on it (if any). Backend ships only
  // open orders so we don't need an is_open filter here.
  const remoteByTable = useMemo(() => {
    const m = new Map<string, RemoteOrderRow>();
    for (const o of remoteOrders) {
      if (o.table_id) m.set(o.table_id, o);
    }
    return m;
  }, [remoteOrders]);

  // Sprint 12 — aggregate non-void items per remote order so the table
  // dot can distinguish "empty draft" (open, violet) from "draft with
  // items waiting to be sent" (unsent, amber). Without this every newly
  // created remote draft showed up amber even when it had zero items.
  const itemsByOrder = useMemo(() => {
    const m = new Map<string, { sent: number; total: number }>();
    for (const it of remoteItems) {
      if (it.status === 'void') continue;
      const cur = m.get(it.order_id) ?? { sent: 0, total: 0 };
      cur.total += 1;
      if (it.kitchen_ticket_id || it.sent_at) cur.sent += 1;
      m.set(it.order_id, cur);
    }
    return m;
  }, [remoteItems]);

  // Sprint 9 — count non-table open orders by source so the operator
  // can see at a glance how many walk-ins / deliveries are running.
  const nonTableCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of remoteOrders) {
      if (!o.table_id) {
        const k = o.source ?? 'pos';
        counts[k] = (counts[k] ?? 0) + 1;
      }
    }
    return counts;
  }, [remoteOrders]);

  return (
    <aside className="flex w-72 bg-slate-950/60 backdrop-blur border-r border-white/10 flex-col">
      <header className="px-4 py-3.5 border-b border-white/10">
        <h2 className="font-semibold text-white text-sm flex items-center gap-2">
          <Users className="h-4 w-4 text-violet-400" /> Mese
        </h2>
        <p className="text-[11px] text-slate-400 mt-0.5">
          {tables.length > 0
            ? `${tables.length} mese${remoteOrders.length > 0 ? ` · ${remoteOrders.length} deschise` : ''}`
            : hydrated
              ? 'Niciun rând în catalog'
              : 'Se încarcă…'}
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        {tables.length === 0 ? (
          <TablesEmptyState hydrated={hydrated} />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {tables.map((t) => {
              const isLocallyActive = activeOrder?.tableId === t.id;
              const remote = remoteByTable.get(t.id);
              // Local order wins if we own this table right now; the
              // backend snapshot may be a few seconds stale.
              if (isLocallyActive) {
                return (
                  <TableButton
                    key={t.id}
                    t={t}
                    status={statusForActive(activeOrder!, totals)}
                    totalCents={totals.totalCents}
                    openedAtIso={activeOrder!.openedAt}
                    isForeign={false}
                    onPick={() => onPickTable(t.id)}
                  />
                );
              }
              if (remote) {
                return (
                  <TableButton
                    key={t.id}
                    t={t}
                    status={statusForRemote(remote, itemsByOrder)}
                    totalCents={remote.total_cents}
                    openedAtIso={remote.opened_at}
                    isForeign={!remote.current_device_can_edit}
                    onPick={() => onPickTable(t.id)}
                  />
                );
              }
              return (
                <TableButton
                  key={t.id}
                  t={t}
                  status="empty"
                  totalCents={null}
                  openedAtIso={null}
                  isForeign={false}
                  onPick={() => onPickTable(t.id)}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-white/10 bg-slate-950/80 backdrop-blur space-y-2">
        {Object.keys(nonTableCounts).length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1">
            {Object.entries(nonTableCounts).map(([source, n]) => (
              <span
                key={source}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30"
                title={`${n} comandă deschisă pe sursă "${source}"`}
              >
                {source} · {n}
              </span>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={onPickNewOrder}
          className="touch-target w-full py-3 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-semibold text-sm shadow-lg shadow-violet-900/40 hover:from-violet-500 hover:to-indigo-500 inline-flex items-center justify-center gap-2 transition"
        >
          <Plus className="h-4 w-4" /> Comandă nouă
        </button>
      </div>
    </aside>
  );
}

function formatElapsed(openedAtIso: string): string {
  const now = Date.now();
  const opened = Date.parse(openedAtIso);
  if (Number.isNaN(opened) || now < opened) return '—';
  const diffSec = Math.floor((now - opened) / 1000);
  const m = Math.floor(diffSec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${diffSec}s`;
}

interface TableButtonProps {
  t: TableRow;
  status: TableSlotStatus;
  totalCents: number | null;
  openedAtIso: string | null;
  isForeign: boolean;
  onPick: () => void;
}

function TableButton({ t, status, totalCents, openedAtIso, isForeign, onPick }: TableButtonProps) {
  const pill = STATUS_PILL[status];
  return (
    <button
      type="button"
      onClick={onPick}
      className={`touch-target relative aspect-[4/3] rounded-xl border bg-white/[0.04] backdrop-blur-sm hover:border-violet-400/60 hover:bg-white/[0.08] transition-all flex flex-col items-center justify-center text-center ${
        status === 'unsent' || status === 'partial'
          ? 'border-amber-400/40'
          : status === 'sent'
            ? 'border-emerald-400/40'
            : 'border-white/10'
      }`}
      title={
        isForeign
          ? 'Comandă deschisă pe alt dispozitiv — read-only până la deschiderea aici.'
          : undefined
      }
    >
      <span className={`absolute top-2 right-2 h-2 w-2 rounded-full ${STATUS_DOT[status]}`} />
      {isForeign && (
        <Lock className="absolute top-2 left-2 h-3 w-3 text-slate-400" />
      )}
      <span className="text-lg font-bold text-white leading-none">{t.table_number}</span>
      {t.capacity != null && (
        <span className="text-[10px] text-slate-400 mt-1">{t.capacity} loc.</span>
      )}
      <span className={`text-[10px] mt-1 ${pill.className}`}>{pill.label}</span>
      {totalCents != null && totalCents > 0 && (
        <span className="text-[10px] mt-0.5 font-semibold text-violet-200 tabular-nums">
          {formatMoney(totalCents)}
        </span>
      )}
      {openedAtIso && (
        <span className="text-[9px] mt-0.5 text-slate-500 tabular-nums">
          {formatElapsed(openedAtIso)}
        </span>
      )}
    </button>
  );
}

/* ─── Center pane: menu ──────────────────────────────────────────────────── */

const ALL_CATEGORIES_ID = '__all__';

function MenuPane({ onPickProduct }: { onPickProduct: (p: ProductRow) => void }) {
  const categories = useCatalog((s) => s.categories);
  const products = useCatalog((s) => s.products);
  const hydrated = useCatalog((s) => s.hydrated);
  const [activeCategoryId, setActiveCategoryId] = useState<string>(ALL_CATEGORIES_ID);

  const visibleProducts = useMemo(() => {
    if (activeCategoryId === ALL_CATEGORIES_ID) return products;
    return products.filter((p) => p.category_id === activeCategoryId);
  }, [products, activeCategoryId]);

  const tabs: Array<{ id: string; name: string }> = [
    { id: ALL_CATEGORIES_ID, name: 'Toate' },
    ...categories.map((c) => ({ id: c.id, name: c.name })),
  ];

  return (
    <section className="flex flex-1 flex-col">
      <header className="px-5 py-3.5 border-b border-white/10 bg-slate-950/40 backdrop-blur flex items-center gap-2 overflow-x-auto">
        <Utensils className="h-4 w-4 text-violet-400 flex-shrink-0" />
        {tabs.map((tab) => {
          const active = tab.id === activeCategoryId;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveCategoryId(tab.id)}
              className={`touch-target flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition ${
                active
                  ? 'bg-violet-600 text-white shadow-lg shadow-violet-900/40'
                  : 'bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] hover:text-white border border-white/10'
              }`}
            >
              {tab.name}
            </button>
          );
        })}
      </header>

      {visibleProducts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-10">
          <EmptyHint
            label={hydrated ? 'Niciun produs în această categorie' : 'Se încarcă…'}
            sub={hydrated && products.length === 0 ? 'Verifică /api/pos/bootstrap.' : null}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 auto-rows-max">
          {visibleProducts.map((p) => (
            <ProductCard key={p.id} p={p} onPick={() => onPickProduct(p)} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProductCard({ p, onPick }: { p: ProductRow; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="touch-target group relative text-left p-4 bg-white/[0.04] backdrop-blur-sm rounded-2xl border border-white/10 hover:border-violet-400/60 hover:bg-white/[0.08] hover:shadow-xl hover:shadow-violet-900/30 hover:-translate-y-0.5 transition-all duration-200 min-h-[140px] flex flex-col"
    >
      <div className="absolute top-3 right-3 h-8 w-8 rounded-full bg-violet-500/20 text-violet-300 flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
        <Plus className="h-4 w-4" />
      </div>
      <div className="font-semibold text-white text-base leading-snug mb-2 line-clamp-2 pr-10">
        {p.name}
      </div>
      <div className="mt-auto flex items-end justify-between">
        <div className="text-xl font-bold bg-gradient-to-r from-violet-300 to-indigo-300 bg-clip-text text-transparent">
          {(p.price_cents / 100).toFixed(2)}
          <span className="text-xs font-medium text-slate-400 ml-1">RON</span>
        </div>
      </div>
    </button>
  );
}

function EmptyHint({ label, sub }: { label: string; sub?: string | null }) {
  return (
    <div className="flex flex-col items-center justify-center text-center text-slate-400 text-sm gap-2">
      <Utensils className="h-8 w-8 text-slate-600" />
      <p>{label}</p>
      {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

/**
 * Self-diagnosing empty state for the tables grid. Surfaces the same
 * counts the Diagnostics modal would, plus a Refresh button that
 * re-fires runBootstrap with the currently-selected restaurant id.
 *
 * The user-reported "I see no tables" symptom can come from many
 * places (engine started without restaurantId, backend has 0 tables
 * for the resolved restaurant, hydrate failed, etc.). Showing the
 * counts inline lets a tester self-triage without opening Diagnostics.
 */
function TablesEmptyState({ hydrated }: { hydrated: boolean }) {
  const auth = useAuthStore();
  const [refreshing, setRefreshing] = useState(false);
  const [bootstrapRev, setBootstrapRev] = useState(0);
  const last = readLastBootstrap();
  const lastSentRestaurantId = readLastBootstrapRestaurantId();

  async function refresh() {
    if (refreshing) return;
    const engine = getSyncEngine();
    if (!engine) return;
    setRefreshing(true);
    try {
      const r = await runBootstrap({
        exec: engine.exec,
        restaurantId: auth.selectedRestaurant?.id ?? null,
      });
      rememberBootstrap(r, auth.selectedRestaurant?.id ?? null);
      if (r.ok) {
        await useCatalog.getState().refreshFromDb(engine.exec);
      }
      setBootstrapRev((n) => n + 1);
    } finally {
      setRefreshing(false);
    }
  }
  void bootstrapRev; // touch so eslint doesn't flag setBootstrapRev unused

  let bootstrapLine: string;
  if (!last) {
    bootstrapLine = hydrated ? 'Bootstrap nu a rulat încă.' : 'Se încarcă...';
  } else if (!last.ok) {
    bootstrapLine = `Bootstrap a eșuat: ${String(last.error).slice(0, 100)}`;
  } else {
    const b = last.bootstrap;
    bootstrapLine = `Bootstrap OK · ${b.tables.length} mese · ${b.products.length} produse · ${b.categories.length} categorii.`;
  }

  return (
    <div className="flex flex-col items-stretch gap-3 text-sm text-slate-400">
      <div className="flex flex-col items-center gap-2 text-center">
        <Utensils className="h-7 w-7 text-slate-600" />
        <p>{hydrated ? 'Niciun rând în catalog local.' : 'Se încarcă…'}</p>
      </div>
      <div className="rounded-lg border border-white/5 bg-slate-950/60 p-2 text-[11px] leading-relaxed">
        <p className="text-slate-300">
          <span className="text-slate-500">Restaurant:</span>{' '}
          {auth.selectedRestaurant?.name ?? '—'}
        </p>
        <p className="truncate text-slate-500">
          <span>Trimis bootstrap pentru:</span>{' '}
          {lastSentRestaurantId ? (
            <span title={lastSentRestaurantId}>
              {lastSentRestaurantId.slice(0, 8)}…
            </span>
          ) : (
            '—'
          )}
        </p>
        <p className="mt-1 text-slate-300">{bootstrapLine}</p>
        {last?.ok && last.bootstrap.restaurant ? (
          <p className="text-slate-500">
            Backend: {last.bootstrap.restaurant.name}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={refresh}
        disabled={refreshing}
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-white/[0.08] disabled:opacity-60"
      >
        {refreshing ? 'Reîncarc…' : 'Reîncarcă bootstrap'}
      </button>
    </div>
  );
}

/* ─── Right pane: order ticket ───────────────────────────────────────────── */

interface CartPaneProps {
  order: Order | null;
  totals: OrderTotals;
  onCash: () => void;
  onClear: () => void;
  onIncrement: (itemId: string) => void;
  onDecrement: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  onSendToKitchen: () => void;
  onCancel: () => void;
}

function CartPane({
  order,
  totals,
  onCash,
  onClear,
  onIncrement,
  onDecrement,
  onRemove,
  onSendToKitchen,
  onCancel,
}: CartPaneProps) {
  // Show the *blended* effective rate so the label stays accurate when the
  // order mixes food (9%) and bar (19%) lines.
  const effectiveRatePct = (() => {
    if (totals.vatCents === 0) return rateToFloat(ROMANIAN_DEFAULT_VAT_BP) * 100;
    const net = Math.max(1, totals.totalCents - totals.vatCents);
    return (totals.vatCents / net) * 100;
  })();
  const activeItems = order?.items.filter((it) => !it.voidedAt) ?? [];
  const unsentCount = activeItems.filter((it) => !it.sentAt).length;
  const sentCount = activeItems.length - unsentCount;
  const canPay = order != null && totals.totalCents > 0 && order.state !== 'paid' && order.state !== 'cancelled';
  // Three Trimite states matching POSPage.tsx:
  //   draft / open + unsent items     → violet "Trimite"
  //   sent + new items added after    → amber "Trimite update (N)"
  //   sent + nothing new              → locked "Trimis"
  const sendKind: 'send' | 'update' | 'locked' | 'disabled' =
    order == null
      ? 'disabled'
      : unsentCount === 0
        ? sentCount > 0
          ? 'locked'
          : 'disabled'
        : sentCount === 0
          ? 'send'
          : 'update';

  return (
    <aside className="flex w-80 bg-slate-950/60 backdrop-blur border-l border-white/10 flex-col">
      <header className="px-4 py-3.5 border-b border-white/10 flex items-center justify-between">
        <h2 className="font-semibold text-white text-sm flex items-center gap-2">
          <Receipt className="h-4 w-4 text-violet-400" /> Comandă
        </h2>
        {order ? (
          <button
            type="button"
            onClick={onClear}
            className="text-[10px] uppercase tracking-wider px-2 py-1 rounded font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25"
            title="Începe o comandă nouă"
          >
            {order.state}
          </button>
        ) : (
          <span className="text-[10px] uppercase tracking-wider px-2 py-1 rounded font-semibold bg-slate-500/15 text-slate-300 border border-slate-400/30">
            niciuna
          </span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
        {activeItems.map((it) => (
          <CartItemRow
            key={it.id}
            name={it.productName}
            quantity={it.quantity}
            unitPriceCents={it.unitPriceCents}
            lineTotalCents={it.lineTotalCents}
            isSent={it.sentAt != null}
            onIncrement={() => onIncrement(it.id)}
            onDecrement={() => onDecrement(it.id)}
            onRemove={() => onRemove(it.id)}
          />
        ))}
        {activeItems.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-slate-400 text-sm gap-3">
            <Receipt className="h-10 w-10 text-slate-600" />
            <p>{order ? 'Adaugă produse din meniu.' : 'Apasă o masă sau "Comandă nouă".'}</p>
          </div>
        )}
      </div>

      <div className="border-t border-white/10 p-3 space-y-2 bg-slate-950/80 backdrop-blur">
        <Row label="Subtotal" value={formatMoney(totals.subtotalCents)} />
        {totals.discountCents > 0 && (
          <Row label="Discount" value={`− ${formatMoney(totals.discountCents)}`} accent="emerald" />
        )}
        {totals.tipCents > 0 && (
          <Row label="Bacșiș" value={formatMoney(totals.tipCents)} accent="amber" />
        )}
        <Row
          label={`TVA (${effectiveRatePct.toFixed(0)}% efectiv)`}
          value={formatMoney(totals.vatCents)}
          muted
        />
        <Row label="Total" value={formatMoney(totals.totalCents)} big />
        {totals.paidCents > 0 && (
          <Row label="Plătit" value={formatMoney(totals.paidCents)} accent="emerald" />
        )}
        <div className="grid grid-cols-2 gap-2 pt-2">
          <SendButton kind={sendKind} count={unsentCount} onClick={onSendToKitchen} />
          <button
            type="button"
            disabled={!canPay}
            onClick={onCash}
            className="touch-target rounded-xl py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 bg-emerald-600/40 text-emerald-200 border border-emerald-400/20 hover:bg-emerald-600/60 disabled:opacity-50"
          >
            <Banknote className="h-4 w-4" /> Cash
          </button>
        </div>
        <button
          type="button"
          disabled
          className="touch-target w-full rounded-xl py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 bg-indigo-600/40 text-indigo-200 border border-indigo-400/20 disabled:opacity-50"
        >
          <CreditCard className="h-4 w-4" /> Card POS
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={
            order == null
            || order.state === 'paid'
            || order.state === 'cancelled'
            || order.state === 'closed'
          }
          className="touch-target w-full rounded-xl py-2.5 text-xs font-semibold inline-flex items-center justify-center gap-2 bg-rose-600/20 text-rose-200 border border-rose-400/30 hover:bg-rose-600/40 disabled:opacity-40"
          title="Anulează comanda — eliberează masa"
        >
          <Trash2 className="h-3.5 w-3.5" /> Anulează
        </button>
      </div>
    </aside>
  );
}

function Row({
  label,
  value,
  muted = false,
  big = false,
  accent,
}: {
  label: string;
  value: string;
  muted?: boolean;
  big?: boolean;
  accent?: 'emerald' | 'amber';
}) {
  const valueClass = big
    ? 'text-lg font-bold text-white'
    : accent === 'emerald'
      ? 'text-sm font-semibold text-emerald-300'
      : accent === 'amber'
        ? 'text-sm font-semibold text-amber-300'
        : 'text-sm font-semibold text-slate-200';
  return (
    <div className="flex items-center justify-between">
      <span className={`text-sm ${muted ? 'text-slate-400' : 'text-slate-200'}`}>{label}</span>
      <span className={`tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

interface CartItemRowProps {
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  isSent: boolean;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
}

function CartItemRow({
  name,
  quantity,
  unitPriceCents,
  lineTotalCents,
  isSent,
  onIncrement,
  onDecrement,
  onRemove,
}: CartItemRowProps) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-white truncate flex items-center gap-1.5">
            {name}
            {isSent && (
              <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-400/30">
                trimis
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-400">
            {formatMoney(unitPriceCents)} / buc
          </div>
        </div>
        <div className="text-sm font-semibold text-violet-200 tabular-nums ml-3">
          {formatMoney(lineTotalCents)}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center border border-white/10 bg-slate-900/60 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={onDecrement}
            className="touch-target px-2 py-1 text-slate-300 hover:bg-white/5 disabled:opacity-40"
            aria-label="Scade cantitatea"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="px-3 text-sm font-semibold text-white tabular-nums">
            {quantity}
          </span>
          <button
            type="button"
            onClick={onIncrement}
            className="touch-target px-2 py-1 text-slate-300 hover:bg-white/5"
            aria-label="Crește cantitatea"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="touch-target p-1.5 rounded-lg text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
          aria-label="Șterge produsul"
          title={isSent ? 'Anulează acest item (trimis la bucătărie)' : 'Șterge din comandă'}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

interface SendButtonProps {
  kind: 'send' | 'update' | 'locked' | 'disabled';
  count: number;
  onClick: () => void;
}

function SendButton({ kind, count, onClick }: SendButtonProps) {
  if (kind === 'locked') {
    return (
      <button
        type="button"
        disabled
        className="touch-target rounded-xl py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 bg-emerald-600/15 text-emerald-300/70 border border-emerald-400/30 disabled:opacity-90"
      >
        <Lock className="h-4 w-4" /> Trimis
      </button>
    );
  }
  if (kind === 'update') {
    return (
      <button
        type="button"
        onClick={onClick}
        className="touch-target rounded-xl py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 bg-amber-500/20 text-amber-200 border border-amber-400/40 hover:bg-amber-500/30"
      >
        <Send className="h-4 w-4" /> Trimite update ({count})
      </button>
    );
  }
  // 'send' or 'disabled'
  const disabled = kind === 'disabled';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`touch-target rounded-xl py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 ${
        disabled
          ? 'bg-violet-600/40 text-violet-200 border border-violet-400/20 opacity-50'
          : 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-900/40 hover:from-violet-500 hover:to-indigo-500 border border-violet-400/40'
      }`}
    >
      <Send className="h-4 w-4" /> Trimite
    </button>
  );
}
