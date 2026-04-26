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
import type { SqlExecutor } from '@/lib/db/executor';
import type { SyncTransport } from './transport';

type BootstrapListener = (r: RunBootstrapResult) => void;

export interface SyncEngine {
  store: EventStore;
  worker: OutboxWorker;
  transport: SyncTransport;
  exec: SqlExecutor;
  bootstrapScheduler: BootstrapScheduler;
  /** Subscribe to every bootstrap attempt (foreground + scheduled).
   * Returns an unsubscribe function. */
  onBootstrapResult: (fn: BootstrapListener) => () => void;
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

  const stop = () => {
    stopWorker();
    bootstrapScheduler.stop();
    listeners.clear();
  };
  _engine = { store, worker, transport, exec, bootstrapScheduler, onBootstrapResult, stop };
  return _engine;
}

export function getSyncEngine(): SyncEngine | null {
  return _engine;
}
