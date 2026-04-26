/**
 * Remote-cache store (open orders + kitchen tickets from /api/pos/sync/pull).
 * Sprint 6.
 */
import { create } from 'zustand';
import { readRemoteSnapshot, type RemoteSnapshot } from '@/lib/db/remoteQueries';
import type { SqlExecutor } from '@/lib/db/executor';

interface RemoteState extends RemoteSnapshot {
  hydrated: boolean;
  refreshing: boolean;
  refreshFromDb: (exec: SqlExecutor) => Promise<void>;
}

const EMPTY: RemoteSnapshot = { orders: [], items: [], tickets: [] };

export const useRemote = create<RemoteState>((set) => ({
  ...EMPTY,
  hydrated: false,
  refreshing: false,
  refreshFromDb: async (exec) => {
    set({ refreshing: true });
    try {
      const snap = await readRemoteSnapshot(exec);
      set({ ...snap, hydrated: true, refreshing: false });
    } catch (err) {
      console.warn('[remote] refreshFromDb failed:', err);
      set({ refreshing: false });
    }
  },
}));
