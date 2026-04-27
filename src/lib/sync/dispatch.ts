/**
 * dispatchPosAction — the single chokepoint UI uses to mutate orders.
 *
 *   const next = await dispatchPosAction(addItem, [order, cmd], { online });
 *
 * Pipeline:
 *   1. Run the pure pos-core action → { next, events, ... }.
 *   2. Persist events atomically to SQLite (events + sync_outbox).
 *   3. Return the new order to the caller.
 *
 * Dispatch never makes HTTP calls — that is the outbox worker's job.
 * If persistence fails, the caller never sees the new state, so the
 * UI cannot drift from local truth.
 */
import type { Order, SyncEvent } from '@/core/pos-core';
import type { EventStore } from './eventStore';
import { dbg, dbgError } from '@/lib/debugLog';

export interface DispatchEnv {
  store: EventStore;
  now: () => string; // ISO
}

/**
 * pos-core actions return either `{ next, events }` (most) or richer
 * result objects (sendToKitchen returns tickets too, createFiscalAttempt
 * returns the attempt). We accept any shape that has at least { events }.
 */
export interface ActionLike<T> {
  next: T;
  events: SyncEvent[];
}

let _env: DispatchEnv | null = null;

export function configureDispatch(env: DispatchEnv): void {
  _env = env;
}

export async function dispatchResult<R extends ActionLike<unknown>>(
  result: R,
  env: DispatchEnv = _env!,
): Promise<R> {
  if (!env) {
    const err = new Error('dispatch: configureDispatch() not called');
    dbgError('dispatch', 'dispatchResult: env is null — UI action will silently no-op', {
      eventCount: result.events.length,
    });
    throw err;
  }
  if (result.events.length === 0) {
    return result;
  }
  dbg('dispatch', 'persistBatch ▶', {
    count: result.events.length,
    types: result.events.map((e) => e.type),
    mutationIds: result.events.map((e) => e.mutationId),
  });
  try {
    await env.store.persistBatch(result.events, env.now());
    dbg('dispatch', 'persistBatch ◀ ok', { count: result.events.length });
  } catch (err) {
    dbgError('dispatch', 'persistBatch ✖', {
      message: (err as Error)?.message ?? String(err),
      stack: (err as Error)?.stack,
      count: result.events.length,
      types: result.events.map((e) => e.type),
    });
    throw err;
  }
  return result;
}

/**
 * Functional sugar: runs the pos-core action, then persists.
 *
 *   const r = await runAction(() => addItem(order, cmd, ctx));
 *   setOrder(r.next);
 */
export async function runAction<R extends ActionLike<unknown>>(
  fn: () => R,
  env: DispatchEnv = _env!,
): Promise<R> {
  let result: R;
  try {
    result = fn();
  } catch (err) {
    dbgError('runAction', 'pos-core action threw', {
      message: (err as Error)?.message ?? String(err),
      stack: (err as Error)?.stack,
    });
    throw err;
  }
  dbg('runAction', 'action ok', {
    eventCount: result.events.length,
    types: result.events.map((e) => e.type),
  });
  return dispatchResult(result, env);
}

export type { Order };
