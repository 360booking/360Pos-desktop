/**
 * Catalog store — Sprint 4 / 2.
 *
 * Holds the catalog snapshot the menu/tables panes render. The bootstrap
 * scheduler refreshes it on every successful hydrate; the PosShell hook
 * also refreshes it on mount so a freshly-paired desktop shows menu
 * data without an explicit click.
 */
import { create } from 'zustand';
import { readCatalog, type CatalogSnapshot } from '@/lib/db/catalogQueries';
import type { SqlExecutor } from '@/lib/db/executor';

export interface CatalogState extends CatalogSnapshot {
  hydrated: boolean;
  refreshing: boolean;
  /** Replace the entire snapshot (called from refreshFromDb / scheduler). */
  setSnapshot: (s: CatalogSnapshot) => void;
  /** Read fresh rows from the local SQLite + push them into the store. */
  refreshFromDb: (exec: SqlExecutor) => Promise<void>;
}

const EMPTY: CatalogSnapshot = {
  categories: [],
  products: [],
  tables: [],
  lastSuccessfulAt: null,
  restaurantName: null,
};

export const useCatalog = create<CatalogState>((set) => ({
  ...EMPTY,
  hydrated: false,
  refreshing: false,
  setSnapshot: (s) => set({ ...s, hydrated: true, refreshing: false }),
  refreshFromDb: async (exec: SqlExecutor) => {
    set({ refreshing: true });
    try {
      const snap = await readCatalog(exec);
      set({ ...snap, hydrated: true, refreshing: false });
    } catch (err) {
      // We swallow the error — the previous snapshot stays in place.
      console.warn('[catalog] refreshFromDb failed:', err);
      set({ refreshing: false });
    }
  },
}));
