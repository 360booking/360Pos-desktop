/**
 * In-memory sync transport — no HTTP, no axios. The default for Sprint 2,
 * for tests, and for the demo build's "play with the queue" mode.
 *
 * Behaviour modes (set via `setMode()`) drive every call:
 *   - 'success'   → all events accepted; idempotent on duplicates.
 *   - 'duplicate' → all events return `duplicate` (server already had it).
 *   - 'conflict'  → all events return `conflict` (e.g. order paid).
 *   - 'offline'   → throws TransportOfflineError on every call.
 *   - 'timeout'   → throws TransportTimeoutError after `timeoutMs`.
 *   - 'failed'    → returns `failed` with retryable=true (server 5xx-style).
 *   - 'fatal'     → returns `failed` with retryable=false (dead-letter).
 *
 * Per-mutation overrides allow targeted scenarios in tests:
 *   transport.scriptOutcome(mutationId, { status: 'conflict', ... });
 */
import type { PushEnvelope, PushOutcome, SyncTransport } from './transport';
import { TransportOfflineError, TransportTimeoutError } from './transport';

export type InMemoryMode =
  | 'success'
  | 'duplicate'
  | 'conflict'
  | 'offline'
  | 'timeout'
  | 'failed'
  | 'fatal';

export interface InMemoryTransportOptions {
  mode?: InMemoryMode;
  timeoutMs?: number;
  /** When set, the transport "remembers" mutation_ids it has accepted and replies `duplicate` on retry. Default true. */
  trackDuplicates?: boolean;
}

export interface InMemorySyncTransport extends SyncTransport {
  readonly id: 'in-memory';
  setMode(mode: InMemoryMode): void;
  scriptOutcome(mutationId: string, outcome: Omit<PushOutcome, 'mutationId'>): void;
  /** All envelopes the transport has seen, in order. */
  history(): PushEnvelope[];
  /** Reset the seen set + scripted overrides. */
  reset(): void;
}

export function createInMemorySyncTransport(
  opts: InMemoryTransportOptions = {},
): InMemorySyncTransport {
  let mode: InMemoryMode = opts.mode ?? 'success';
  const timeoutMs = opts.timeoutMs ?? 0;
  const trackDuplicates = opts.trackDuplicates ?? true;

  const seen = new Set<string>();
  const scripted = new Map<string, Omit<PushOutcome, 'mutationId'>>();
  const log: PushEnvelope[] = [];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const transport: InMemorySyncTransport = {
    id: 'in-memory',

    setMode(next) {
      mode = next;
    },

    scriptOutcome(mutationId, outcome) {
      scripted.set(mutationId, outcome);
    },

    history() {
      return log.slice();
    },

    reset() {
      seen.clear();
      scripted.clear();
      log.length = 0;
    },

    async pushEvents(envelopes: PushEnvelope[]): Promise<PushOutcome[]> {
      log.push(...envelopes);

      if (mode === 'offline') throw new TransportOfflineError();
      if (mode === 'timeout') {
        await sleep(timeoutMs);
        throw new TransportTimeoutError();
      }

      const out: PushOutcome[] = [];
      for (const env of envelopes) {
        const override = scripted.get(env.mutationId);
        if (override) {
          out.push({ mutationId: env.mutationId, ...override });
          if (override.status === 'accepted' || override.status === 'duplicate') {
            seen.add(env.mutationId);
          }
          continue;
        }

        if (mode === 'duplicate') {
          out.push({ mutationId: env.mutationId, status: 'duplicate' });
          continue;
        }
        if (mode === 'conflict') {
          out.push({
            mutationId: env.mutationId,
            status: 'conflict',
            errorCode: 'ORDER_LOCKED',
            errorMessage: 'simulated conflict',
            retryable: false,
          });
          continue;
        }
        if (mode === 'failed') {
          out.push({
            mutationId: env.mutationId,
            status: 'failed',
            errorCode: 'BACKEND_5XX',
            errorMessage: 'simulated 5xx',
            retryable: true,
          });
          continue;
        }
        if (mode === 'fatal') {
          out.push({
            mutationId: env.mutationId,
            status: 'failed',
            errorCode: 'BACKEND_4XX',
            errorMessage: 'simulated 4xx',
            retryable: false,
          });
          continue;
        }

        // success
        if (trackDuplicates && seen.has(env.mutationId)) {
          out.push({ mutationId: env.mutationId, status: 'duplicate' });
        } else {
          seen.add(env.mutationId);
          out.push({ mutationId: env.mutationId, status: 'accepted' });
        }
      }
      return out;
    },
  };
  return transport;
}
