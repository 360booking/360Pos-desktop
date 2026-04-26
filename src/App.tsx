import { useEffect, useState } from 'react';
import { PosShell } from './features/pos/PosShell';
import { useDeviceStatusBootstrap } from './features/pos/useDeviceStatusBootstrap';
import { initDb } from './lib/db';
import { logger } from './lib/logger';
import { startSyncEngine, type SyncEngine } from './lib/sync/bootstrap';
import { useSyncStatus } from './lib/sync/useSyncStatus';

export default function App() {
  useDeviceStatusBootstrap();
  const [engine, setEngine] = useState<SyncEngine | null>(null);

  useEffect(() => {
    initDb()
      .then(() => logger.info('app', 'DB ready'))
      .catch((err) => logger.error('app', 'DB init failed', { err: String(err) }));
  }, []);

  useEffect(() => {
    let stop: (() => void) | undefined;
    startSyncEngine().then((e) => {
      if (!e) return;
      setEngine(e);
      stop = e.stop;
      logger.info('sync', 'engine started');
    });
    return () => stop?.();
  }, []);

  useSyncStatus({ store: engine?.store ?? null, transport: engine?.transport ?? null });

  return <PosShell />;
}
