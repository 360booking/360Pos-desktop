/**
 * Recovery tray store — Sprint 8.
 */
import { create } from 'zustand';
import {
  insertCardRecovery,
  listCardRecoveries,
  resolveCardRecovery,
  type CardRecoveryRow,
  type CardRecoveryStatus,
  type InsertCardRecovery,
} from '@/lib/db/cardRecovery';
import type { SqlExecutor } from '@/lib/db/executor';

interface RecoveryState {
  rows: CardRecoveryRow[];
  refresh: (exec: SqlExecutor) => Promise<void>;
  raise: (exec: SqlExecutor, rec: InsertCardRecovery) => Promise<void>;
  resolve: (
    exec: SqlExecutor,
    id: string,
    status: CardRecoveryStatus,
    note?: string,
  ) => Promise<void>;
}

export const useRecovery = create<RecoveryState>((set, get) => ({
  rows: [],
  refresh: async (exec) => {
    const rows = await listCardRecoveries(exec, 'open');
    set({ rows });
  },
  raise: async (exec, rec) => {
    await insertCardRecovery(exec, rec);
    await get().refresh(exec);
  },
  resolve: async (exec, id, status, note) => {
    await resolveCardRecovery(exec, id, status, note);
    await get().refresh(exec);
  },
}));
