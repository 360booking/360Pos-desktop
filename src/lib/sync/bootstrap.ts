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
import type { SyncTransport } from './transport';

export interface SyncEngine {
  store: EventStore;
  worker: OutboxWorker;
  transport: SyncTransport;
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
  const stop = worker.start(2_000);
  configureDispatch({ store, now: () => new Date().toISOString() });
  _engine = { store, worker, transport, stop };
  return _engine;
}

export function getSyncEngine(): SyncEngine | null {
  return _engine;
}
