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
  cancelOrder,
  createOrder,
  registerCardPaymentResult,
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
import { loadOrderFromRemote } from '@/lib/sync/resumeOrder';
import { getSyncEngine } from '@/lib/sync/bootstrap';
import { restaurantOrdersApi, openTableViaRest, RestaurantOrderApiError } from '@/lib/api/restaurantOrders';
import { restaurantOrderToOrder } from '@/lib/api/restaurantOrderMapper';
import { logger } from '@/lib/logger';

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
      // Online + table tap → mirror browser POS: server is the source of
      // truth for "is there already a draft on this table". The 409
      // conflict path inside openTableViaRest re-fetches the existing
      // draft, so we never spawn a duplicate RestaurantOrder. Walk-in /
      // tableless drafts go straight to create().
      if (ctx.online) {
        try {
          const remote = tableId
            ? await openTableViaRest(tableId)
            : await restaurantOrdersApi.create({ source: 'pos', tableId: null });
          const next = restaurantOrderToOrder(remote, ctx.deviceId);
          setOrder(next);
          logger.info('pos.order', 'newOrder via REST', {
            orderId: remote.id,
            tableId,
            existing: remote.items.length > 0,
          });
          return next;
        } catch (err) {
          logger.error('pos.order', 'newOrder REST failed, falling back to local', {
            err: String(err),
          });
        }
      }
      const r = await runAction(() =>
        createOrder({ tableId, vatConfig: vatConfigDefault() }, ctx),
      );
      setOrder(r.next);
      return r.next;
    },
    [setOrder],
  );

  /**
   * Sprint 11.8 — mirror the browser POS pattern (selectOrStartOnTable):
   * if the table already has an open remote order, load it into the
   * cart instead of creating a new draft. The resumed order keeps the
   * server id, so any subsequent addItem / sendToKitchen events go
   * against the existing RestaurantOrder server-side, not a duplicate.
   */
  const resumeOrder = useCallback(
    async (orderId: string) => {
      const ctx = buildCtx();
      // Prefer the server snapshot when online so the cart shows the
      // canonical state (matches the browser POS behaviour).
      if (ctx.online) {
        try {
          const remote = await restaurantOrdersApi.get(orderId);
          const next = restaurantOrderToOrder(remote, ctx.deviceId);
          setOrder(next);
          logger.info('pos.order', 'resumed via REST', { orderId, items: remote.items.length });
          return next;
        } catch (err) {
          logger.warn('pos.order', 'REST resume failed, falling back to local', { err: String(err) });
        }
      }
      const engine = getSyncEngine();
      if (!engine) return null;
      const loaded = await loadOrderFromRemote(engine.exec, orderId);
      if (loaded) setOrder(loaded);
      return loaded;
    },
    [setOrder],
  );

  // Sprint 9 — non-table intake with customer fields.
  const newOrderWithCustomer = useCallback(
    async (
      source: 'walkin' | 'home_delivery',
      customer: {
        customerName?: string;
        customerPhone?: string;
        customerAddress?: string;
        notes?: string;
      },
    ) => {
      const ctx = buildCtx();
      const r = await runAction(() =>
        createOrder(
          { tableId: null, source, vatConfig: vatConfigDefault(), ...customer },
          ctx,
        ),
      );
      setOrder(r.next);
      return r.next;
    },
    [setOrder],
  );

  const addProduct = useCallback(
    async (p: ProductRow) => {
      const ctx = buildCtx();
      const station = stationFor(p.category_id);

      // Sprint 12 (REST direct) — when the desktop is online we hit the
      // same /api/restaurant/orders endpoints the browser POS uses. The
      // event-sourced pos-core path stays as the offline fallback below.
      if (ctx.online) {
        try {
          let serverId = order?.serverId ?? null;
          if (!serverId) {
            // No server-side draft yet → create one. Mirrors the browser
            // pattern (selectOrStartOnTable). The 409 conflict on a busy
            // table is handled inside openTableViaRest by re-fetching.
            const created = order?.tableId
              ? await openTableViaRest(order.tableId)
              : await restaurantOrdersApi.create({ source: 'pos', tableId: null });
            serverId = created.id;
            logger.info('pos.order', 'created server draft for add-product', {
              orderId: serverId,
              tableId: order?.tableId ?? null,
            });
          }
          const updated = await restaurantOrdersApi.addItem(serverId, {
            menuItemId: p.id,
            quantity: 1,
          });
          setOrder(restaurantOrderToOrder(updated, ctx.deviceId));
          logger.info('pos.order', 'item added via REST', {
            orderId: serverId,
            productId: p.id,
            productName: p.name,
            items: updated.items.length,
          });
          return;
        } catch (err) {
          const apiErr = err instanceof RestaurantOrderApiError ? err : null;
          logger.error('pos.order', 'addItem REST failed', {
            err: apiErr?.message ?? String(err),
            status: apiErr?.status ?? null,
            detail: apiErr?.detail ?? null,
          });
          // Re-throw so the UI panel can show a toast / alert.
          throw err;
        }
      }

      // Offline fallback: original event-sourced flow.
      const current = order ?? (await newOrder(null));
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
      logger.info('pos.order', 'item added via local event (offline)', {
        productId: p.id,
        productName: p.name,
      });
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
      if (ctx.online && order.serverId) {
        try {
          const updated = await restaurantOrdersApi.updateItem(order.serverId, itemId, {
            quantity: item.quantity + 1,
          });
          setOrder(restaurantOrderToOrder(updated, ctx.deviceId));
          logger.info('pos.order', 'qty++ via REST', { orderId: order.serverId, itemId });
          return;
        } catch (err) {
          logger.error('pos.order', 'updateItem REST failed', { err: String(err) });
          throw err;
        }
      }
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
      if (ctx.online && order.serverId) {
        try {
          if (item.quantity <= 1) {
            const updated = await restaurantOrdersApi.removeItem(order.serverId, itemId);
            setOrder(restaurantOrderToOrder(updated, ctx.deviceId));
            logger.info('pos.order', 'item voided via REST (qty=0)', { orderId: order.serverId, itemId });
          } else {
            const updated = await restaurantOrdersApi.updateItem(order.serverId, itemId, {
              quantity: item.quantity - 1,
            });
            setOrder(restaurantOrderToOrder(updated, ctx.deviceId));
            logger.info('pos.order', 'qty-- via REST', { orderId: order.serverId, itemId });
          }
          return;
        } catch (err) {
          logger.error('pos.order', 'decrement REST failed', { err: String(err) });
          throw err;
        }
      }
      // Offline fallback.
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
      if (ctx.online && order.serverId) {
        try {
          const updated = await restaurantOrdersApi.removeItem(order.serverId, itemId);
          setOrder(restaurantOrderToOrder(updated, ctx.deviceId));
          logger.info('pos.order', 'item removed via REST', {
            orderId: order.serverId,
            itemId,
            reason,
          });
          return;
        } catch (err) {
          logger.error('pos.order', 'removeItem REST failed', { err: String(err) });
          throw err;
        }
      }
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
    if (ctx.online && order.serverId) {
      try {
        const updated = await restaurantOrdersApi.sendToKitchen(order.serverId);
        setOrder(restaurantOrderToOrder(updated, ctx.deviceId));
        logger.info('pos.order', 'sent to kitchen via REST', {
          orderId: order.serverId,
          tickets: updated.kitchenTickets.length,
        });
        return;
      } catch (err) {
        logger.error('pos.order', 'sendToKitchen REST failed', { err: String(err) });
        throw err;
      }
    }
    const r = await runAction(() => sendToKitchen(order, {}, ctx));
    setOrder(r.next);
  }, [order, setOrder]);

  // Sprint 11.9 — mirror browser POS cancelOrder. The pos-core action
  // already enforces "not fiscalised" + state-machine guard; the
  // backend forwarder marks RestaurantOrder cancelled so the table
  // frees up. We clear the cart locally on success so the operator
  // lands back on the empty Tables view (same UX as web POS where
  // setActiveOrderId(null) runs after cancel).
  const cancelCurrentOrder = useCallback(
    async (reason: string = 'anulat din POS') => {
      if (!order) return;
      const ctx = buildCtx();
      if (ctx.online && order.serverId) {
        try {
          await restaurantOrdersApi.cancel(order.serverId, reason);
          logger.info('pos.order', 'cancelled via REST', { orderId: order.serverId, reason });
          clear();
          return;
        } catch (err) {
          logger.error('pos.order', 'cancel REST failed', { err: String(err) });
          throw err;
        }
      }
      try {
        await runAction(() => cancelOrder(order, { reason }, ctx));
        clear();
      } catch (err) {
        throw err;
      }
    },
    [order, clear],
  );

  // Sprint 7 — explicit cash with arbitrary amount (modal-driven).
  const payCashAmount = useCallback(
    async (amountCents: number, acceptOverTender = false) => {
      if (!order) return;
      const ctx = buildCtx();
      const r = await runAction(() =>
        registerCashPayment(order, { amountCents, acceptOverTender }, ctx),
      );
      setOrder(r.next);
    },
    [order, setOrder],
  );

  // Sprint 7 — card outcome from the simulator/two-step modal.
  const recordCardOutcome = useCallback(
    async (
      amountCents: number,
      status: 'approved' | 'declined' | 'cancelled' | 'unknown',
      terminal: { authCode?: string; rrn?: string; trace?: string } = {},
    ) => {
      if (!order) return;
      const ctx = buildCtx();
      const r = await runAction(() =>
        registerCardPaymentResult(
          order,
          {
            amountCents,
            status,
            terminalAuthCode: terminal.authCode,
            terminalRrn: terminal.rrn,
            terminalTrace: terminal.trace,
          },
          ctx,
        ),
      );
      setOrder(r.next);
    },
    [order, setOrder],
  );

  return {
    order,
    newOrder,
    newOrderWithCustomer,
    resumeOrder,
    addProduct,
    payCash,
    payCashAmount,
    recordCardOutcome,
    incrementQuantity,
    decrementQuantity,
    removeItem,
    sendOrderToKitchen,
    cancelCurrentOrder,
    clear,
  };
}
