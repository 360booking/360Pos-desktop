/**
 * Diagnostic-log shipper — Sprint 11.
 *
 * Reads unshipped rows from `device_logs`, POSTs them to
 * /api/pos/diagnostics/dump, marks them shipped, then prunes the oldest
 * shipped rows so the local table stays bounded.
 *
 * Two trigger modes:
 *   - Auto: a 30s ticker, started when debug logging is enabled.
 *   - Manual: the "Trimite loguri" button calls `flushNow()` on demand.
 *
 * Network/HTTP failures are swallowed — diagnostics is best-effort.
 */
import { initDb } from '@/lib/db';
import { logger } from '@/lib/logger';
import { postDiagnosticsDump, type DumpLogLine } from '@/lib/api/diagnostics';
import { getDeviceId } from '@/lib/auth/storage';

const BATCH_SIZE = 200;
const PRUNE_KEEP_SHIPPED = 1000; // keep last 1000 shipped rows on disk

export interface FlushOutcome {
  attempted: number;
  shipped: number;
  errored: boolean;
  errorMessage?: string;
}

interface DeviceLogRow {
  id: number;
  level: string;
  source: string;
  message: string;
  context_json: string | null;
  created_at: string;
}

export async function readPendingDumpCount(): Promise<number> {
  try {
    const db = await initDb();
    const rows = await db.select<{ n: number }[]>(
      'SELECT COUNT(*) AS n FROM device_logs WHERE shipped_at IS NULL',
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

export async function readLastShippedAt(): Promise<string | null> {
  try {
    const db = await initDb();
    const rows = await db.select<{ shipped_at: string }[]>(
      'SELECT shipped_at FROM device_logs WHERE shipped_at IS NOT NULL ORDER BY shipped_at DESC LIMIT 1',
    );
    return rows[0]?.shipped_at ?? null;
  } catch {
    return null;
  }
}

export async function flushNow(appVersion?: string): Promise<FlushOutcome> {
  let db;
  try {
    db = await initDb();
  } catch {
    return { attempted: 0, shipped: 0, errored: false };
  }

  const rows = await db.select<DeviceLogRow[]>(
    `SELECT id, level, source, message, context_json, created_at
     FROM device_logs WHERE shipped_at IS NULL ORDER BY id ASC LIMIT ?`,
    [BATCH_SIZE],
  );
  if (rows.length === 0) {
    return { attempted: 0, shipped: 0, errored: false };
  }

  const deviceId = await getDeviceId().catch(() => null);
  const logs: DumpLogLine[] = rows.map((r) => ({
    level: (r.level as DumpLogLine['level']) ?? 'info',
    source: r.source,
    message: r.message,
    context: r.context_json ? safeParse(r.context_json) : null,
    createdAt: r.created_at,
  }));

  try {
    const out = await postDiagnosticsDump({
      logs,
      deviceId,
      appVersion: appVersion ?? null,
    });
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const nowIso = new Date().toISOString();
    await db.execute(
      `UPDATE device_logs SET shipped_at = ? WHERE id IN (${placeholders})`,
      [nowIso, ...ids],
    );
    await pruneShipped(db);
    return { attempted: rows.length, shipped: out.accepted, errored: false };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.warn('shipper', 'flushNow failed', { message });
    return {
      attempted: rows.length,
      shipped: 0,
      errored: true,
      errorMessage: message,
    };
  }
}

async function pruneShipped(db: Awaited<ReturnType<typeof initDb>>): Promise<void> {
  // Keep the most recent N shipped rows so the table doesn't grow forever.
  // On a busy day with debug ON the device emits a few thousand lines —
  // 1000 retention is enough for "what just happened" triage.
  try {
    await db.execute(
      `DELETE FROM device_logs WHERE shipped_at IS NOT NULL AND id < (
         SELECT MIN(id) FROM (
           SELECT id FROM device_logs WHERE shipped_at IS NOT NULL ORDER BY id DESC LIMIT ?
         )
       )`,
      [PRUNE_KEEP_SHIPPED],
    );
  } catch {
    // best-effort
  }
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return { value: v };
  } catch {
    return { raw: s };
  }
}

let _ticker: ReturnType<typeof setInterval> | null = null;

export function startShipper(intervalMs = 30_000): () => void {
  if (_ticker) return () => stopShipper();
  _ticker = setInterval(() => {
    void flushNow();
  }, intervalMs);
  return () => stopShipper();
}

export function stopShipper(): void {
  if (_ticker) {
    clearInterval(_ticker);
    _ticker = null;
  }
}

export function isShipperRunning(): boolean {
  return _ticker !== null;
}
