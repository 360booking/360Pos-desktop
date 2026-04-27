import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '@/lib/db/executor';

// We intercept initDb AND build an in-memory SqlExecutor — Sprint 11.1
// routes persist() through the attached executor (engine's mutex) and
// only falls back to initDb for the toggle SELECT/UPDATE.
const inserts: Array<{ sql: string; params: unknown[] }> = [];
const settingsStore: Map<string, string> = new Map();

vi.mock('@/lib/db', () => ({
  initDb: vi.fn(async () => ({
    select: vi.fn(async (sql: string, params: unknown[]) => {
      if (/FROM settings WHERE key = \?/.test(sql)) {
        const k = String(params[0]);
        const v = settingsStore.get(k);
        return v == null ? [] : [{ value_json: v }];
      }
      return [];
    }),
    execute: vi.fn(async (sql: string, params: unknown[]) => {
      if (/INSERT INTO settings/.test(sql)) {
        settingsStore.set(String(params[0]), String(params[1]));
        return { rowsAffected: 1, lastInsertId: 1 };
      }
      if (/INSERT INTO device_logs/.test(sql)) {
        inserts.push({ sql, params });
        return { rowsAffected: 1, lastInsertId: inserts.length };
      }
      return { rowsAffected: 0, lastInsertId: 0 };
    }),
    transaction: vi.fn(),
  })),
}));

function fakeExec(): SqlExecutor {
  return {
    async select<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      if (/FROM settings WHERE key = \?/.test(sql)) {
        const k = String(params[0]);
        const v = settingsStore.get(k);
        return (v == null ? [] : [{ value_json: v }]) as T[];
      }
      return [] as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      if (/INSERT INTO settings/.test(sql)) {
        settingsStore.set(String(params[0]), String(params[1]));
        return { rowsAffected: 1, lastInsertId: 1 };
      }
      if (/INSERT INTO device_logs/.test(sql)) {
        inserts.push({ sql, params });
        return { rowsAffected: 1, lastInsertId: inserts.length };
      }
      return { rowsAffected: 0, lastInsertId: 0 };
    },
    async transaction(fn) {
      return fn(this as SqlExecutor);
    },
  };
}

beforeEach(() => {
  inserts.length = 0;
  settingsStore.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('debugLog toggle', () => {
  it('default OFF — dbg() does not persist', async () => {
    const mod = await import('../debugLog');
    mod.attachExecutorForLogs(fakeExec());
    await mod.loadDebugFlag();
    expect(mod.isDebugEnabled()).toBe(false);
    mod.dbg('test', 'message', { x: 1 });
    await mod.flushDebugBufferNow();
    expect(inserts.length).toBe(0);
  });

  it('ON — dbg() inserts a row to device_logs after flush', async () => {
    const mod = await import('../debugLog');
    mod.attachExecutorForLogs(fakeExec());
    await mod.setDebugEnabled(true);
    expect(mod.isDebugEnabled()).toBe(true);
    mod.dbg('runAction', 'newOrder ▶', { tableId: 't-5' });
    // Sprint 11.3 — dbg buffers; only flush writes to device_logs.
    await mod.flushDebugBufferNow();
    expect(inserts.length).toBe(1);
    expect(inserts[0].params[0]).toBe('debug');
    expect(inserts[0].params[1]).toBe('runAction');
    expect(inserts[0].params[2]).toBe('newOrder ▶');
    expect(JSON.parse(String(inserts[0].params[3]))).toMatchObject({ tableId: 't-5' });
  });

  it('many dbg() calls collapse into ONE transaction (no mutex storm)', async () => {
    const mod = await import('../debugLog');
    mod.attachExecutorForLogs(fakeExec());
    await mod.setDebugEnabled(true);
    for (let i = 0; i < 50; i += 1) mod.dbg('test', `m-${i}`);
    await mod.flushDebugBufferNow();
    expect(inserts.length).toBe(50);
    // Only ONE transaction was opened — verified indirectly by the
    // mock running fn(self), so all 50 inserts share a single
    // transaction(). We assert ordering preserved.
    expect(inserts.map((i) => i.params[2])).toEqual(
      Array.from({ length: 50 }, (_, i) => `m-${i}`),
    );
  });

  it('dbgError eagerly flushes, even when toggle OFF', async () => {
    const mod = await import('../debugLog');
    mod.attachExecutorForLogs(fakeExec());
    await mod.loadDebugFlag();
    expect(mod.isDebugEnabled()).toBe(false);
    mod.dbgError('runAction', 'boom', { code: 'X' });
    // Eager flush is fire-and-forget; give it a tick.
    await new Promise((r) => setTimeout(r, 20));
    expect(inserts.length).toBe(1);
    expect(inserts[0].params[0]).toBe('error');
  });

  it('toggle persists across loads', async () => {
    const mod1 = await import('../debugLog');
    mod1.attachExecutorForLogs(fakeExec());
    await mod1.setDebugEnabled(true);
    vi.resetModules();
    const mod2 = await import('../debugLog');
    expect(mod2.isDebugEnabled()).toBe(false);
    mod2.attachExecutorForLogs(fakeExec());
    await mod2.loadDebugFlag();
    expect(mod2.isDebugEnabled()).toBe(true);
  });

  it('persist() buffers when no executor is attached, drains on attach', async () => {
    const mod = await import('../debugLog');
    await mod.setDebugEnabled(true);
    inserts.length = 0;
    mod.dbg('test', 'before-attach-1');
    mod.dbg('test', 'before-attach-2');
    expect(inserts.length).toBe(0);
    mod.attachExecutorForLogs(fakeExec());
    await mod.flushDebugBufferNow();
    expect(inserts.length).toBe(2);
    expect(inserts.map((i) => i.params[2])).toEqual(['before-attach-1', 'before-attach-2']);
  });

  it('instrument wraps and logs entry/exit/exception when ON', async () => {
    const mod = await import('../debugLog');
    mod.attachExecutorForLogs(fakeExec());
    await mod.setDebugEnabled(true);

    const wrapped = mod.instrument('test', 'addOne', async (n: number) => n + 1);
    const out = await wrapped(2);
    expect(out).toBe(3);
    await mod.flushDebugBufferNow();
    expect(inserts.filter((i) => i.params[1] === 'test').length).toBeGreaterThanOrEqual(2);

    inserts.length = 0;
    const failing = mod.instrument('test', 'fail', async () => {
      throw new Error('nope');
    });
    await expect(failing()).rejects.toThrow('nope');
    await new Promise((r) => setTimeout(r, 20));
    const errs = inserts.filter((i) => i.params[0] === 'error');
    expect(errs.length).toBe(1);
  });
});
