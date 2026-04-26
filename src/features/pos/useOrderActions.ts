/**
 * Hook that exposes the cart-mutating actions used by the panes.
 * Sprint 4 / 3.
 *
 * Each action runs the pure pos-core function, persists the produced
 * SyncEvents through the outbox, and pushes the new Order into the
 * `useCurrentOrder` zustand store. The UI never touches pos-core
 * directly — it goes through this hook.
 *
 * The current order has a single in-memory slot — if the operator clicks
 * a product without a draft existing yet, we transparently create one
 * (with a null tableId) so the friction stays at one click.
 */
import { useCallback, useMemo } from 'react';
import {
  addItem,
  createOrder,
  registerCashPayment,
  ROMANIAN_DEFAULT_VAT_BP,
  sendToKitchen,
  setItemQuantity,
  voidItem,
  type ActionCtx,
  type CategoryType,
  type TenantVatConfig,
} from '@/core/pos-core';
import { runAction } from '@/lib/sync/dispatch';
import { useCurrentOrder } from '@/store/currentOrder';
import { useCatalog } from '@/store/catalog';
import { getConfig } from '@/lib/config';
import type { ProductRow } from '@/lib/db/catalogQueries';

function vatConfigDefault(): TenantVatConfig {
  // Sprint 4 / 1 stores bootstrap.vatConfig in the SQLite settings row,
  // but we don't yet expose it through the catalog store. RO 19% is a
  // safe default; backend remains source of truth for fiscal totals.
  return { defaultRateBp: ROMANIAN_DEFAULT_VAT_BP };
}

function buildCtx(): ActionCtx {
  const cfg = getConfig();
  return {
    clock: { nowIso: () => new Date().toISOString() },
    ids: {
      newId: () => crypto.randomUUID(),
      newMutationId: () => crypto.randomUUID(),
    },
    deviceId: cfg.deviceId ?? 'unpaired',
    online: cfg.syncTransportMode === 'http',
  };
}

function categoryTypeForStation(station: string | null): CategoryType {
  if (station === 'bar') return 'bar';
  if (station === 'kitchen' || station === 'pizza') return 'restaurant';
  return 'other';
}

export function useOrderActions() {
  const order = useCurrentOrder((s) => s.order);
  const setOrder = useCurrentOrder((s) => s.setOrder);
  const clear = useCurrentOrder((s) => s.clear);
  const categories = useCatalog((s) => s.categories);

  const stationFor = useMemo(() => {
    const map = new Map<string, string | null>(
      categories.map((c) => [c.id, c.station]),
    );
    return (categoryId: string | null) =>
      categoryId == null ? null : (map.get(categoryId) ?? null);
  }, [categories]);

  const newOrder = useCallback(
    async (tableId: string | null = null) => {
      const ctx = buildCtx();
      const r = await runAction(() =>
        createOrder({ tableId, vatConfig: vatConfigDefault() }, ctx),
      );
      setOrder(r.next);
      return r.next;
    },
    [setOrder],
  );

  const addProduct = useCallback(
    async (p: ProductRow) => {
      const ctx = buildCtx();
      const current = order ?? (await newOrder(null));
      const station = stationFor(p.category_id);
      const r = await runAction(() =>
        addItem(
          current,
          {
            productId: p.id,
            productName: p.name,
            quantity: 1,
            unitPriceCents: p.price_cents,
            categoryType: categoryTypeForStation(station),
          },
          ctx,
        ),
      );
      setOrder(r.next);
    },
    [order, newOrder, setOrder, stationFor],
  );

  const payCash = useCallback(async () => {
    if (!order) return;
    const ctx = buildCtx();
    const r = await runAction(() =>
      registerCashPayment(
        order,
        { amountCents: order.totalCents, acceptOverTender: false },
        ctx,
      ),
    );
    setOrder(r.next);
  }, [order, setOrder]);

  const incrementQuantity = useCallback(
    async (itemId: string) => {
      if (!order) return;
      const item = order.items.find((it) => it.id === itemId);
      if (!item || item.voidedAt) return;
      const ctx = buildCtx();
      const r = await runAction(() =>
        setItemQuantity(order, { itemId, quantity: item.quantity + 1 }, ctx),
      );
      setOrder(r.next);
    },
    [order, setOrder],
  );

  const decrementQuantity = useCallback(
    async (itemId: string) => {
      if (!order) return;
      const item = order.items.find((it) => it.id === itemId);
      if (!item || item.voidedAt) return;
      const ctx = buildCtx();
      // qty=1 + decrement = void; otherwise just decrement.
      if (item.quantity <= 1) {
        const r = await runAction(() =>
          voidItem(order, { itemId, reason: 'qty zero' }, ctx),
        );
        setOrder(r.next);
      } else {
        const r = await runAction(() =>
          setItemQuantity(order, { itemId, quantity: item.quantity - 1 }, ctx),
        );
        setOrder(r.next);
      }
    },
    [order, setOrder],
  );

  const removeItem = useCallback(
    async (itemId: string, reason: string = 'removed by waiter') => {
      if (!order) return;
      const item = order.items.find((it) => it.id === itemId);
      if (!item || item.voidedAt) return;
      const ctx = buildCtx();
      const r = await runAction(() =>
        voidItem(order, { itemId, reason }, ctx),
      );
      setOrder(r.next);
    },
    [order, setOrder],
  );

  const sendOrderToKitchen = useCallback(async () => {
    if (!order) return;
    const ctx = buildCtx();
    const r = await runAction(() => sendToKitchen(order, {}, ctx));
    setOrder(r.next);
  }, [order, setOrder]);

  return {
    order,
    newOrder,
    addProduct,
    payCash,
    incrementQuantity,
    decrementQuantity,
    removeItem,
    sendOrderToKitchen,
    clear,
  };
}
