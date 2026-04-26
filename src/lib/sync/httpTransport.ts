/**
 * HTTP sync transport — Sprint 3.
 *
 * Same SyncTransport interface as InMemorySyncTransport, so the outbox
 * worker doesn't change. POSTs the batch to /api/pos/sync/push and maps
 * HTTP outcomes onto the four standard statuses:
 *
 *   network / no response      → all envelopes failed (retryable=true)
 *   timeout                    → all envelopes failed (retryable=true)
 *   200 with body.results      → per-event status copied through
 *   409                        → all envelopes conflict (retryable=false)
 *   400 / 422                  → all envelopes failed (retryable=false)
 *   401 / 403                  → all envelopes failed (retryable=false) — auth must be fixed by user
 *   5xx                        → all envelopes failed (retryable=true)
 *
 * The transport is stateless. Auth + base URL come from the injected
 * axios instance.
 */
import axios, { AxiosError, type AxiosInstance } from 'axios';
import type {
  PushEnvelope,
  PushOutcome,
  SyncTransport,
} from './transport';
import { useAuthStore } from '@/store/auth';

export interface HttpSyncTransportOptions {
  axios: AxiosInstance;
  /** Override the path if needed (default '/api/pos/sync/push'). */
  pushPath?: string;
}

interface ServerSyncEvent {
  mutationId: string;
  type: string;
  payload: unknown;
  deviceId?: string | null;
  tenantId?: string | null;
  restaurantId?: string | null;
  orderLocalId?: string | null;
  createdAt?: string | null;
}

interface ServerResult {
  mutationId: string;
  status: 'accepted' | 'duplicate' | 'conflict' | 'failed';
  serverState?: Record<string, unknown> | null;
  errorCode?: string | null;
  message?: string | null;
}

interface ServerResponse {
  results: ServerResult[];
}

function bulkOutcome(
  envelopes: PushEnvelope[],
  partial: Omit<PushOutcome, 'mutationId'>,
): PushOutcome[] {
  return envelopes.map((env) => ({ mutationId: env.mutationId, ...partial }));
}

export function createHttpSyncTransport(opts: HttpSyncTransportOptions): SyncTransport {
  const client = opts.axios;
  const path = opts.pushPath ?? '/api/pos/sync/push';

  const transport: SyncTransport = {
    id: 'http',

    async pushEvents(envelopes: PushEnvelope[]): Promise<PushOutcome[]> {
      if (envelopes.length === 0) return [];

      // Sprint 10 / G — backend's _handle_order_created REQUIRES
      // restaurantId on the wire. The local SyncEvent envelope doesn't
      // carry one (it's a per-tenant value, not a per-event one), so
      // we inject it here from the auth store at push time. Without
      // this, ORDER_CREATED is rejected as RESTAURANT_REQUIRED, and
      // every later event (item, sent_to_kitchen, payment) fails with
      // ORDER_NOT_FOUND because there's no server-side order to bind
      // to — the symptom is "POS says sent, KDS shows nothing".
      const auth = useAuthStore.getState();
      const restaurantId = auth.selectedRestaurant?.id ?? null;
      const tenantId = auth.tenant?.id ?? null;

      const body = {
        events: envelopes.map<ServerSyncEvent>((env) => ({
          mutationId: env.event.mutationId,
          type: env.event.type as string,
          payload: env.event.payload,
          deviceId: env.event.deviceId || undefined,
          tenantId: tenantId || undefined,
          restaurantId: restaurantId || undefined,
          orderLocalId: env.event.orderLocalId || undefined,
          createdAt: env.event.localTimestamp || undefined,
        })),
      };

      try {
        const r = await client.post<ServerResponse>(path, body);
        const results = r.data?.results ?? [];
        // Build a lookup so we honor server-returned ordering even if it
        // differs from request order.
        const byId = new Map(results.map((res) => [res.mutationId, res]));
        return envelopes.map<PushOutcome>((env) => {
          const res = byId.get(env.mutationId);
          if (!res) {
            return {
              mutationId: env.mutationId,
              status: 'failed',
              errorCode: 'MISSING_RESULT',
              errorMessage: 'Server response missing this mutation',
              retryable: true,
            };
          }
          return {
            mutationId: res.mutationId,
            status: res.status,
            serverState: res.serverState ?? undefined,
            errorCode: res.errorCode ?? undefined,
            errorMessage: res.message ?? undefined,
            retryable: res.status === 'failed' ? true : undefined,
          };
        });
      } catch (err) {
        return mapErrorToOutcomes(envelopes, err);
      }
    },
  };

  return transport;
}

function mapErrorToOutcomes(envelopes: PushEnvelope[], err: unknown): PushOutcome[] {
  // Network or non-axios error.
  if (!axios.isAxiosError(err)) {
    return bulkOutcome(envelopes, {
      status: 'failed',
      errorCode: 'NETWORK',
      errorMessage: (err as Error)?.message ?? 'Network error',
      retryable: true,
    });
  }
  const ax = err as AxiosError;

  // Timeout / dropped connection / no response.
  if (!ax.response) {
    const isTimeout = ax.code === 'ECONNABORTED' || ax.code === 'ETIMEDOUT';
    return bulkOutcome(envelopes, {
      status: 'failed',
      errorCode: isTimeout ? 'TIMEOUT' : 'NETWORK',
      errorMessage: ax.message,
      retryable: true,
    });
  }

  const code = ax.response.status;

  if (code === 409) {
    return bulkOutcome(envelopes, {
      status: 'conflict',
      errorCode: 'CONFLICT',
      errorMessage: ax.message,
      retryable: false,
    });
  }
  if (code === 400 || code === 422) {
    return bulkOutcome(envelopes, {
      status: 'failed',
      errorCode: `HTTP_${code}`,
      errorMessage: ax.message,
      retryable: false,
    });
  }
  if (code === 401 || code === 403) {
    return bulkOutcome(envelopes, {
      status: 'failed',
      errorCode: `HTTP_${code}`,
      errorMessage: ax.message,
      retryable: false,
    });
  }
  if (code >= 500) {
    return bulkOutcome(envelopes, {
      status: 'failed',
      errorCode: `HTTP_${code}`,
      errorMessage: ax.message,
      retryable: true,
    });
  }
  // 4xx other than the above — treat as fatal (no point retrying).
  return bulkOutcome(envelopes, {
    status: 'failed',
    errorCode: `HTTP_${code}`,
    errorMessage: ax.message,
    retryable: false,
  });
}
