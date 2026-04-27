/**
 * Orchestrates a single /api/pos/sync/pull cycle.
 * Sprint 6 / 3.
 *
 * Reads the persisted cursor (or null on first call), fetches the
 * incremental snapshot, merges it into SQLite, and returns a summary.
 * Failures are surfaced as `{ ok: false, error }` — never throw — so
 * the scheduler keeps ticking.
 */
import { fetchPullChanges, type PullChangesResponse } from '@/lib/api/pull';
import { applyPullChanges, readPullCursor, type ApplyPullResult } from './applyPull';
import { getConfig } from '@/lib/config';
import type { SqlExecutor } from '@/lib/db/executor';
import { dbg, dbgError } from '@/lib/debugLog';

let _lastPullDurationMs: number | null = null;
export function readLastPullDurationMs(): number | null {
  return _lastPullDurationMs;
}

export interface RunPullOptions {
  exec: SqlExecutor;
  /** Override the fetcher in tests. */
  fetcher?: (since: string | null, deviceId?: string | null) => Promise<PullChangesResponse>;
}

export type RunPullResult =
  | { ok: true; summary: ApplyPullResult; pull: PullChangesResponse }
  | { ok: false; error: Error };

export async function runPull(opts: RunPullOptions): Promise<RunPullResult> {
  const fetcher = opts.fetcher ?? fetchPullChanges;
  const t0 = Date.now();
  let cursor: string | null;
  try {
    cursor = await readPullCursor(opts.exec);
  } catch (err) {
    dbgError('pull', 'readCursor ✖', { message: (err as Error)?.message ?? String(err) });
    return { ok: false, error: err as Error };
  }
  let pull: PullChangesResponse;
  try {
    pull = await fetcher(cursor, getConfig().deviceId);
  } catch (err) {
    dbgError('pull', `fetch ✖ ${Date.now() - t0}ms`, {
      message: (err as Error)?.message ?? String(err),
      cursor,
    });
    return { ok: false, error: err as Error };
  }
  try {
    const summary = await applyPullChanges(opts.exec, pull);
    _lastPullDurationMs = Date.now() - t0;
    dbg('pull', `runPull ◀ ${_lastPullDurationMs}ms`, {
      orders: pull.changes?.orders?.length ?? 0,
      orderItems: pull.changes?.orderItems?.length ?? 0,
      kitchenTickets: pull.changes?.kitchenTickets?.length ?? 0,
      cursorIn: cursor,
      cursorOut: pull.nextCursor,
    });
    return { ok: true, summary, pull };
  } catch (err) {
    _lastPullDurationMs = Date.now() - t0;
    dbgError('pull', `applyPull ✖ ${_lastPullDurationMs}ms`, {
      message: (err as Error)?.message ?? String(err),
    });
    return { ok: false, error: err as Error };
  }
}
