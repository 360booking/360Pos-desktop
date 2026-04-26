import { useEffect, useState } from 'react';

import { LoginScreen } from './features/auth/LoginScreen';
import { RestaurantPicker } from './features/auth/RestaurantPicker';
import { PosShell } from './features/pos/PosShell';
import { useDeviceStatusBootstrap } from './features/pos/useDeviceStatusBootstrap';
import { initDb } from './lib/db';
import { logger } from './lib/logger';
import { startSyncEngine, stopSyncEngine, type SyncEngine } from './lib/sync/bootstrap';
import { useSyncStatus } from './lib/sync/useSyncStatus';
import { useAuthStore } from './store/auth';

export default function App() {
  useDeviceStatusBootstrap();
  const [engine, setEngine] = useState<SyncEngine | null>(null);

  const status = useAuthStore((s) => s.status);
  const selectedRestaurant = useAuthStore((s) => s.selectedRestaurant);
  const hydrate = useAuthStore((s) => s.hydrateFromDisk);

  // 1) DB ready (login screen needs it for the device-id row).
  useEffect(() => {
    initDb()
      .then(() => logger.info('app', 'DB ready'))
      .catch((err) => logger.warn('app', 'DB init failed', { err: String(err) }));
  }, []);

  // 2) Restore refresh token from disk if present.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // 3) Sync engine starts ONLY after login + restaurant pick.
  useEffect(() => {
    if (status !== 'authenticated' || !selectedRestaurant) {
      return;
    }
    let stop: (() => void) | undefined;
    startSyncEngine({ restaurantId: selectedRestaurant.id }).then((e) => {
      if (!e) return;
      setEngine(e);
      stop = e.stop;
      logger.info('sync', 'engine started', { restaurantId: selectedRestaurant.id });
    });
    return () => {
      stop?.();
      setEngine(null);
    };
  }, [status, selectedRestaurant]);

  useSyncStatus({ store: engine?.store ?? null, transport: engine?.transport ?? null });

  // 4) Render gate.
  if (status === 'booting') {
    return (
      <div className="grid min-h-screen w-full place-items-center bg-slate-950 text-slate-400">
        <div className="text-sm">Inițializare...</div>
      </div>
    );
  }
  if (status === 'unauthenticated') {
    return <LoginScreen />;
  }
  // status === 'authenticated' from here.
  if (!selectedRestaurant) {
    return <RestaurantPicker />;
  }
  return <PosShell />;
}

// Ensure the engine is stopped if a hot reload swaps the module.
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopSyncEngine());
}
