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
import type { SqlExecutor } from '@/lib/db/executor';

export interface RunPullOptions {
  exec: SqlExecutor;
  /** Override the fetcher in tests. */
  fetcher?: (since: string | null) => Promise<PullChangesResponse>;
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
    pull = await fetcher(cursor);
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
