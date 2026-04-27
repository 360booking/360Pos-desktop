import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We intercept initDb so the debugLog module can be tested without Tauri.
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
    await mod.loadDebugFlag();
    expect(mod.isDebugEnabled()).toBe(false);
    mod.dbg('test', 'message', { x: 1 });
    // microtask drain
    await Promise.resolve();
    expect(inserts.length).toBe(0);
  });

  it('ON — dbg() inserts a row to device_logs', async () => {
    const mod = await import('../debugLog');
    await mod.setDebugEnabled(true);
    expect(mod.isDebugEnabled()).toBe(true);
    mod.dbg('runAction', 'newOrder ▶', { tableId: 't-5' });
    // wait for the fire-and-forget insert
    await new Promise((r) => setTimeout(r, 10));
    expect(inserts.length).toBe(1);
    expect(inserts[0].params[0]).toBe('debug');
    expect(inserts[0].params[1]).toBe('runAction');
    expect(inserts[0].params[2]).toBe('newOrder ▶');
    expect(JSON.parse(String(inserts[0].params[3]))).toMatchObject({ tableId: 't-5' });
  });

  it('dbgError ALWAYS persists, even when toggle OFF', async () => {
    const mod = await import('../debugLog');
    await mod.loadDebugFlag();
    expect(mod.isDebugEnabled()).toBe(false);
    mod.dbgError('runAction', 'boom', { code: 'X' });
    await new Promise((r) => setTimeout(r, 10));
    expect(inserts.length).toBe(1);
    expect(inserts[0].params[0]).toBe('error');
  });

  it('toggle persists across loads', async () => {
    const mod1 = await import('../debugLog');
    await mod1.setDebugEnabled(true);
    // Re-import simulates restart.
    vi.resetModules();
    const mod2 = await import('../debugLog');
    expect(mod2.isDebugEnabled()).toBe(false); // cached state cleared
    await mod2.loadDebugFlag();
    expect(mod2.isDebugEnabled()).toBe(true);
  });

  it('instrument wraps and logs entry/exit/exception when ON', async () => {
    const mod = await import('../debugLog');
    await mod.setDebugEnabled(true);

    const wrapped = mod.instrument('test', 'addOne', async (n: number) => n + 1);
    const out = await wrapped(2);
    expect(out).toBe(3);
    await new Promise((r) => setTimeout(r, 10));
    // 2 inserts: entry + exit
    expect(inserts.filter((i) => i.params[1] === 'test').length).toBeGreaterThanOrEqual(2);

    inserts.length = 0;
    const failing = mod.instrument('test', 'fail', async () => {
      throw new Error('nope');
    });
    await expect(failing()).rejects.toThrow('nope');
    await new Promise((r) => setTimeout(r, 10));
    // entry + error
    const errs = inserts.filter((i) => i.params[0] === 'error');
    expect(errs.length).toBe(1);
  });
});
