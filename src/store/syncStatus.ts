/**
 * Live counts of `local_payment_outbox` rows by status, refreshed by
 * the sync worker after every tick. UI components read from here for:
 *   - the "X plăți nesincronizate" badge in the StatusBar;
 *   - the persistent alert when any row is `failed`;
 *   - the per-order overlay flag on cached orders.
 */
import { create } from 'zustand';

import type { OutboxCounts } from '@/lib/db/localPaymentOutbox';

interface SyncStatusSlice {
  pending: number;
  syncing: number;
  failed: number;
  synced: number;
  /** ISO timestamp of the last successful sync attempt (for "Plată
   *  sincronizată cu succes" toasts). */
  lastSyncAt: string | null;
  setCounts: (next: OutboxCounts) => void;
  noteSyncSuccess: () => void;
}

export const useSyncStatus = create<SyncStatusSlice>((set) => ({
  pending: 0,
  syncing: 0,
  failed: 0,
  synced: 0,
  lastSyncAt: null,
  setCounts: (next) =>
    set({
      pending: next.pending,
      syncing: next.syncing,
      failed: next.failed,
      synced: next.synced,
    }),
  noteSyncSuccess: () => set({ lastSyncAt: new Date().toISOString() }),
}));

export function unsyncedCount(state: SyncStatusSlice): number {
  return state.pending + state.syncing + state.failed;
}
