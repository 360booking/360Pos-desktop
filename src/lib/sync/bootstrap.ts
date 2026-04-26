/**
 * Bootstraps the sync engine inside the Tauri shell.
 *
 * In a non-Tauri preview (plain `pnpm dev`), the SQLite plugin is
 * unavailable; we return null components so the UI still renders.
 *
 * Sprint 10 / F — the startup order MATTERS:
 *   1) initial bootstrap hydrate (single big BEGIN/COMMIT) runs FIRST,
 *      synchronously awaited, so SQLite is not contended;
 *   2) only after hydrate completes do we spin up the outbox worker,
 *      pull scheduler and heartbeat — these write to the DB on their
 *      own ticks, and overlapping them with hydrate caused the
 *      "database is locked" pilot bug.
 *
 * The tauriExecutor in turn serialises every operation through a
 * single FIFO mutex, so even after startup overlapping callers can't
 * race. Belt + braces.
 */
import { tauriExecutor } from '@/lib/db/tauriExecutor';
import { initDb } from '@/lib/db';
import { getApiClient } from '@/lib/api/client';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { createEventStore, type EventStore } from './eventStore';
import { createOutboxWorker, type OutboxWorker } from './outboxWorker';
import { createInMemorySyncTransport } from './inMemoryTransport';
import { createHttpSyncTransport } from './httpTransport';
import { configureDispatch } from './dispatch';
import { startBootstrapScheduler, type BootstrapScheduler } from './bootstrapScheduler';
import { runBootstrap, type RunBootstrapResult } from './runBootstrap';
import { startPullScheduler, type PullScheduler } from './pullScheduler';
import { runPull, type RunPullResult } from './runPull';
import { startHeartbeatScheduler, type HeartbeatScheduler } from './heartbeatScheduler';
import { rememberBootstrap } from './lastBootstrap';
import type { SqlExecutor } from '@/lib/db/executor';
import type { SyncTransport } from './transport';

type BootstrapListener = (r: RunBootstrapResult) => void;
type PullListener = (r: RunPullResult) => void;

export interface SyncEngine {
  store: EventStore;
  worker: OutboxWorker;
  transport: SyncTransport;
  exec: SqlExecutor;
  bootstrapScheduler: BootstrapScheduler;
  pullScheduler: PullScheduler;
  heartbeatScheduler: HeartbeatScheduler;
  /** Subscribe to every bootstrap attempt (foreground + scheduled).
   * Returns an unsubscribe function. */
  onBootstrapResult: (fn: BootstrapListener) => () => void;
  /** Subscribe to every pull cycle. */
  onPullResult: (fn: PullListener) => () => void;
  stop: () => void;
}

let _engine: SyncEngine | null = null;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function buildTransport(): SyncTransport {
  const cfg = getConfig();
  if (cfg.syncTransportMode === 'http') {
    return createHttpSyncTransport({ axios: getApiClient() });
  }
  return createInMemorySyncTransport({ mode: 'success' });
}

export interface StartSyncEngineOptions {
  /** Sprint 10: restaurant selected after login. Falls back to the
   *  config-baked restaurantId for legacy demo builds. */
  restaurantId?: string | null;
}

const HYDRATE_RETRY_BACKOFF_MS = [250, 750, 1500];

function isLockedError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  return /database is locked|\(code: ?5\)|SQLITE_BUSY/i.test(msg);
}

/** Run the initial bootstrap with up to 3 retries on SQLite-locked
 *  errors. Other failures bubble up after the first attempt. */
async function runInitialBootstrapWithRetry(
  exec: SqlExecutor,
  restaurantId: string | null,
  broadcast: (r: RunBootstrapResult) => void,
): Promise<RunBootstrapResult> {
  let last: RunBootstrapResult = { ok: false, error: new Error('not_attempted') };
  for (let attempt = 0; attempt <= HYDRATE_RETRY_BACKOFF_MS.length; attempt += 1) {
    last = await runBootstrap({ exec, restaurantId });
    bumpAttempts();
    if (last.ok) {
      broadcast(last);
      return last;
    }
    if (!isLockedError(last.error) || attempt === HYDRATE_RETRY_BACKOFF_MS.length) {
      broadcast(last);
      return last;
    }
    const wait = HYDRATE_RETRY_BACKOFF_MS[attempt];
    logger.warn('sync', 'bootstrap hydrate locked — retrying', {
      attempt: attempt + 1,
      waitMs: wait,
    });
    await new Promise((r) => setTimeout(r, wait));
  }
  broadcast(last);
  return last;
}

let _bootstrapAttempts = 0;
function bumpAttempts(): void {
  _bootstrapAttempts += 1;
}
export function readBootstrapAttempts(): number {
  return _bootstrapAttempts;
}

let _hydrating = false;
export function isHydrating(): boolean {
  return _hydrating;
}

let _schedulersStarted = false;
export function readSchedulersStarted(): boolean {
  return _schedulersStarted;
}

export async function startSyncEngine(opts: StartSyncEngineOptions = {}): Promise<SyncEngine | null> {
  if (_engine) return _engine;
  if (!isTauri()) return null;

  const db = await initDb();
  const exec = tauriExecutor(db);
  const store = createEventStore(exec);
  const transport = buildTransport();
  const worker = createOutboxWorker({
    store,
    transport,
    now: () => new Date().toISOString(),
  });
  configureDispatch({ store, now: () => new Date().toISOString() });

  const listeners = new Set<BootstrapListener>();
  const cfg = getConfig();
  // Caller-supplied restaurantId (from login picker) wins over
  // auth-store selection, which itself wins over the config-baked
  // value (always null in tenant builds).
  const { useAuthStore } = await import('@/store/auth');
  const authRestaurantId = useAuthStore.getState().selectedRestaurant?.id ?? null;
  const restaurantId = opts.restaurantId ?? authRestaurantId ?? cfg.restaurantId;

  const broadcast = (r: RunBootstrapResult) => {
    rememberBootstrap(r, restaurantId ?? null);
    for (const fn of listeners) {
      try { fn(r); } catch { /* swallow — keep other listeners running */ }
    }
  };

  // STEP 1: serial initial hydrate. Workers + pull do NOT start until
  // this completes (or definitively fails). Running them concurrently
  // is what triggered the "database is locked" pilot bug, even with
  // the JS-side mutex — the mutex serialises calls but the long
  // hydrate transaction would still backpressure pull/outbox writes
  // for several seconds.
  if (cfg.syncTransportMode === 'http') {
    _hydrating = true;
    try {
      await runInitialBootstrapWithRetry(exec, restaurantId, broadcast);
    } finally {
      _hydrating = false;
    }
  }

  // STEP 2: now safe to start the periodic workers.
  const stopWorker = worker.start(2_000);

  const bootstrapScheduler = startBootstrapScheduler({
    exec,
    restaurantId,
    isOnline: () => cfg.syncTransportMode === 'http',
    onResult: broadcast,
  });

  const onBootstrapResult: SyncEngine['onBootstrapResult'] = (fn) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  };

  const pullListeners = new Set<PullListener>();
  const broadcastPull = (r: RunPullResult) => {
    for (const fn of pullListeners) {
      try { fn(r); } catch { /* swallow */ }
    }
  };
  if (cfg.syncTransportMode === 'http') {
    void runPull({ exec }).then(broadcastPull);
  }
  const pullScheduler = startPullScheduler({
    exec,
    isOnline: () => cfg.syncTransportMode === 'http',
    onResult: broadcastPull,
  });
  const onPullResult: SyncEngine['onPullResult'] = (fn) => {
    pullListeners.add(fn);
    return () => { pullListeners.delete(fn); };
  };

  const heartbeatScheduler = startHeartbeatScheduler({
    isOnline: () => cfg.syncTransportMode === 'http',
  });

  _schedulersStarted = true;

  const stop = () => {
    stopWorker();
    bootstrapScheduler.stop();
    pullScheduler.stop();
    heartbeatScheduler.stop();
    listeners.clear();
    pullListeners.clear();
    _schedulersStarted = false;
  };
  _engine = {
    store,
    worker,
    transport,
    exec,
    bootstrapScheduler,
    pullScheduler,
    heartbeatScheduler,
    onBootstrapResult,
    onPullResult,
    stop,
  };
  return _engine;
}

export function getSyncEngine(): SyncEngine | null {
  return _engine;
}

/** Sprint 10: tear down the engine on logout so the next user gets a
 *  fresh bootstrap + clean schedulers. */
export function stopSyncEngine(): void {
  if (_engine) {
    _engine.stop();
    _engine = null;
  }
}
