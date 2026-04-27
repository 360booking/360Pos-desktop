/**
 * Local event store + outbox writer.
 *
 * Append-only by contract. Each persisted event is paired with a
 * sync_outbox row in the SAME transaction so a crash can never leave an
 * event without a queue entry, or an outbox row without an event.
 *
 * Used by `dispatchPosAction()`. Read by `outboxWorker`.
 */
import type { SyncEvent } from '@/core/pos-core';
import type { SqlExecutor } from '../db/executor';

export interface PersistedEvent {
  id: number;
  mutationId: string;
  type: string;
  payloadJson: string;
  orderLocalId: string | null;
  createdAt: string;
  status: 'pending' | 'processing' | 'synced' | 'failed' | 'dead';
}

export interface OutboxItem {
  id: number;
  mutationId: string;
  type: string;
  payloadJson: string;
  orderLocalId: string | null;
  attempts: number;
  lastError: string | null;
}

export interface SyncCounts {
  pending: number;
  processing: number;
  synced: number;
  failed: number;
  dead: number;
  total: number;
  outboxDepth: number;
}

const ZERO_COUNTS: SyncCounts = {
  pending: 0,
  processing: 0,
  synced: 0,
  failed: 0,
  dead: 0,
  total: 0,
  outboxDepth: 0,
};

export interface EventStore {
  /**
   * Persist N events from a single pos-core action atomically.
   * Returns the persisted rows. If a `mutation_id` already exists in
   * `events`, the row is reused (idempotent — same action, same id).
   */
  persistBatch(events: SyncEvent[], nowIso: string): Promise<PersistedEvent[]>;

  /** Outbox rows due for processing (`next_retry_at <= now`), ordered FIFO. */
  pendingDue(nowIso: string): Promise<OutboxItem[]>;

  /** Mark an event `processing` — used by the worker before pushing. */
  markProcessing(eventId: number): Promise<void>;

  /** On accepted/duplicate response: mark event synced and remove outbox row. */
  markSynced(
    eventId: number,
    serverResponseJson: string | null,
    nowIso: string,
  ): Promise<void>;

  /**
   * On retryable failure: bump attempts, schedule next_retry_at,
   * keep status = 'pending'. After 50 attempts → 'dead'.
   */
  scheduleRetry(
    eventId: number,
    nextAttempt: number,
    nextRetryAt: string,
    lastError: string,
  ): Promise<void>;

  /** On non-retryable error (conflict, fatal): mark event failed, KEEP outbox row removed. */
  markFailed(eventId: number, errorMessage: string): Promise<void>;

  /** Mark an event dead-letter (terminal). Removes the outbox row. */
  markDead(eventId: number, errorMessage: string): Promise<void>;

  /** Aggregate counts for the UI / status bar. */
  counts(): Promise<SyncCounts>;
}

/** Maximum attempts before dead-letter, per offline-sync-strategy.md. */
export const MAX_ATTEMPTS = 50;

export function createEventStore(db: SqlExecutor): EventStore {
  return {
    async persistBatch(events, _nowIso) {
      if (events.length === 0) return [];
      return db.transaction(async (tx) => {
        const rows: PersistedEvent[] = [];
        for (const ev of events) {
          // Idempotent insert — duplicate mutation_id is treated as success
          // (same action replayed after crash).
          const ins = await tx.execute(
            'INSERT INTO events (mutation_id, type, payload_json, order_local_id) VALUES (?, ?, ?, ?) ON CONFLICT(mutation_id) DO NOTHING',
            [ev.mutationId, ev.type, JSON.stringify(ev.payload), ev.orderLocalId],
          );
          let row: PersistedEvent;
          if (ins.rowsAffected === 0) {
            // Pre-existing — fetch current row for the worker.
            const existing = await tx.select<{
              id: number;
              mutation_id: string;
              type: string;
              payload_json: string;
              order_local_id: string | null;
              status: PersistedEvent['status'];
              created_at: string;
            }>('SELECT * FROM events WHERE mutation_id = ?', [ev.mutationId]);
            const r = existing[0];
            row = {
              id: r.id,
              mutationId: r.mutation_id,
              type: r.type,
              payloadJson: r.payload_json,
              orderLocalId: r.order_local_id,
              createdAt: r.created_at,
              status: r.status,
            };
          } else {
            const id = ins.lastInsertId!;
            // Outbox row only when the event is fresh; a duplicate insert
            // means the outbox already has its row from the prior attempt.
            await tx.execute(
              'INSERT INTO sync_outbox (event_id, next_retry_at) VALUES (?, ?)',
              [id, _nowIso],
            );
            row = {
              id,
              mutationId: ev.mutationId,
              type: ev.type,
              payloadJson: JSON.stringify(ev.payload),
              orderLocalId: ev.orderLocalId,
              createdAt: _nowIso,
              status: 'pending',
            };
          }
          rows.push(row);
        }
        return rows;
      });
    },

    async pendingDue(nowIso) {
      const rows = await db.select<{
        id: number;
        mutation_id: string;
        type: string;
        payload_json: string;
        order_local_id: string | null;
        attempts: number;
        last_error: string | null;
      }>(
        // Sprint 11.6 — `last_error` exists on BOTH events and
        // sync_outbox in 0001_init.sql; SQLite refused the unqualified
        // SELECT with "ambiguous column name: last_error", which
        // silently broke every outbox push since the columns were
        // added. We want sync_outbox.last_error (per-attempt failure
        // that drives backoff), not events.last_error (terminal). All
        // columns are now fully qualified for safety.
        'SELECT events.id AS id, events.mutation_id AS mutation_id, events.type AS type, events.payload_json AS payload_json, events.order_local_id AS order_local_id, sync_outbox.attempts AS attempts, sync_outbox.last_error AS last_error FROM events JOIN sync_outbox ON sync_outbox.event_id = events.id WHERE events.status IN (?,?) AND sync_outbox.next_retry_at <= ? ORDER BY events.created_at ASC, events.id ASC',
        ['pending', 'processing', nowIso],
      );
      return rows.map((r) => ({
        id: r.id,
        mutationId: r.mutation_id,
        type: r.type,
        payloadJson: r.payload_json,
        orderLocalId: r.order_local_id,
        attempts: r.attempts,
        lastError: r.last_error,
      }));
    },

    async markProcessing(eventId) {
      await db.execute(
        'UPDATE events SET status=?, last_error=? WHERE id=?',
        ['processing', null, eventId],
      );
    },

    async markSynced(eventId, serverResponseJson, nowIso) {
      await db.transaction(async (tx) => {
        await tx.execute(
          'UPDATE events SET status=?, synced_at=?, server_response_json=? WHERE id=?',
          ['synced', nowIso, serverResponseJson, eventId],
        );
        await tx.execute('DELETE FROM sync_outbox WHERE event_id=?', [eventId]);
      });
    },

    async scheduleRetry(eventId, nextAttempt, nextRetryAt, lastError) {
      const dead = nextAttempt >= MAX_ATTEMPTS;
      await db.transaction(async (tx) => {
        if (dead) {
          await tx.execute(
            'UPDATE events SET status=?, last_error=? WHERE id=?',
            ['dead', lastError, eventId],
          );
          await tx.execute('DELETE FROM sync_outbox WHERE event_id=?', [eventId]);
        } else {
          await tx.execute(
            'UPDATE events SET status=?, last_error=? WHERE id=?',
            ['pending', lastError, eventId],
          );
          await tx.execute(
            'UPDATE sync_outbox SET attempts=?, next_retry_at=?, last_error=? WHERE event_id=?',
            [nextAttempt, nextRetryAt, lastError, eventId],
          );
        }
      });
    },

    async markFailed(eventId, errorMessage) {
      await db.transaction(async (tx) => {
        await tx.execute(
          'UPDATE events SET status=?, last_error=? WHERE id=?',
          ['failed', errorMessage, eventId],
        );
        await tx.execute('DELETE FROM sync_outbox WHERE event_id=?', [eventId]);
      });
    },

    async markDead(eventId, errorMessage) {
      await db.transaction(async (tx) => {
        await tx.execute(
          'UPDATE events SET status=?, last_error=? WHERE id=?',
          ['dead', errorMessage, eventId],
        );
        await tx.execute('DELETE FROM sync_outbox WHERE event_id=?', [eventId]);
      });
    },

    async counts() {
      const [byStatus, outbox] = await Promise.all([
        db.select<{ status: string; c: number }>(
          'SELECT status, COUNT(*) AS c FROM events GROUP BY status',
        ),
        db.select<{ c: number }>('SELECT COUNT(*) AS c FROM sync_outbox'),
      ]);
      const out: SyncCounts = { ...ZERO_COUNTS };
      const writable = out as unknown as Record<string, number>;
      for (const r of byStatus) {
        const k = r.status as keyof SyncCounts;
        if (k in out) writable[k] = r.c;
        out.total += r.c;
      }
      out.outboxDepth = outbox[0]?.c ?? 0;
      return out;
    },
  };
}
