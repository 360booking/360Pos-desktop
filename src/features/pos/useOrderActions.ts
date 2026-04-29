/**
 * Cart-mutating actions used by the POS panes.
 *
 * Faza 2 — online-first refactor. The seven order-shape mutations
 * (newOrder, addProduct, increment/decrement/remove, sendToKitchen,
 * cancel) require a reachable backend; if we're offline or the REST
 * call drops, we throw `OfflineMutationError` and let the UI render a
 * read-only state. We no longer fall through to the local pos-core
 * event-sourced path for these actions — desktop and browser POS now
 * have the same online contract.
 *
 * What stays event-sourced for now: walk-in/delivery creation
 * (`newOrderWithCustomer` — server still has draft-create gaps for
 * non-table sources), card payment outcomes (terminal-driven flow),
 * and the legacy `payCash` no-arg helper. Cash-with-amount goes through
 * the Faza 2 cash-offline path implemented in PaymentModal.
 */
import { useCallback, useMemo } from 'react';
import {
  createOrder,
  registerCardPaymentResult,
  registerCashPayment,
  ROMANIAN_DEFAULT_VAT_BP,
  type ActionCtx,
  type TenantVatConfig,
} from '@/core/pos-core';
import { runAction } from '@/lib/sync/dispatch';
import { useCurrentOrder } from '@/store/currentOrder';
import { useCatalog } from '@/store/catalog';
import { getConfig } from '@/lib/config';
import type { ProductRow } from '@/lib/db/catalogQueries';
import { isReachable } from '@/lib/reachability';
import {
  restaurantOrdersApi,
  openTableViaRest,
  RestaurantOrderApiError,
  OrderClosedError,
  OfflineMutationError,
  classifyOrderMutationError,
  type RestaurantOrder,
} from '@/lib/api/restaurantOrders';
import { restaurantOrderToOrder } from '@/lib/api/restaurantOrderMapper';
import { logger } from '@/lib/logger';
import { runCashFlow, CashFlowError } from '@/lib/cashOfflineFlow';
import { useAuthStore } from '@/store/auth';

function vatConfigDefault(): TenantVatConfig {
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
    online: isReachable(),
  };
}

/**
 * Translate a thrown REST error into the right cart-side outcome:
 *   - axios "no response" / 5xx → OfflineMutationError (desktop is offline
 *     or backend is briefly unhealthy);
 *   - 400/404 mapping to a closed order → OrderClosedError;
 *   - everything else (real 4xx, validation) → re-thrown verbatim.
 *
 * Caller must handle the returned error type at the boundary; we never
 * fall through to a local SQLite mutation in Faza 2.
 */
function classifyMutationFailure(
  err: unknown,
  action: string,
  orderId: string | null,
): never {
  if (err instanceof RestaurantOrderApiError) {
    const closed = classifyOrderMutationError(err, orderId);
    if (closed) throw closed;
    // 5xx is "backend up but ill" — treat like offline so the UI shows
    // the same banner and the operator knows mutations are paused.
    if (err.status != null && err.status >= 500) {
      throw new OfflineMutationError(action);
    }
    throw err;
  }
  // No-status error means axios couldn't reach the server (network drop,
  // CORS, DNS, timeout). Reachability detector will already have flipped
  // us offline; surface the same offline error here for UX consistency.
  throw new OfflineMutationError(action);
}

export function useOrderActions() {
  const order = useCurrentOrder((s) => s.order);
  const setOrder = useCurrentOrder((s) => s.setOrder);
  const clear = useCurrentOrder((s) => s.clear);
  const categories = useCatalog((s) => s.categories);

  /** Server snapshot already cancelled → drop the cart immediately so
   *  the operator can't keep mutating a stale id. */
  const assertOrderUsable = useCallback(
    (remote: RestaurantOrder, orderId: string | null) => {
      if (remote.status === 'cancelled' || remote.status === 'refunded') {
        clear();
        throw new OrderClosedError(
          'Comanda a fost anulată pe alt dispozitiv.',
          orderId,
          'cancelled',
        );
      }
    },
    [clear],
  );

  const stationFor = useMemo(() => {
    const map = new Map<string, string | null>(
      categories.map((c) => [c.id, c.station]),
    );
    return (categoryId: string | null) =>
      categoryId == null ? null : (map.get(categoryId) ?? null);
  }, [categories]);

  // ── Online-first cart actions ──────────────────────────────────────

  const newOrder = useCallback(
    async (tableId: string | null = null) => {
      if (!isReachable()) throw new OfflineMutationError('newOrder');
      const ctx = buildCtx();
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
        logger.error('pos.order', 'newOrder REST failed', { err: String(err) });
        classifyMutationFailure(err, 'newOrder', null);
      }
    },
    [setOrder],
  );

  const resumeOrder = useCallback(
    async (orderId: string) => {
      // Resume is read-only; we still allow it from the local cache
      // when offline so the operator can SEE a cached order. Mutations
      // on it will be blocked by the action handlers above.
      const ctx = buildCtx();
      if (isReachable()) {
        try {
          const remote = await restaurantOrdersApi.get(orderId);
          assertOrderUsable(remote, orderId);
          const next = restaurantOrderToOrder(remote, ctx.deviceId);
          setOrder(next);
          logger.info('pos.order', 'resumed via REST', {
            orderId,
            items: remote.items.length,
          });
          return next;
        } catch (err) {
          if (err instanceof OrderClosedError) throw err;
          logger.warn('pos.order', 'REST resume failed, falling back to cache', {
            err: String(err),
          });
        }
      }
      // Offline → load read-only snapshot from the cache.
      const { getSyncEngine } = await import('@/lib/sync/bootstrap');
      const { loadOrderFromRemote } = await import('@/lib/sync/resumeOrder');
      const engine = getSyncEngine();
      if (!engine) return null;
      const loaded = await loadOrderFromRemote(engine.exec, orderId);
      if (loaded) setOrder(loaded);
      return loaded;
    },
    [setOrder, assertOrderUsable],
  );

  // Walk-in / phone / delivery still goes through the event-sourced
  // path because the server-side draft-create path for those sources
  // hasn't been wired yet. Kept verbatim from before; not in the Faza 2
  // list. `phone` covers both pickup-at-restaurant (no address) and
  // delivery-from-phone-call (address present); the backend reads
  // `is_delivery` off the address presence.
  const newOrderWithCustomer = useCallback(
    async (
      source: 'walkin' | 'home_delivery' | 'phone',
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
      if (!isReachable()) throw new OfflineMutationError('addProduct');
      const ctx = buildCtx();
      void stationFor; // keep memo dependency stable; station is now server-driven
      try {
        let serverId = order?.serverId ?? null;
        if (!serverId) {
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
        assertOrderUsable(updated, serverId);
        setOrder(restaurantOrderToOrder(updated, ctx.deviceId));
        logger.info('pos.order', 'item added via REST', {
          orderId: serverId,
          productId: p.id,
          productName: p.name,
          items: updated.items.length,
        });
      } catch (err) {
        const apiErr = err instanceof RestaurantOrderApiError ? err : null;
        logger.error('pos.order', 'addItem REST failed', {
          err: apiErr?.message ?? String(err),
          status: apiErr?.status ?? null,
          detail: apiErr?.detail ?? null,
        });
        classifyMutationFailure(err, 'addProduct', order?.serverId ?? null);
      }
    },
    [order, setOrder, stationFor, assertOrderUsable],
  );

  const incrementQuantity = useCallback(
    async (itemId: string) => {
      if (!order || !order.serverId) {
        throw new OfflineMutationError('incrementQuantity');
      }
      const item = order.items.find((it) => it.id === itemId);
      if (!item || item.voidedAt) return;
      if (!isReachable()) throw new OfflineMutationError('incrementQuantity');
      const ctx = buildCtx();
      try {
        const updated = await restaurantOrdersApi.updateItem(order.serverId, itemId, {
          quantity: item.quantity + 1,
        });
        assertOrderUsable(updated, order.serverId);
        setOrder(restaurantOrderToOrder(updated, ctx.deviceId));
        logger.info('pos.order', 'qty++ via REST', {
          orderId: order.serverId,
          itemId,
        });
      } catch (err) {
        logger.error('pos.order', 'updateItem REST failed', { err: String(err) });
        classifyMutationFailure(err, 'incrementQuantity', order.serverId);
      }
    },
    [order, setOrder, assertOrderUsable],
  );

  const decrementQuantity = useCallback(
    async (itemId: string) => {
      if (!order || !order.serverId) {
        throw new OfflineMutationError('decrementQuantity');
      }
      const item = order.items.find((it) => it.id === itemId);
      if (!item || item.voidedAt) return;
      if (!isReachable()) throw new OfflineMutationError('decrementQuantity');
      const ctx = buildCtx();
      try {
        if (item.quantity <= 1) {
          const updated = await restaurantOrdersApi.removeItem(order.serverId, itemId);
          assertOrderUsable(updated, order.serverId);
          setOrder(restaurantOrderToOrder(updated, ctx.deviceId));
          logger.info('pos.order', 'item voided via REST (qty=0)', {
            orderId: order.serverId,
            itemId,
          });
        } else {
          const updated = await restaurantOrdersApi.updateItem(order.serverId, itemId, {
            quantity: item.quantity - 1,
          });
          assertOrderUsable(updated, order.serverId);
          setOrder(restaurantOrderToOrder(updated, ctx.deviceId));
          logger.info('pos.order', 'qty-- via REST', {
            orderId: order.serverId,
            itemId,
          });
        }
      } catch (err) {
        logger.error('pos.order', 'decrement REST failed', { err: String(err) });
        classifyMutationFailure(err, 'decrementQuantity', order.serverId);
      }
    },
    [order, setOrder, assertOrderUsable],
  );

  const removeItem = useCallback(
    async (itemId: string, reason: string = 'removed by waiter') => {
      if (!order || !order.serverId) {
        throw new OfflineMutationError('removeItem');
      }
      const item = order.items.find((it) => it.id === itemId);
      if (!item || item.voidedAt) return;
      if (!isReachable()) throw new OfflineMutationError('removeItem');
      const ctx = buildCtx();
      try {
        const updated = await restaurantOrdersApi.removeItem(order.serverId, itemId);
        assertOrderUsable(updated, order.serverId);
        setOrder(restaurantOrderToOrder(updated, ctx.deviceId));
        logger.info('pos.order', 'item removed via REST', {
          orderId: order.serverId,
          itemId,
          reason,
        });
      } catch (err) {
        logger.error('pos.order', 'removeItem REST failed', { err: String(err) });
        classifyMutationFailure(err, 'removeItem', order.serverId);
      }
    },
    [order, setOrder, assertOrderUsable],
  );

  const sendOrderToKitchen = useCallback(async () => {
    if (!order || !order.serverId) {
      throw new OfflineMutationError('sendOrderToKitchen');
    }
    if (!isReachable()) throw new OfflineMutationError('sendOrderToKitchen');
    const ctx = buildCtx();
    try {
      const updated = await restaurantOrdersApi.sendToKitchen(order.serverId);
      assertOrderUsable(updated, order.serverId);
      setOrder(restaurantOrderToOrder(updated, ctx.deviceId));
      logger.info('pos.order', 'sent to kitchen via REST', {
        orderId: order.serverId,
        tickets: updated.kitchenTickets.length,
      });
    } catch (err) {
      logger.error('pos.order', 'sendToKitchen REST failed', { err: String(err) });
      classifyMutationFailure(err, 'sendOrderToKitchen', order.serverId);
    }
  }, [order, setOrder, assertOrderUsable]);

  const cancelCurrentOrder = useCallback(
    async (reason: string = 'anulat din POS') => {
      if (!order || !order.serverId) {
        throw new OfflineMutationError('cancelCurrentOrder');
      }
      if (!isReachable()) throw new OfflineMutationError('cancelCurrentOrder');
      try {
        await restaurantOrdersApi.cancel(order.serverId, reason);
        logger.info('pos.order', 'cancelled via REST', {
          orderId: order.serverId,
          reason,
        });
        clear();
      } catch (err) {
        if (err instanceof RestaurantOrderApiError) {
          const closed = classifyOrderMutationError(err, order.serverId);
          if (closed) {
            clear();
            throw closed;
          }
        }
        logger.error('pos.order', 'cancel REST failed', { err: String(err) });
        classifyMutationFailure(err, 'cancelCurrentOrder', order.serverId);
      }
    },
    [order, clear],
  );

  // ── Payment helpers (cash offline / card) — refactored elsewhere ──

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

  /**
   * Faza 2 — cash payment flow.
   *   Online → POST /payments with Idempotency-Key (server fiscalises).
   *   Offline → DP-25X emits the bon, outbox row queued for sync.
   * Cash is forbidden on local-only drafts (no `serverId`) because the
   * worker needs a server order id to post against later.
   */
  const payCashAmount = useCallback(
    async (amountCents: number, _acceptOverTender = false) => {
      if (!order) return;
      void _acceptOverTender; // tender > total handled by the modal UI
      if (!order.serverId) {
        throw new CashFlowError(
          'OFFLINE_NO_SERVER_ORDER',
          'Comanda nu este sincronizată cu serverul. Salvează comanda online înainte de a încasa cash.',
        );
      }
      const restaurant = useAuthStore.getState().selectedRestaurant;
      if (!restaurant) {
        throw new CashFlowError(
          'NO_RESTAURANT_CTX',
          'Nu există restaurant selectat în profilul curent.',
        );
      }
      const ctx = buildCtx();
      const outcome = await runCashFlow({
        serverOrderId: order.serverId,
        restaurantId: restaurant.id,
        amountCents,
      });
      if (outcome.kind === 'online') {
        setOrder(restaurantOrderToOrder(outcome.order, ctx.deviceId));
      } else {
        // Offline — reflect "paid" locally so the cart UI updates. The
        // sync worker will reconcile with the server when reachable.
        // We mark the order as paid + closed in the local cart slot;
        // the cached `remote_orders` row keeps the prior status until
        // the next pull (which only succeeds online anyway).
        const r = await runAction(() =>
          registerCashPayment(order, { amountCents, acceptOverTender: false }, ctx),
        );
        setOrder(r.next);
      }
    },
    [order, setOrder],
  );

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

// Re-export so PosShell can branch on offline-mutation toasts.
export { OfflineMutationError };

// Helper used by PosShell's read-only check.
export function isOrderEditable(orderHasServerId: boolean): boolean {
  return orderHasServerId && isReachable();
}
