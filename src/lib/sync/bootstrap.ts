/**
 * Bootstraps the sync engine inside the Tauri shell.
 *
 * In a non-Tauri preview (plain `pnpm dev`), the SQLite plugin is
 * unavailable; we return null components so the UI still renders.
 */
import { tauriExecutor } from '@/lib/db/tauriExecutor';
import { initDb } from '@/lib/db';
import { getApiClient } from '@/lib/api/client';
import { getConfig } from '@/lib/config';
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

export async function startSyncEngine(): Promise<SyncEngine | null> {
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
  const stopWorker = worker.start(2_000);
  configureDispatch({ store, now: () => new Date().toISOString() });

  // Sprint 4 / 1: hydrate the local catalogue from /api/pos/bootstrap on
  // startup, then keep it fresh with a 30-minute background tick. The
  // first hydrate runs in the foreground so the menu pane has data
  // before the operator opens it; failures don't block the engine from
  // coming up — the cached SQLite stays the source of truth.
  const listeners = new Set<BootstrapListener>();
  const broadcast = (r: RunBootstrapResult) => {
    for (const fn of listeners) {
      try { fn(r); } catch { /* swallow — keep other listeners running */ }
    }
  };
  const cfg = getConfig();
  if (cfg.syncTransportMode === 'http') {
    void runBootstrap({ exec, restaurantId: cfg.restaurantId }).then(broadcast);
  }
  const bootstrapScheduler = startBootstrapScheduler({
    exec,
    restaurantId: cfg.restaurantId,
    isOnline: () => cfg.syncTransportMode === 'http',
    onResult: broadcast,
  });

  const onBootstrapResult: SyncEngine['onBootstrapResult'] = (fn) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  };

  // Sprint 6 / 3: pull scheduler runs every 8s, broadcasts results so
  // the catalog/remote-orders stores can refresh on each tick. The
  // bootstrap scheduler keeps doing its 30-min refresh; the pull is
  // the live channel for orders + kitchen tickets.
  const pullListeners = new Set<PullListener>();
  const broadcastPull = (r: RunPullResult) => {
    for (const fn of pullListeners) {
      try { fn(r); } catch { /* swallow */ }
    }
  };
  // Kick a pull on startup so TablesPane sees the open tabs immediately,
  // not eight seconds in. Push runs before pull on reconnect; on first
  // start the outbox is empty so we just pull.
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

  // Sprint 8 — heartbeat scheduler keeps locks renewed for orders we
  // own and lets the backend track device liveness. Skipped offline.
  const heartbeatScheduler = startHeartbeatScheduler({
    isOnline: () => cfg.syncTransportMode === 'http',
  });

  const stop = () => {
    stopWorker();
    bootstrapScheduler.stop();
    pullScheduler.stop();
    heartbeatScheduler.stop();
    listeners.clear();
    pullListeners.clear();
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
