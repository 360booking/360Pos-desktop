import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: number;
  level: string;
  source: string;
  message: string;
  context_json: string | null;
  created_at: string;
  shipped_at: string | null;
}

let rows: Row[] = [];
let nextId = 1;

vi.mock('@/lib/db', () => ({
  initDb: vi.fn(async () => ({
    select: vi.fn(async (sql: string) => {
      if (/COUNT\(\*\) AS n FROM device_logs WHERE shipped_at IS NULL/.test(sql)) {
        return [{ n: rows.filter((r) => r.shipped_at === null).length }];
      }
      if (/SELECT shipped_at FROM device_logs WHERE shipped_at IS NOT NULL/.test(sql)) {
        const shipped = rows.filter((r) => r.shipped_at !== null);
        if (shipped.length === 0) return [];
        return [{ shipped_at: shipped[shipped.length - 1].shipped_at }];
      }
      if (/SELECT id, level, source, message/.test(sql)) {
        return rows.filter((r) => r.shipped_at === null).slice(0, 200);
      }
      return [];
    }),
    execute: vi.fn(async (sql: string, params: unknown[]) => {
      if (/UPDATE device_logs SET shipped_at = \?/.test(sql)) {
        const ts = String(params[0]);
        const ids = (params.slice(1) as number[]).map(Number);
        for (const r of rows) {
          if (ids.includes(r.id)) r.shipped_at = ts;
        }
        return { rowsAffected: ids.length, lastInsertId: 0 };
      }
      if (/DELETE FROM device_logs/.test(sql)) {
        // Only prune when we already have more than the keep-budget shipped.
        // The real query keeps the most-recent N shipped rows; in tests
        // with a few rows this is a no-op.
        const keep = Number(params[0] ?? 1000);
        const shipped = rows.filter((r) => r.shipped_at !== null);
        if (shipped.length <= keep) return { rowsAffected: 0, lastInsertId: 0 };
        const cutoffId = shipped.sort((a, b) => b.id - a.id).slice(0, keep).pop()!.id;
        const before = rows.length;
        rows = rows.filter((r) => r.shipped_at === null || r.id >= cutoffId);
        return { rowsAffected: before - rows.length, lastInsertId: 0 };
      }
      return { rowsAffected: 0, lastInsertId: 0 };
    }),
    transaction: vi.fn(),
  })),
}));

vi.mock('@/lib/auth/storage', () => ({
  getDeviceId: vi.fn(async () => 'POS-test'),
}));

vi.mock('@/lib/api/diagnostics', () => ({
  postDiagnosticsDump: vi.fn(async (body: { logs: unknown[] }) => ({ accepted: body.logs.length })),
}));

beforeEach(() => {
  rows = [];
  nextId = 1;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seed(n: number) {
  for (let i = 0; i < n; i += 1) {
    rows.push({
      id: nextId++,
      level: 'debug',
      source: 'test',
      message: `m-${i}`,
      context_json: null,
      created_at: new Date().toISOString(),
      shipped_at: null,
    });
  }
}

describe('shipper', () => {
  it('flushNow returns 0 attempted when nothing pending', async () => {
    const { flushNow } = await import('../shipper');
    const out = await flushNow();
    expect(out.attempted).toBe(0);
    expect(out.shipped).toBe(0);
    expect(out.errored).toBe(false);
  });

  it('flushNow ships pending rows and marks them shipped', async () => {
    seed(3);
    const { flushNow } = await import('../shipper');
    const out = await flushNow('1.0.0');
    expect(out.attempted).toBe(3);
    expect(out.shipped).toBe(3);
    expect(out.errored).toBe(false);
    expect(rows.filter((r) => r.shipped_at !== null).length).toBe(3);
  });

  it('readPendingDumpCount excludes shipped rows', async () => {
    seed(5);
    const { flushNow, readPendingDumpCount } = await import('../shipper');
    expect(await readPendingDumpCount()).toBe(5);
    await flushNow();
    expect(await readPendingDumpCount()).toBe(0);
  });

  it('reports errored=true when backend post throws', async () => {
    seed(1);
    const { postDiagnosticsDump } = await import('@/lib/api/diagnostics');
    (postDiagnosticsDump as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('500'));
    const { flushNow } = await import('../shipper');
    const out = await flushNow();
    expect(out.errored).toBe(true);
    expect(out.shipped).toBe(0);
    // row stays unshipped — eligible for next flush
    expect(rows[0].shipped_at).toBe(null);
  });
});
