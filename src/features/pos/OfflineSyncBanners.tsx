/**
 * Top-of-shell banners + status badges for offline / unsynced state.
 * Faza 2.
 *
 * Three layers:
 *   - OfflineBanner — soft pill at the top when reachability is false.
 *   - UnsyncedAlert — persistent (red) alert when at least one outbox
 *                     row is in `failed`. Operator must triage from
 *                     /admin/payments or click "Reîncearcă" if exposed.
 *   - UnsyncedBadge — compact pill that the StatusBar can reuse showing
 *                     pending/syncing counts.
 */
import { AlertTriangle, CloudOff, RefreshCw } from 'lucide-react';

import { useReachability } from '@/lib/reachability';
import { useSyncStatus } from '@/store/syncStatus';
import { getSyncEngine } from '@/lib/sync/bootstrap';

export function OfflineBanner() {
  const { online, consecutiveFailures } = useReachability();
  const failed = useSyncStatus((s) => s.failed);
  if (online) return null;
  return (
    <div
      role="status"
      className="px-4 py-2 bg-amber-500/15 border-b border-amber-400/30 text-amber-100 text-[13px] flex items-center gap-2"
    >
      <CloudOff className="h-4 w-4 flex-shrink-0" />
      <span className="flex-1">
        Offline: comenzile sunt afișate din cache. Plățile cash vor fi
        sincronizate când revine internetul.
        {consecutiveFailures > 0 && (
          <span className="text-amber-300/80 ml-1">
            ({consecutiveFailures} încercări nereușite)
          </span>
        )}
      </span>
      {failed > 0 && (
        <span className="text-rose-200 font-semibold">
          {failed} plăți eșuate.
        </span>
      )}
    </div>
  );
}

export function UnsyncedAlert() {
  const failed = useSyncStatus((s) => s.failed);
  if (failed === 0) return null;
  function retryNow() {
    const engine = getSyncEngine();
    if (!engine) return;
    // Dynamic import keeps this UI chunk free of the worker module
    // during initial bundle parse; the worker is small but it's
    // referenced here only on the manual-retry click path.
    void import('@/lib/sync/localPaymentSyncWorker').then(({ runSyncTick }) =>
      runSyncTick({ exec: engine.exec }),
    );
  }
  return (
    <div
      role="alert"
      className="px-4 py-2 bg-rose-500/15 border-b border-rose-400/40 text-rose-100 text-[13px] flex items-center gap-2"
    >
      <AlertTriangle className="h-4 w-4 flex-shrink-0" />
      <span className="flex-1">
        Există {failed} plăți cash fiscalizate local, nesincronizate cu
        serverul. Verifică manual și reîncearcă.
      </span>
      <button
        type="button"
        onClick={retryNow}
        className="inline-flex items-center gap-1.5 rounded-md border border-rose-400/40 bg-rose-500/10 px-2 py-1 text-[11px] font-semibold text-rose-100 hover:bg-rose-500/20"
      >
        <RefreshCw className="h-3 w-3" /> Reîncearcă acum
      </button>
    </div>
  );
}

export function UnsyncedBadge() {
  const pending = useSyncStatus((s) => s.pending);
  const syncing = useSyncStatus((s) => s.syncing);
  const failed = useSyncStatus((s) => s.failed);
  const total = pending + syncing + failed;
  if (total === 0) return null;
  const tone =
    failed > 0
      ? 'bg-rose-500/15 text-rose-200 border-rose-400/40'
      : 'bg-amber-500/15 text-amber-200 border-amber-400/40';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${tone}`}
      title={`pending=${pending}, syncing=${syncing}, failed=${failed}`}
    >
      <CloudOff className="h-3 w-3" />
      {total} nesincronizate
    </span>
  );
}
