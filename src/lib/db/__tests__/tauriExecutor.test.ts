/**
 * Sprint 10 / F — tauriExecutor mutex + retry tests.
 *
 * The executor is the single chokepoint that protects pos-desktop.db
 * from the "database is locked" pilot bug. We exercise it against a
 * fake Database stub so we don't need the Tauri shell here.
 */
import { describe, expect, it, vi } from 'vitest';

import { tauriExecutor, executorPendingDepth } from '../tauriExecutor';

interface ExecOk { rowsAffected: number; lastInsertId?: number }

function makeDb(opts: {
  /** Simulated work duration per call, ms. */
  workMs?: number;
  /** Throw `database is locked` for the first N execute() calls. */
  lockedExecuteFails?: number;
} = {}) {
  const calls: Array<{ kind: 'select' | 'execute'; sql: string; at: number }> = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  let lockedFailsLeft = opts.lockedExecuteFails ?? 0;

  async function work<T>(sleepMs: number, value: T): Promise<T> {
    inFlight += 1;
    if (inFlight > maxConcurrent) maxConcurrent = inFlight;
    try {
      if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
      return value;
    } finally {
      inFlight -= 1;
    }
  }

  const db = {
    select: vi.fn(async (sql: string, _params: unknown[] = []) => {
      calls.push({ kind: 'select', sql, at: Date.now() });
      return work(opts.workMs ?? 0, [] as unknown[]);
    }),
    execute: vi.fn(async (sql: string, _params: unknown[] = []): Promise<ExecOk> => {
      calls.push({ kind: 'execute', sql, at: Date.now() });
      if (lockedFailsLeft > 0) {
        lockedFailsLeft -= 1;
        await work(0, undefined);
        throw new Error('error returned from database: (code: 5) database is locked');
      }
      return work(opts.workMs ?? 0, { rowsAffected: 1 });
    }),
  };
  return { db, calls, maxConcurrent: () => maxConcurrent };
}

describe('tauriExecutor — FIFO mutex', () => {
  it('serialises overlapping execute() calls (max concurrency = 1)', async () => {
    const { db, maxConcurrent } = makeDb({ workMs: 30 });
    const exec = tauriExecutor(db as never);
    await Promise.all([
      exec.execute('UPDATE x SET v=1'),
      exec.execute('UPDATE x SET v=2'),
      exec.execute('UPDATE x SET v=3'),
    ]);
    expect(maxConcurrent()).toBe(1);
  });

  it('serialises a transaction against a concurrent execute()', async () => {
    const { db, calls } = makeDb({ workMs: 20 });
    const exec = tauriExecutor(db as never);
    // A transaction that does 2 writes + a concurrent execute. The
    // outer execute should NOT run between BEGIN and COMMIT.
    const txDone = exec.transaction(async (tx) => {
      await tx.execute('INSERT INTO t VALUES (1)');
      await tx.execute('INSERT INTO t VALUES (2)');
    });
    const concurrent = exec.execute('UPDATE u SET v=9');
    await Promise.all([txDone, concurrent]);

    const order = calls.filter((c) => c.kind === 'execute').map((c) => c.sql);
    const beginIdx = order.indexOf('BEGIN');
    const commitIdx = order.indexOf('COMMIT');
    const updateIdx = order.indexOf('UPDATE u SET v=9');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(beginIdx);
    // The concurrent UPDATE must not slip between BEGIN and COMMIT.
    expect(updateIdx === -1 || updateIdx < beginIdx || updateIdx > commitIdx).toBe(true);
  });

  it('one queued task throwing does not poison the chain', async () => {
    const db = {
      select: vi.fn(async () => []),
      execute: vi.fn(async (sql: string) => {
        if (sql === 'BAD') throw new Error('boom');
        return { rowsAffected: 1 };
      }),
    };
    const exec = tauriExecutor(db as never);
    await expect(exec.execute('BAD')).rejects.toThrow('boom');
    // Subsequent calls must still work.
    const ok = await exec.execute('GOOD');
    expect(ok.rowsAffected).toBe(1);
  });

  it('exposes pending depth via executorPendingDepth', async () => {
    const { db } = makeDb({ workMs: 30 });
    const exec = tauriExecutor(db as never);
    const tasks = [
      exec.execute('a'),
      exec.execute('b'),
      exec.execute('c'),
    ];
    // We expect at least 1 pending right after enqueue (the head is
    // running, others wait). Microtask flush is enough to start the
    // first one.
    await Promise.resolve();
    expect(executorPendingDepth(exec)).toBeGreaterThanOrEqual(1);
    await Promise.all(tasks);
    expect(executorPendingDepth(exec)).toBe(0);
  });
});

describe('tauriExecutor — retry on database is locked', () => {
  it('retries an execute() that throws SQLITE_BUSY then succeeds', async () => {
    const { db } = makeDb({ lockedExecuteFails: 2 });
    const exec = tauriExecutor(db as never);
    const out = await exec.execute('UPDATE x SET v=1');
    expect(out.rowsAffected).toBe(1);
    // First two attempts threw; the third returned ok. So .execute was
    // called 3 times for this single operation.
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it('gives up after the retry budget and propagates the lock error', async () => {
    const db = {
      select: vi.fn(async () => []),
      execute: vi.fn(async () => {
        throw new Error('database is locked (code: 5)');
      }),
    };
    const exec = tauriExecutor(db as never);
    await expect(exec.execute('UPDATE x SET v=1')).rejects.toThrow(/locked/);
    // 1 initial + 3 retries = 4 calls.
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it('non-locked errors are NOT retried', async () => {
    const db = {
      select: vi.fn(async () => []),
      execute: vi.fn(async () => {
        throw new Error('FOREIGN KEY constraint failed');
      }),
    };
    const exec = tauriExecutor(db as never);
    await expect(exec.execute('INSERT INTO t')).rejects.toThrow(/FOREIGN KEY/);
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
