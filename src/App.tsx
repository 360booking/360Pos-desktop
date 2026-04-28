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
  //
  // App.tsx is the SOLE owner of the engine lifecycle. Children
  // (useCatalogBootstrap) read the singleton via getSyncEngine() and
  // never call startSyncEngine() themselves — that previously raced
  // with this effect because child mount effects run before the
  // parent's, taking the singleton with restaurantId=undefined.
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapTimeout, setBootstrapTimeout] = useState(false);
  useEffect(() => {
    if (status !== 'authenticated' || !selectedRestaurant) {
      return;
    }
    let stop: (() => void) | undefined;
    let cancelled = false;
    setBootstrapError(null);
    setBootstrapTimeout(false);
    const timeoutId = setTimeout(() => {
      if (!cancelled) setBootstrapTimeout(true);
    }, 5000);
    startSyncEngine({ restaurantId: selectedRestaurant.id })
      .then((e) => {
        if (cancelled) return;
        if (!e) {
          setBootstrapError('startSyncEngine returned null (not in Tauri shell?)');
          return;
        }
        setEngine(e);
        stop = e.stop;
        logger.info('sync', 'engine started', { restaurantId: selectedRestaurant.id });
      })
      .catch((err) => {
        if (cancelled) return;
        const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
        setBootstrapError(detail);
        logger.error('sync', 'engine start failed', { err: detail });
      });
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
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
  // Hold PosShell back until the engine is ready so children can rely
  // on getSyncEngine() returning a non-null value with the right
  // restaurantId.
  if (!engine) {
    return (
      <div className="grid min-h-screen w-full place-items-center bg-slate-950 text-slate-400 p-6">
        <div className="max-w-2xl w-full space-y-4">
          <div className="text-sm">Pornire sincronizare...</div>
          {bootstrapTimeout && !bootstrapError && (
            <div className="rounded-xl border border-amber-400/40 bg-amber-950/30 p-4 text-xs text-amber-200 space-y-2">
              <div className="font-semibold">Sincronizarea nu a răspuns în 5 secunde.</div>
              <div className="text-amber-300/80">
                Restaurant ID: <code>{selectedRestaurant.id}</code>
                <br />
                Apasă F12 / Ctrl+Shift+I pentru DevTools (tab Console) ca să vezi eroarea exactă.
              </div>
              <button
                type="button"
                onClick={() => {
                  void useAuthStore.getState().clear();
                  window.location.reload();
                }}
                className="mt-2 rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25"
              >
                Logout + reload
              </button>
            </div>
          )}
          {bootstrapError && (
            <div className="rounded-xl border border-rose-400/40 bg-rose-950/30 p-4 text-xs text-rose-100 space-y-2">
              <div className="font-semibold text-rose-200">Sincronizarea a eșuat.</div>
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-rose-100/90 max-h-72 overflow-auto bg-black/30 p-3 rounded-lg">
                {bootstrapError}
              </pre>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(bootstrapError);
                  }}
                  className="rounded-lg border border-rose-400/40 bg-rose-500/15 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/25"
                >
                  Copy error
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void useAuthStore.getState().clear();
                    window.location.reload();
                  }}
                  className="rounded-lg border border-slate-400/40 bg-slate-500/15 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-500/25"
                >
                  Logout + reload
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
  return <PosShell />;
}

// Ensure the engine is stopped if a hot reload swaps the module.
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopSyncEngine());
}
