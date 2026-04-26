/**
 * React hook that polls the event store and feeds counts into the
 * device-status store. Used by StatusBar.
 */
import { useEffect, useRef } from 'react';
import { useDeviceStatus, type TransportMode } from '@/store/deviceStatus';
import type { EventStore } from './eventStore';
import type { SyncTransport } from './transport';

export interface UseSyncStatusArgs {
  store: EventStore | null;
  transport: SyncTransport | null;
  /** Poll interval. Default 2s. */
  intervalMs?: number;
}

export function useSyncStatus({
  store,
  transport,
  intervalMs = 2_000,
}: UseSyncStatusArgs): void {
  const setSync = useDeviceStatus((s) => s.setSync);
  const setTransportMode = useDeviceStatus((s) => s.setTransportMode);
  const lastSnapshotRef = useRef<string>('');

  useEffect(() => {
    setTransportMode((transport?.id as TransportMode) ?? 'unknown');
  }, [transport, setTransportMode]);

  useEffect(() => {
    if (!store) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const c = await store.counts();
        if (cancelled) return;
        const snap = `${c.pending}|${c.processing}|${c.failed}|${c.dead}|${c.outboxDepth}`;
        if (snap === lastSnapshotRef.current) return; // skip identical writes
        lastSnapshotRef.current = snap;
        setSync({
          pending: c.pending,
          processing: c.processing,
          failed: c.failed,
          dead: c.dead,
          outboxDepth: c.outboxDepth,
        });
      } catch {
        // store may be momentarily locked; next tick retries
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [store, intervalMs, setSync]);
}
