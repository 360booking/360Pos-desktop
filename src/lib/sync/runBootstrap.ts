/**
 * Orchestrates a full bootstrap: fetch /api/pos/bootstrap, hydrate the
 * local SQLite catalogue, and report the outcome. Sprint 4 / 1.
 *
 * A failing fetch does NOT mutate local state — the previous bootstrap
 * remains the operator's view of truth. The caller (the scheduler or a
 * "Refresh" button) decides whether to surface the error.
 */
import { fetchBootstrap, type BootstrapResponse } from '@/lib/api/bootstrap';
import { hydrateCatalog, type HydrateSummary } from './hydrateCatalog';
import type { SqlExecutor } from '@/lib/db/executor';
import { dbg, dbgError } from '@/lib/debugLog';

export interface RunBootstrapOptions {
  exec: SqlExecutor;
  restaurantId?: string | null;
  /** Override the fetcher in tests. Defaults to fetchBootstrap(). */
  fetcher?: (restaurantId?: string) => Promise<BootstrapResponse>;
}

export interface RunBootstrapOk {
  ok: true;
  summary: HydrateSummary;
  bootstrap: BootstrapResponse;
}
export interface RunBootstrapErr {
  ok: false;
  error: Error;
}
export type RunBootstrapResult = RunBootstrapOk | RunBootstrapErr;

export async function runBootstrap(
  opts: RunBootstrapOptions,
): Promise<RunBootstrapResult> {
  const fetcher = opts.fetcher ?? fetchBootstrap;
  const t0 = Date.now();
  dbg('bootstrap', 'runBootstrap ▶', { restaurantId: opts.restaurantId ?? null });
  let bootstrap: BootstrapResponse;
  try {
    bootstrap = await fetcher(opts.restaurantId ?? undefined);
  } catch (err) {
    dbgError('bootstrap', `fetch ✖ ${Date.now() - t0}ms`, {
      message: (err as Error)?.message ?? String(err),
      restaurantId: opts.restaurantId ?? null,
    });
    return { ok: false, error: err as Error };
  }
  try {
    const summary = await hydrateCatalog(opts.exec, bootstrap);
    dbg('bootstrap', `runBootstrap ◀ ${Date.now() - t0}ms`, {
      categories: bootstrap.categories?.length ?? 0,
      products: bootstrap.products?.length ?? 0,
      tables: bootstrap.tables?.length ?? 0,
      restaurantResolved: bootstrap.restaurant?.id ?? null,
    });
    return { ok: true, summary, bootstrap };
  } catch (err) {
    dbgError('bootstrap', `hydrate ✖ ${Date.now() - t0}ms`, {
      message: (err as Error)?.message ?? String(err),
      stack: (err as Error)?.stack,
    });
    return { ok: false, error: err as Error };
  }
}
