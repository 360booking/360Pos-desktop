import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sprint 11.5 — debugLog is RAM-only. The only DB touch is the
// settings.debug.enabled toggle (rare). dbg() / dbgError() must NOT
// call any DB executor under any circumstance.

const dbExecCalls: string[] = [];
const dbSelectCalls: string[] = [];
const settingsStore: Map<string, string> = new Map();

vi.mock('@/lib/db', () => ({
  initDb: vi.fn(async () => ({
    select: vi.fn(async (sql: string, params: unknown[]) => {
      dbSelectCalls.push(sql);
      if (/FROM settings WHERE key = \?/.test(sql)) {
        const k = String(params[0]);
        const v = settingsStore.get(k);
        return v == null ? [] : [{ value_json: v }];
      }
      return [];
    }),
    execute: vi.fn(async (sql: string, params: unknown[]) => {
      dbExecCalls.push(sql);
      if (/INSERT INTO settings/.test(sql)) {
        settingsStore.set(String(params[0]), String(params[1]));
        return { rowsAffected: 1, lastInsertId: 1 };
      }
      return { rowsAffected: 0, lastInsertId: 0 };
    }),
    transaction: vi.fn(),
  })),
}));

beforeEach(() => {
  dbExecCalls.length = 0;
  dbSelectCalls.length = 0;
  settingsStore.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('debugLog (Sprint 11.5 RAM-only)', () => {
  it('dbg() never calls db.execute or db.select', async () => {
    const mod = await import('../debugLog');
    await mod.setDebugEnabled(true);
    dbExecCalls.length = 0;
    dbSelectCalls.length = 0;
    for (let i = 0; i < 100; i += 1) mod.dbg('x', `m-${i}`, { i });
    expect(dbExecCalls).toEqual([]);
    expect(dbSelectCalls).toEqual([]);
  });

  it('dbgError() never calls db.execute or db.select', async () => {
    const mod = await import('../debugLog');
    dbExecCalls.length = 0;
    dbSelectCalls.length = 0;
    for (let i = 0; i < 100; i += 1) mod.dbgError('x', `m-${i}`, { i });
    expect(dbExecCalls).toEqual([]);
    expect(dbSelectCalls).toEqual([]);
  });

  it('dbg is no-op when toggle OFF', async () => {
    const mod = await import('../debugLog');
    await mod.loadDebugFlag();
    expect(mod.isDebugEnabled()).toBe(false);
    mod.dbg('x', 'should not appear');
    expect(mod.readRingBuffer()).toEqual([]);
    expect(mod.readRingBufferCount()).toBe(0);
  });

  it('dbg pushes to ring buffer when toggle ON', async () => {
    const mod = await import('../debugLog');
    await mod.setDebugEnabled(true);
    mod.dbg('runAction', 'newOrder ▶', { tableId: 't-5' });
    const ring = mod.readRingBuffer();
    expect(ring.length).toBe(1);
    expect(ring[0].source).toBe('runAction');
    expect(ring[0].message).toBe('newOrder ▶');
    expect(ring[0].context).toMatchObject({ tableId: 't-5' });
    expect(ring[0].level).toBe('debug');
  });

  it('dbgError pushes to ring even when toggle OFF', async () => {
    const mod = await import('../debugLog');
    await mod.loadDebugFlag();
    expect(mod.isDebugEnabled()).toBe(false);
    mod.dbgError('runAction', 'boom', { code: 'X' });
    expect(mod.readRingBufferCount()).toBe(1);
    expect(mod.readRingBuffer()[0].level).toBe('error');
  });

  it('ring buffer is bounded at RING_BUFFER_MAX (5000)', async () => {
    const mod = await import('../debugLog');
    await mod.setDebugEnabled(true);
    for (let i = 0; i < mod.RING_BUFFER_MAX + 200; i += 1) {
      mod.dbg('x', `m-${i}`);
    }
    expect(mod.readRingBufferCount()).toBe(mod.RING_BUFFER_MAX);
    // Oldest dropped — first remaining message should NOT be m-0.
    expect(mod.readRingBuffer()[0].message).not.toBe('m-0');
  });

  it('clearRingBuffer empties everything', async () => {
    const mod = await import('../debugLog');
    await mod.setDebugEnabled(true);
    mod.dbg('x', 'a');
    mod.dbg('x', 'b');
    expect(mod.readRingBufferCount()).toBe(2);
    mod.clearRingBuffer();
    expect(mod.readRingBufferCount()).toBe(0);
  });

  it('toggle persists across module reloads (only DB write allowed)', async () => {
    const mod1 = await import('../debugLog');
    await mod1.setDebugEnabled(true);
    expect(dbExecCalls.length).toBe(1); // exactly one settings INSERT
    expect(dbExecCalls[0]).toMatch(/INSERT INTO settings/);
    vi.resetModules();
    const mod2 = await import('../debugLog');
    expect(mod2.isDebugEnabled()).toBe(false);
    await mod2.loadDebugFlag();
    expect(mod2.isDebugEnabled()).toBe(true);
  });

  it('instrument logs entry/exit/error to ring without DB', async () => {
    const mod = await import('../debugLog');
    await mod.setDebugEnabled(true);
    dbExecCalls.length = 0;
    const wrapped = mod.instrument('test', 'op', async () => 42);
    expect(await wrapped()).toBe(42);
    expect(dbExecCalls).toEqual([]);
    expect(mod.readRingBufferCount()).toBeGreaterThanOrEqual(2);
    const failing = mod.instrument('test', 'fail', async () => {
      throw new Error('nope');
    });
    await expect(failing()).rejects.toThrow('nope');
    expect(dbExecCalls).toEqual([]);
    expect(mod.readRingBuffer().filter((r) => r.level === 'error').length).toBe(1);
  });
});
