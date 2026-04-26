/**
 * In-memory SqlExecutor for unit tests.
 *
 * NOT a general-purpose SQLite. It only implements the exact statements
 * the sync engine sends — keeping it intentional + lean so test failures
 * point at sync bugs, not at parser bugs.
 *
 * Supported:
 *  - INSERT INTO events (...) VALUES (...)
 *  - INSERT INTO sync_outbox (...) VALUES (...)
 *  - INSERT INTO events ... ON CONFLICT(mutation_id) DO NOTHING
 *  - SELECT ... FROM events WHERE ...
 *  - SELECT ... FROM sync_outbox JOIN events ... WHERE ... ORDER BY ...
 *  - UPDATE events SET ... WHERE id=?
 *  - UPDATE sync_outbox SET ... WHERE event_id=?
 *  - DELETE FROM sync_outbox WHERE event_id=?
 *  - SELECT COUNT(...) by status
 *  - BEGIN / COMMIT / ROLLBACK
 *
 * Anything else throws.
 */
import type { SqlExecutor } from './executor';

interface EventRow {
  id: number;
  mutation_id: string;
  type: string;
  payload_json: string;
  status: 'pending' | 'processing' | 'synced' | 'failed' | 'dead';
  created_at: string;
  synced_at: string | null;
  server_response_json: string | null;
  last_error: string | null;
  // shadow columns we read in joins / dispatch (kept off the schema for parity);
  // the real DB stores them inside payload_json.
  order_local_id: string | null;
}

interface OutboxRow {
  event_id: number;
  attempts: number;
  next_retry_at: string;
  last_error: string | null;
}

interface State {
  events: EventRow[];
  outbox: OutboxRow[];
  nextEventId: number;
}

function emptyState(): State {
  return { events: [], outbox: [], nextEventId: 1 };
}

function clone(state: State): State {
  return {
    events: state.events.map((e) => ({ ...e })),
    outbox: state.outbox.map((o) => ({ ...o })),
    nextEventId: state.nextEventId,
  };
}

export interface MemoryExecutor extends SqlExecutor {
  /** Snapshot the current store — handy in tests. */
  _dump(): { events: EventRow[]; outbox: OutboxRow[] };
  /** Drop all rows (does NOT reset the autoincrement counter). */
  _reset(): void;
}

export function createMemoryExecutor(): MemoryExecutor {
  let live: State = emptyState();
  let txBackup: State | null = null;
  let txQueue: Promise<void> = Promise.resolve();

  const norm = (sql: string): string => sql.trim().replace(/\s+/g, ' ');

  const exec: MemoryExecutor = {
    async select<T = Record<string, unknown>>(rawSql: string, params: unknown[] = []): Promise<T[]> {
      const sql = norm(rawSql);

      // SELECT * FROM events WHERE mutation_id = ?
      if (/^SELECT \* FROM events WHERE mutation_id = \?$/i.test(sql)) {
        const m = String(params[0]);
        return live.events.filter((e) => e.mutation_id === m) as unknown as T[];
      }

      // SELECT * FROM events WHERE id = ?
      if (/^SELECT \* FROM events WHERE id = \?$/i.test(sql)) {
        const id = Number(params[0]);
        return live.events.filter((e) => e.id === id) as unknown as T[];
      }

      // SELECT ... FROM events JOIN sync_outbox ... WHERE events.status IN (?,?)
      //   AND sync_outbox.next_retry_at <= ? ORDER BY events.created_at ASC, events.id ASC
      // Params: [status1, status2, cutoffIso]
      if (/^SELECT .* FROM events JOIN sync_outbox/i.test(sql)) {
        const allowed = new Set([String(params[0]), String(params[1])]);
        const cutoff = String(params[2]);
        const rows = live.events
          .filter((e) => allowed.has(e.status))
          .map((e) => {
            const ob = live.outbox.find((o) => o.event_id === e.id);
            if (!ob) return null;
            if (ob.next_retry_at > cutoff) return null;
            return {
              id: e.id,
              mutation_id: e.mutation_id,
              type: e.type,
              payload_json: e.payload_json,
              order_local_id: e.order_local_id,
              attempts: ob.attempts,
              last_error: ob.last_error,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .sort((a, b) => {
            const ea = live.events.find((e) => e.id === a.id)!;
            const eb = live.events.find((e) => e.id === b.id)!;
            return ea.created_at < eb.created_at ? -1 : ea.created_at > eb.created_at ? 1 : a.id - b.id;
          });
        return rows as unknown as T[];
      }

      // Counts grouped by status — used by useSyncStatus.
      if (/^SELECT status, COUNT\(\*\) AS c FROM events GROUP BY status$/i.test(sql)) {
        const groups = new Map<string, number>();
        for (const e of live.events) groups.set(e.status, (groups.get(e.status) ?? 0) + 1);
        return Array.from(groups, ([status, c]) => ({ status, c })) as unknown as T[];
      }

      // SELECT COUNT(*) AS c FROM sync_outbox
      if (/^SELECT COUNT\(\*\) AS c FROM sync_outbox$/i.test(sql)) {
        return [{ c: live.outbox.length }] as unknown as T[];
      }

      throw new Error(`memoryExecutor: unsupported SELECT: ${sql}`);
    },

    async execute(rawSql: string, params: unknown[] = []) {
      const sql = norm(rawSql);

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        // handled by transaction()
        return { rowsAffected: 0 };
      }

      // INSERT INTO events (mutation_id, type, payload_json, order_local_id) VALUES (?, ?, ?, ?)
      // ON CONFLICT(mutation_id) DO NOTHING
      if (
        /^INSERT INTO events \(mutation_id, type, payload_json, order_local_id\) VALUES \(\?, \?, \?, \?\)( ON CONFLICT\(mutation_id\) DO NOTHING)?$/i.test(
          sql,
        )
      ) {
        const [mutation_id, type, payload_json, order_local_id] = params as [
          string,
          string,
          string,
          string | null,
        ];
        const dup = live.events.find((e) => e.mutation_id === mutation_id);
        if (dup) {
          if (/ON CONFLICT/i.test(sql)) return { rowsAffected: 0, lastInsertId: dup.id };
          throw new Error('UNIQUE constraint failed: events.mutation_id');
        }
        const id = live.nextEventId++;
        live.events.push({
          id,
          mutation_id,
          type,
          payload_json,
          order_local_id,
          status: 'pending',
          created_at: new Date(Date.now() + id).toISOString(), // monotonic-ish
          synced_at: null,
          server_response_json: null,
          last_error: null,
        });
        return { rowsAffected: 1, lastInsertId: id };
      }

      // INSERT INTO sync_outbox (event_id, next_retry_at) VALUES (?, ?)
      if (/^INSERT INTO sync_outbox \(event_id, next_retry_at\) VALUES \(\?, \?\)$/i.test(sql)) {
        const [event_id, next_retry_at] = params as [number, string];
        live.outbox.push({ event_id, attempts: 0, next_retry_at, last_error: null });
        return { rowsAffected: 1 };
      }

      // UPDATE events SET status=?, synced_at=?, server_response_json=? WHERE id=?
      if (/^UPDATE events SET status=\?, synced_at=\?, server_response_json=\? WHERE id=\?$/i.test(sql)) {
        const [status, synced_at, server_response_json, id] = params as [
          EventRow['status'],
          string | null,
          string | null,
          number,
        ];
        const ev = live.events.find((e) => e.id === Number(id));
        if (ev) {
          ev.status = status;
          ev.synced_at = synced_at;
          ev.server_response_json = server_response_json;
        }
        return { rowsAffected: ev ? 1 : 0 };
      }

      // UPDATE events SET status=?, last_error=? WHERE id=?
      if (/^UPDATE events SET status=\?, last_error=\? WHERE id=\?$/i.test(sql)) {
        const [status, last_error, id] = params as [EventRow['status'], string | null, number];
        const ev = live.events.find((e) => e.id === Number(id));
        if (ev) {
          ev.status = status;
          ev.last_error = last_error;
        }
        return { rowsAffected: ev ? 1 : 0 };
      }

      // UPDATE sync_outbox SET attempts=?, next_retry_at=?, last_error=? WHERE event_id=?
      if (
        /^UPDATE sync_outbox SET attempts=\?, next_retry_at=\?, last_error=\? WHERE event_id=\?$/i.test(sql)
      ) {
        const [attempts, next_retry_at, last_error, event_id] = params as [
          number,
          string,
          string | null,
          number,
        ];
        const ob = live.outbox.find((o) => o.event_id === Number(event_id));
        if (ob) {
          ob.attempts = attempts;
          ob.next_retry_at = next_retry_at;
          ob.last_error = last_error;
        }
        return { rowsAffected: ob ? 1 : 0 };
      }

      // DELETE FROM sync_outbox WHERE event_id=?
      if (/^DELETE FROM sync_outbox WHERE event_id=\?$/i.test(sql)) {
        const id = Number(params[0]);
        const before = live.outbox.length;
        live.outbox = live.outbox.filter((o) => o.event_id !== id);
        return { rowsAffected: before - live.outbox.length };
      }

      throw new Error(`memoryExecutor: unsupported EXECUTE: ${sql}`);
    },

    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      // Real SQLite serialises through one connection. Mirror that here so
      // overlapping callers queue instead of stomping each other.
      const prior = txQueue;
      let release!: () => void;
      txQueue = new Promise<void>((r) => (release = r));
      await prior;
      txBackup = clone(live);
      try {
        const out = await fn(exec);
        txBackup = null;
        return out;
      } catch (err) {
        live = txBackup!;
        txBackup = null;
        throw err;
      } finally {
        release();
      }
    },

    _dump() {
      return { events: live.events.map((e) => ({ ...e })), outbox: live.outbox.map((o) => ({ ...o })) };
    },
    _reset() {
      live = { events: [], outbox: [], nextEventId: live.nextEventId };
    },
  };

  return exec;
}
