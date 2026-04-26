/**
 * Sync transport contract.
 *
 * Sprint 2 ships only InMemorySyncTransport (no HTTP). Sprint 3 swaps in
 * HttpSyncTransport that POSTs to /api/pos/sync/push without changing the
 * outbox worker.
 */
import type { SyncEvent } from '@/core/pos-core';

export interface PushEnvelope {
  event: SyncEvent;
  /** Server reads this to detect retries; mirrors event.mutationId. */
  mutationId: string;
  /** Worker retry attempt counter — for telemetry; not used as idempotency. */
  attempt: number;
}

export type PushOutcomeStatus = 'accepted' | 'duplicate' | 'conflict' | 'failed';

export interface PushOutcome {
  mutationId: string;
  status: PushOutcomeStatus;
  /** Backend's view of the resulting state (Sprint 3 will use this to converge). */
  serverState?: Record<string, unknown>;
  /** Set on `conflict` and `failed`. */
  errorCode?: string;
  errorMessage?: string;
  /** Hint for retry logic: `false` ⇒ fatal (do not retry, dead-letter). */
  retryable?: boolean;
}

export class TransportOfflineError extends Error {
  constructor() {
    super('Sync transport is offline.');
    this.name = 'TransportOfflineError';
  }
}
export class TransportTimeoutError extends Error {
  constructor() {
    super('Sync transport timed out.');
    this.name = 'TransportTimeoutError';
  }
}

export interface SyncTransport {
  /** Stable identifier — surfaced in the diagnostic panel. */
  readonly id: 'in-memory' | 'http' | 'noop';
  pushEvents(envelopes: PushEnvelope[]): Promise<PushOutcome[]>;
}
