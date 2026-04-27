import { describe, expect, it } from 'vitest';
import { createMemoryExecutor } from '@/lib/db/memoryExecutor';
import { createEventStore } from '../eventStore';
import type { SyncEvent } from '@/core/pos-core';

const ev = (mutation: string, order: string | null, type = 'ORDER_ITEM_ADDED'): SyncEvent => ({
  mutationId: mutation,
  type: type as never,
  localTimestamp: '2026-04-25T12:00:00.000Z',
  deviceId: 'dev-1',
  orderLocalId: order ?? '',
  orderServerId: null,
  payload: { x: 1 },
});

describe('eventStore.persistBatch', () => {
  it('writes both events and sync_outbox in one transaction', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    await store.persistBatch([ev('m1', 'o1'), ev('m2', 'o1')], '2026-04-25T12:00:00.000Z');
    const dump = exec._dump();
    expect(dump.events).toHaveLength(2);
    expect(dump.outbox).toHaveLength(2);
    expect(dump.events.every((e) => e.status === 'pending')).toBe(true);
  });

  it('is idempotent on duplicate mutation_id (no double insert, no double outbox row)', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const now = '2026-04-25T12:00:00.000Z';
    await store.persistBatch([ev('m1', 'o1')], now);
    await store.persistBatch([ev('m1', 'o1')], now); // replay
    const dump = exec._dump();
    expect(dump.events).toHaveLength(1);
    expect(dump.outbox).toHaveLength(1);
  });

  it('rolls back the whole batch when one row fails', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const now = '2026-04-25T12:00:00.000Z';
    // Pre-existing m1 — second batch attempts to mix m2 + m1 (m1 would
    // be a no-op insert; the test is more interesting if we make the
    // second insert fail). Force a failure by passing a payload that
    // can't be JSON-serialised.
    await store.persistBatch([ev('m0', 'o1')], now);
    const bad: any = { ...ev('mX', 'o1') };
    bad.payload = { circular: {} };
    bad.payload.circular.self = bad.payload;
    await expect(
      store.persistBatch([ev('mY', 'o1'), bad], now),
    ).rejects.toThrow();
    const dump = exec._dump();
    // Only the original m0 survived.
    expect(dump.events.map((e) => e.mutation_id)).toEqual(['m0']);
    expect(dump.outbox.map((o) => o.event_id)).toEqual([dump.events[0].id]);
  });

  it('counts() reflects status distribution + outbox depth', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const now = '2026-04-25T12:00:00.000Z';
    const persisted = await store.persistBatch([ev('m1', 'o1'), ev('m2', 'o2')], now);
    let c = await store.counts();
    expect(c.pending).toBe(2);
    expect(c.outboxDepth).toBe(2);
    await store.markSynced(persisted[0].id, null, now);
    c = await store.counts();
    expect(c.pending).toBe(1);
    expect(c.synced).toBe(1);
    expect(c.outboxDepth).toBe(1);
  });
});

describe('eventStore.markSynced / scheduleRetry / markFailed / markDead', () => {
  it('markSynced removes the outbox row and marks the event synced', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const [row] = await store.persistBatch([ev('m1', 'o1')], '2026-04-25T12:00:00.000Z');
    await store.markSynced(row.id, '{"v":1}', '2026-04-25T12:00:01.000Z');
    const dump = exec._dump();
    expect(dump.events[0].status).toBe('synced');
    expect(dump.outbox).toHaveLength(0);
  });

  it('scheduleRetry bumps attempts and pushes next_retry_at', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const [row] = await store.persistBatch([ev('m1', 'o1')], '2026-04-25T12:00:00.000Z');
    await store.scheduleRetry(row.id, 1, '2026-04-25T12:00:01.000Z', 'transient');
    const dump = exec._dump();
    expect(dump.events[0].status).toBe('pending');
    expect(dump.outbox[0].attempts).toBe(1);
    expect(dump.outbox[0].next_retry_at).toBe('2026-04-25T12:00:01.000Z');
  });

  it('scheduleRetry promotes to dead at MAX_ATTEMPTS', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const [row] = await store.persistBatch([ev('m1', 'o1')], '2026-04-25T12:00:00.000Z');
    await store.scheduleRetry(row.id, 50, '2026-04-25T13:00:00.000Z', 'too many');
    const dump = exec._dump();
    expect(dump.events[0].status).toBe('dead');
    expect(dump.outbox).toHaveLength(0);
  });

  it('markFailed and markDead both clear the outbox row', async () => {
    const exec = createMemoryExecutor();
    const store = createEventStore(exec);
    const [a, b] = await store.persistBatch(
      [ev('m1', 'o1'), ev('m2', 'o2')],
      '2026-04-25T12:00:00.000Z',
    );
    await store.markFailed(a.id, 'conflict');
    await store.markDead(b.id, 'fatal 4xx');
    const dump = exec._dump();
    expect(dump.outbox).toHaveLength(0);
    expect(dump.events.find((e) => e.id === a.id)?.status).toBe('failed');
    expect(dump.events.find((e) => e.id === b.id)?.status).toBe('dead');
  });
});

describe('eventStore — Sprint 11.6 SQL safety', () => {
  // Both `events` and `sync_outbox` declare a `last_error` column in
  // 0001_init.sql. Real SQLite raises "ambiguous column name" if a
  // JOIN selects it without table qualification — and we shipped that
  // bug to the pilot for several days because the in-memory mock
  // tolerates the unqualified form. This test guards against
  // re-introducing it: every column referenced in pendingDue MUST be
  // table-qualified.
  it('pendingDue SQL does not reference `last_error` without a table prefix', () => {
    const captured: string[] = [];
    const exec = {
      select: async (sql: string) => {
        captured.push(sql);
        return [];
      },
      execute: async () => ({ rowsAffected: 0, lastInsertId: 0 }),
      transaction: async (fn: (tx: typeof exec) => Promise<unknown>) => fn(exec),
    } as unknown as ReturnType<typeof createMemoryExecutor>;
    const store = createEventStore(exec);
    void store.pendingDue('2026-04-27T00:00:00Z');
    expect(captured.length).toBe(1);
    const sql = captured[0];
    // Any standalone `last_error` (not preceded by `events.` or
    // `sync_outbox.`) is a regression. Same check for `attempts`,
    // which also exists on both tables.
    const ambiguous = /(?<![A-Za-z0-9_.])(last_error|attempts)(?!\s+AS)/g;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    const re = ambiguous;
    while ((m = re.exec(sql)) !== null) {
      const before = sql.slice(Math.max(0, m.index - 20), m.index);
      // OK if it's the alias side ("AS last_error") or already qualified.
      if (!/(events|sync_outbox)\.$/.test(before) && !/AS\s+$/i.test(before)) {
        matches.push(`${before}<<${m[0]}>>`);
      }
    }
    expect(matches, `unqualified column refs found: ${matches.join(' | ')}`).toEqual([]);
  });
});
