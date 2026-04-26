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
  let cursor: string | null;
  try {
    cursor = await readPullCursor(opts.exec);
  } catch (err) {
    return { ok: false, error: err as Error };
  }
  let pull: PullChangesResponse;
  try {
    // Sprint 7 — pass deviceId so the backend can stamp
    // currentDeviceCanEdit per row in the response.
    pull = await fetcher(cursor, getConfig().deviceId);
  } catch (err) {
    return { ok: false, error: err as Error };
  }
  try {
    const summary = await applyPullChanges(opts.exec, pull);
    return { ok: true, summary, pull };
  } catch (err) {
    return { ok: false, error: err as Error };
  }
}
