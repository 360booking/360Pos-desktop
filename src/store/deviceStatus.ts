import { create } from 'zustand';

export type StatusLevel = 'ok' | 'warn' | 'error' | 'unknown';
export type TransportMode = 'in-memory' | 'http' | 'noop' | 'unknown';

export interface SyncStats {
  pending: number;
  processing: number;
  failed: number;
  dead: number;
  outboxDepth: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
}

const ZERO_SYNC: SyncStats = {
  pending: 0,
  processing: 0,
  failed: 0,
  dead: 0,
  outboxDepth: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
};

export interface DeviceStatusSlice {
  backend: StatusLevel;
  backendLatencyMs: number | null;
  db: StatusLevel;
  fiscal: StatusLevel;
  payment: StatusLevel;
  printer: StatusLevel;
  online: boolean;
  /** Outbox depth — kept as a top-level field for the StatusBar pill. */
  queueDepth: number;
  sync: SyncStats;
  transportMode: TransportMode;
  setBackend: (level: StatusLevel, latencyMs?: number | null) => void;
  setDb: (level: StatusLevel) => void;
  setFiscal: (level: StatusLevel) => void;
  setPayment: (level: StatusLevel) => void;
  setPrinter: (level: StatusLevel) => void;
  setOnline: (online: boolean) => void;
  setQueueDepth: (n: number) => void;
  setSync: (stats: Partial<SyncStats>) => void;
  setTransportMode: (mode: TransportMode) => void;
}

export const useDeviceStatus = create<DeviceStatusSlice>((set) => ({
  backend: 'unknown',
  backendLatencyMs: null,
  db: 'unknown',
  fiscal: 'unknown',
  payment: 'unknown',
  printer: 'unknown',
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  queueDepth: 0,
  sync: { ...ZERO_SYNC },
  transportMode: 'unknown',
  setBackend: (backend, backendLatencyMs = null) =>
    set({ backend, backendLatencyMs }),
  setDb: (db) => set({ db }),
  setFiscal: (fiscal) => set({ fiscal }),
  setPayment: (payment) => set({ payment }),
  setPrinter: (printer) => set({ printer }),
  setOnline: (online) => set({ online }),
  setQueueDepth: (queueDepth) => set({ queueDepth }),
  setSync: (partial) =>
    set((s) => {
      const next = { ...s.sync, ...partial };
      return { sync: next, queueDepth: next.outboxDepth };
    }),
  setTransportMode: (transportMode) => set({ transportMode }),
}));
