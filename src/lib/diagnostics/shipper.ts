/**
 * Sprint 11.5 — diagnostic ship is RAM-only + manual.
 *
 * The shipper now reads from the in-memory ring buffer in debugLog.ts
 * and POSTs the snapshot to /api/pos/diagnostics/dump. It does NOT
 * touch device_logs (or any operational SQLite table). The "Trimite
 * loguri" button in Settings → Diagnostic is the ONE entry point —
 * there is no auto-shipper any more.
 *
 * Failures are swallowed: diagnostics is best-effort and must never
 * backpressure the production path.
 */
import { logger, getRecentLogEntries, clearLogEntries, type LogEntry } from '@/lib/logger';
import { postDiagnosticsDump, type DumpLogLine } from '@/lib/api/diagnostics';
import { getDeviceId } from '@/lib/auth/storage';
import { readRingBuffer, clearRingBuffer, type RingLog } from '@/lib/debugLog';

/**
 * Merge the two in-memory log buffers we keep:
 *   - debugLog._ring (5000 cap) — populated only when verbose toggle ON
 *     via dbg() / dbgError().
 *   - logger._entries (500 cap) — populated unconditionally by
 *     logger.info/warn/error (the ones the operator sees in the live tail
 *     and that contain timeout/sqlite-locked diagnostics).
 *
 * Returns a single timestamp-sorted list so Copy / Export / Ship operate
 * on everything that's actually in memory, not just the debug-toggle
 * subset.
 */
function combinedBuffer(): RingLog[] {
  const ring = readRingBuffer();
  const live: RingLog[] = getRecentLogEntries().map((e: LogEntry) => ({
    ts: e.ts,
    level: e.level,
    source: e.source,
    message: e.message,
    context:
      e.ctx == null
        ? null
        : typeof e.ctx === 'object' && !Array.isArray(e.ctx)
          ? (e.ctx as Record<string, unknown>)
          : { value: e.ctx as unknown },
  }));
  const all = ring.concat(live);
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return all;
}

export interface FlushOutcome {
  attempted: number;
  shipped: number;
  errored: boolean;
  errorMessage?: string;
}

let _lastShippedAt: string | null = null;
let _lastShippedCount = 0;

export function readPendingDumpCount(): number {
  return combinedBuffer().length;
}

export function readLastShippedAt(): string | null {
  return _lastShippedAt;
}

export function readLastShippedCount(): number {
  return _lastShippedCount;
}

export async function flushNow(appVersion?: string): Promise<FlushOutcome> {
  const buffer = combinedBuffer();
  if (buffer.length === 0) {
    return { attempted: 0, shipped: 0, errored: false };
  }
  const deviceId = await getDeviceId().catch(() => null);
  const logs: DumpLogLine[] = buffer.map((r) => ({
    level: r.level,
    source: r.source,
    message: r.message,
    context: r.context,
    createdAt: r.ts,
  }));
  try {
    const out = await postDiagnosticsDump({
      logs,
      deviceId,
      appVersion: appVersion ?? null,
    });
    _lastShippedAt = new Date().toISOString();
    _lastShippedCount = out.accepted;
    // Best-effort drain: clear both buffers. A handful of lines that
    // landed between the snapshot and the ack are sacrificed —
    // diagnostics is sampling, not audit.
    clearRingBuffer();
    clearLogEntries();
    return { attempted: buffer.length, shipped: out.accepted, errored: false };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.warn('shipper', 'flushNow failed', { message });
    return {
      attempted: buffer.length,
      shipped: 0,
      errored: true,
      errorMessage: message,
    };
  }
}

/** Build a paste-friendly text export of the current buffer. */
export function exportLogsAsText(): string {
  const buffer = combinedBuffer();
  if (buffer.length === 0) return '';
  return buffer
    .map((r) => {
      const ctx = r.context ? ' ' + JSON.stringify(r.context) : '';
      return `${r.ts} [${r.level}] ${r.source}: ${r.message}${ctx}`;
    })
    .join('\n');
}

// ─── Sprint 11.5 — auto-shipper removed entirely.
// The previous setInterval(flushNow, 30_000) made unsolicited writes
// to device_logs and POST requests; both are gone. The exports below
// are kept as stub no-ops so the engine startup path doesn't need to
// change.
export function startShipper(_intervalMs?: number): () => void {
  return () => undefined;
}
export function stopShipper(): void {
  // no-op in 11.5
}
export function isShipperRunning(): boolean {
  return false;
}
