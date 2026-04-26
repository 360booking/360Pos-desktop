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
import { startSyncEngine, getSyncEngine } from '@/lib/sync/bootstrap';
import { useCatalog } from '@/store/catalog';

export function useCatalogBootstrap() {
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    (async () => {
      const engine = getSyncEngine() ?? (await startSyncEngine());
      if (cancelled || !engine) return;

      // Initial load from whatever's already in SQLite. If this is a
      // fresh install the tables are empty — the foreground bootstrap
      // inside startSyncEngine() will fire onBootstrapResult shortly
      // after, and we'll re-read.
      await useCatalog.getState().refreshFromDb(engine.exec);

      unsubscribe = engine.onBootstrapResult((r) => {
        if (r.ok) void useCatalog.getState().refreshFromDb(engine.exec);
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
}
