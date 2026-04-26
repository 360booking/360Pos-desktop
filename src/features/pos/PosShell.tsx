import { useMemo, useState } from 'react';
import { Plus, Users, Utensils, Receipt, Send, CreditCard, Banknote } from 'lucide-react';
import { StatusBar } from './StatusBar';
import { useCatalogBootstrap } from './useCatalogBootstrap';
import { useCatalog } from '@/store/catalog';
import type { ProductRow, TableRow } from '@/lib/db/catalogQueries';
import {
  addItem,
  computeTotals,
  createOrder,
  formatMoney,
  rateToFloat,
  ROMANIAN_DEFAULT_VAT_BP,
  type ActionCtx,
  type Order,
  type OrderTotals,
  type TenantVatConfig,
} from '@/core/pos-core';

/**
 * Three-pane POS shell. Class strings match POSPage.tsx so the visual
 * footprint is identical. Sprint 4 / 2 wires the menu + tables panes to
 * the local SQLite catalogue (kept fresh by the bootstrap scheduler);
 * the cart still uses a demo order until Sprint 4 / 3 ports it.
 */
export function PosShell() {
  useCatalogBootstrap();
  const { order, totals } = useDemoOrder();
  return (
    <div className="flex flex-col h-screen bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-950 text-slate-100">
      <StatusBar />
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <TablesPane />
        <MenuPane />
        <CartPane order={order} totals={totals} />
      </div>
    </div>
  );
}

/* ─── Demo order powered by pos-core (Sprint 1) ──────────────────────────── */

const DEMO_VAT: TenantVatConfig = {
  defaultRateBp: ROMANIAN_DEFAULT_VAT_BP,
  foodRateBp: 900,
  barRateBp: 1900,
};

function useDemoOrder(): { order: Order; totals: OrderTotals } {
  return useMemo(() => {
    let counter = 0;
    const ctx: ActionCtx = {
      clock: { nowIso: () => new Date().toISOString() },
      ids: {
        newId: () => `demo-${++counter}`,
        newMutationId: () => `demo-mut-${++counter}`,
      },
      deviceId: 'pos-desktop-demo',
      online: true,
    };
    let order = createOrder({ tableId: 't-demo', vatConfig: DEMO_VAT }, ctx).next;
    order = addItem(
      order,
      { productId: null, productName: 'Salată Caesar', quantity: 1, unitPriceCents: 2800, categoryType: 'restaurant' },
      ctx,
    ).next;
    order = addItem(
      order,
      { productId: null, productName: 'Coca-Cola 0.33L', quantity: 2, unitPriceCents: 900, categoryType: 'bar' },
      ctx,
    ).next;
    return { order, totals: computeTotals(order) };
  }, []);
}

/* ─── Left pane: tables ──────────────────────────────────────────────────── */

function TablesPane() {
  const tables = useCatalog((s) => s.tables);
  const hydrated = useCatalog((s) => s.hydrated);

  return (
    <aside className="flex w-72 bg-slate-950/60 backdrop-blur border-r border-white/10 flex-col">
      <header className="px-4 py-3.5 border-b border-white/10">
        <h2 className="font-semibold text-white text-sm flex items-center gap-2">
          <Users className="h-4 w-4 text-violet-400" /> Mese
        </h2>
        <p className="text-[11px] text-slate-400 mt-0.5">
          {tables.length > 0
            ? `${tables.length} mese`
            : hydrated
              ? 'Niciun rând în catalog'
              : 'Se încarcă…'}
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        {tables.length === 0 ? (
          <EmptyHint
            label={hydrated ? 'Niciun rând în catalog' : 'Se încarcă…'}
            sub={hydrated ? 'Verifică /api/pos/bootstrap.' : null}
          />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {tables.map((t) => (
              <TableButton key={t.id} t={t} />
            ))}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-white/10 bg-slate-950/80 backdrop-blur space-y-2">
        <button
          type="button"
          className="touch-target w-full py-3 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-semibold text-sm shadow-lg shadow-violet-900/40 hover:from-violet-500 hover:to-indigo-500 inline-flex items-center justify-center gap-2 transition"
        >
          <Plus className="h-4 w-4" /> Comandă nouă
        </button>
      </div>
    </aside>
  );
}

function TableButton({ t }: { t: TableRow }) {
  // No occupied state in the local catalogue yet — Sprint 5 brings the
  // open-tabs sync in. For now every table renders as available.
  return (
    <button
      type="button"
      className="touch-target relative aspect-[4/3] rounded-xl border border-white/10 bg-white/[0.04] backdrop-blur-sm hover:border-violet-400/60 hover:bg-white/[0.08] transition-all flex flex-col items-center justify-center text-center"
    >
      <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-emerald-400" />
      <span className="text-lg font-bold text-white leading-none">{t.table_number}</span>
      {t.capacity != null && (
        <span className="text-[10px] text-slate-400 mt-1">{t.capacity} loc.</span>
      )}
      <span className="text-[10px] mt-1 text-emerald-300">Liberă</span>
    </button>
  );
}

/* ─── Center pane: menu ──────────────────────────────────────────────────── */

const ALL_CATEGORIES_ID = '__all__';

function MenuPane() {
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
          {visibleProducts.map((p) => <ProductCard key={p.id} p={p} />)}
        </div>
      )}
    </section>
  );
}

function ProductCard({ p }: { p: ProductRow }) {
  return (
    <button
      type="button"
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

/* ─── Right pane: order ticket ───────────────────────────────────────────── */

function CartPane({ order, totals }: { order: Order; totals: OrderTotals }) {
  // Show the *blended* effective rate so the label stays accurate when the
  // order mixes food (9%) and bar (19%) lines.
  const effectiveRatePct = (() => {
    if (totals.vatCents === 0) return rateToFloat(ROMANIAN_DEFAULT_VAT_BP) * 100;
    const net = Math.max(1, totals.totalCents - totals.vatCents);
    return (totals.vatCents / net) * 100;
  })();
  const activeItems = order.items.filter((it) => !it.voidedAt);

  return (
    <aside className="flex w-80 bg-slate-950/60 backdrop-blur border-l border-white/10 flex-col">
      <header className="px-4 py-3.5 border-b border-white/10 flex items-center justify-between">
        <h2 className="font-semibold text-white text-sm flex items-center gap-2">
          <Receipt className="h-4 w-4 text-violet-400" /> Comandă
        </h2>
        <span className="text-[10px] uppercase tracking-wider px-2 py-1 rounded font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30">
          {order.state}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
        {activeItems.map((it) => (
          <div
            key={it.id}
            className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-white truncate">{it.productName}</div>
              <div className="text-[11px] text-slate-400">
                {it.quantity} × {formatMoney(it.unitPriceCents)}
              </div>
            </div>
            <div className="text-sm font-semibold text-violet-200 tabular-nums ml-3">
              {formatMoney(it.lineTotalCents)}
            </div>
          </div>
        ))}
        {activeItems.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-slate-400 text-sm gap-3">
            <Receipt className="h-10 w-10 text-slate-600" />
            <p>Selectează o masă pentru a începe.</p>
          </div>
        )}
      </div>

      <div className="border-t border-white/10 p-3 space-y-2 bg-slate-950/80 backdrop-blur">
        <Row label="Subtotal" value={formatMoney(totals.subtotalCents)} />
        <Row
          label={`TVA (${effectiveRatePct.toFixed(0)}% efectiv)`}
          value={formatMoney(totals.vatCents)}
          muted
        />
        <Row label="Total" value={formatMoney(totals.totalCents)} big />
        <div className="grid grid-cols-2 gap-2 pt-2">
          <button
            type="button"
            disabled
            className="touch-target rounded-xl py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 bg-violet-600/40 text-violet-200 border border-violet-400/20 disabled:opacity-50"
          >
            <Send className="h-4 w-4" /> Trimite
          </button>
          <button
            type="button"
            disabled
            className="touch-target rounded-xl py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 bg-emerald-600/40 text-emerald-200 border border-emerald-400/20 disabled:opacity-50"
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
      </div>
    </aside>
  );
}

function Row({
  label,
  value,
  muted = false,
  big = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
  big?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={`text-sm ${muted ? 'text-slate-400' : 'text-slate-200'}`}>{label}</span>
      <span
        className={`tabular-nums ${
          big ? 'text-lg font-bold text-white' : 'text-sm font-semibold text-slate-200'
        }`}
      >
        {value}
      </span>
    </div>
  );
}
