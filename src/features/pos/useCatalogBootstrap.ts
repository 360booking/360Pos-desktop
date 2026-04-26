/**
 * Glue between the sync engine + the catalog zustand store. Sprint 4 / 2.
 *
 * On mount inside the Tauri shell:
 *   - read the cached catalogue from SQLite into the store, so the
 *     menu/tables panes render whatever the last bootstrap left behind;
 *   - subscribe to engine.onBootstrapResult so a successful refresh
 *     (foreground or scheduled) re-reads SQLite into the store too.
 *
 * Outside Tauri (plain Vite preview / Storybook) the engine is null —
 * we leave the store at its empty default and the panes show their
 * "no catalogue yet" state.
 */
import { useEffect } from 'react';
import { getSyncEngine } from '@/lib/sync/bootstrap';
import { useCatalog } from '@/store/catalog';
import { useRemote } from '@/store/remote';

export function useCatalogBootstrap() {
  useEffect(() => {
    let cancelled = false;
    let unsubscribeBootstrap: (() => void) | null = null;
    let unsubscribePull: (() => void) | null = null;

    (async () => {
      // App.tsx owns engine lifecycle and only mounts PosShell once the
      // engine is ready, so getSyncEngine() is non-null here. We do NOT
      // call startSyncEngine ourselves — that race was the Sprint 10
      // tenant-build "no tables" bug (engine was started without the
      // selected restaurant id).
      const engine = getSyncEngine();
      if (cancelled || !engine) return;

      // Initial loads — both the catalog (categories/products/tables)
      // and the remote read model (open orders + tickets) come straight
      // from SQLite on mount. The schedulers fill them shortly after.
      await Promise.all([
        useCatalog.getState().refreshFromDb(engine.exec),
        useRemote.getState().refreshFromDb(engine.exec),
      ]);

      unsubscribeBootstrap = engine.onBootstrapResult((r) => {
        if (r.ok) void useCatalog.getState().refreshFromDb(engine.exec);
      });
      unsubscribePull = engine.onPullResult((r) => {
        if (r.ok) void useRemote.getState().refreshFromDb(engine.exec);
      });
    })();

    return () => {
      cancelled = true;
      unsubscribeBootstrap?.();
      unsubscribePull?.();
    };
  }, []);
}
