/**
 * Pull scheduler — Sprint 6 / 3.
 *
 * Sits next to bootstrapScheduler. Every PULL_INTERVAL_MS the worker
 * triggers a pull cycle; the engine also calls runNow() on reconnect.
 * Just like the bootstrap path, an offline tick is a no-op so the loop
 * doesn't burn HTTP attempts when we know we can't talk to the backend.
 *
 * Order on reconnect (engine.ts wires this): push outbox first, THEN
 * pull. Push first so any pending mutation lands before the snapshot we
 * read; otherwise the desktop's view could lag its own writes by one
 * cycle.
 */
import { runPull, type RunPullResult } from './runPull';
import type { SqlExecutor } from '@/lib/db/executor';

export const PULL_INTERVAL_MS = 8_000; // 8 seconds — tight enough to feel live, loose enough not to flood

export interface PullSchedulerOptions {
  exec: SqlExecutor;
  isOnline?: () => boolean;
  onResult?: (r: RunPullResult) => void;
  intervalMs?: number;
}

export interface PullScheduler {
  stop: () => void;
  runNow: () => Promise<RunPullResult>;
}

export function startPullScheduler(opts: PullSchedulerOptions): PullScheduler {
  const interval = opts.intervalMs ?? PULL_INTERVAL_MS;
  const isOnline = opts.isOnline ?? (() => true);

  let inFlight: Promise<RunPullResult> | null = null;

  async function tick(force: boolean): Promise<RunPullResult> {
    if (inFlight) return inFlight;
    if (!force && !isOnline()) {
      const skipped: RunPullResult = {
        ok: false,
        error: new Error('OFFLINE_SKIPPED'),
      };
      opts.onResult?.(skipped);
      return skipped;
    }
    const p = runPull({ exec: opts.exec });
    inFlight = p;
    try {
      const r = await p;
      opts.onResult?.(r);
      return r;
    } finally {
      inFlight = null;
    }
  }

  const handle = setInterval(() => {
    void tick(false);
  }, interval);

  return {
    stop: () => clearInterval(handle),
    runNow: () => tick(true),
  };
}
