import { describe, expect, it } from 'vitest';
import { createInMemorySyncTransport } from '../inMemoryTransport';
import { TransportOfflineError, TransportTimeoutError, type PushEnvelope } from '../transport';

const env = (mutationId: string): PushEnvelope => ({
  mutationId,
  attempt: 0,
  event: {
    mutationId,
    type: 'ORDER_CREATED' as never,
    localTimestamp: '',
    deviceId: 'd',
    orderLocalId: 'o1',
    orderServerId: null,
    payload: {},
  },
});

describe('InMemorySyncTransport', () => {
  it('accepts new mutations, then duplicates the same mutation_id', async () => {
    const t = createInMemorySyncTransport();
    const r1 = await t.pushEvents([env('m1')]);
    expect(r1[0]).toMatchObject({ mutationId: 'm1', status: 'accepted' });
    const r2 = await t.pushEvents([env('m1')]);
    expect(r2[0]).toMatchObject({ mutationId: 'm1', status: 'duplicate' });
  });

  it('mode=offline throws', async () => {
    const t = createInMemorySyncTransport({ mode: 'offline' });
    await expect(t.pushEvents([env('m1')])).rejects.toBeInstanceOf(TransportOfflineError);
  });

  it('mode=timeout throws after `timeoutMs`', async () => {
    const t = createInMemorySyncTransport({ mode: 'timeout', timeoutMs: 5 });
    await expect(t.pushEvents([env('m1')])).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  it('mode=conflict surfaces an ORDER_LOCKED outcome', async () => {
    const t = createInMemorySyncTransport({ mode: 'conflict' });
    const [r] = await t.pushEvents([env('m1')]);
    expect(r).toMatchObject({ status: 'conflict', errorCode: 'ORDER_LOCKED', retryable: false });
  });

  it('mode=failed is retryable; mode=fatal is not', async () => {
    const t = createInMemorySyncTransport({ mode: 'failed' });
    expect((await t.pushEvents([env('m1')]))[0]).toMatchObject({ status: 'failed', retryable: true });
    t.setMode('fatal');
    expect((await t.pushEvents([env('m2')]))[0]).toMatchObject({ status: 'failed', retryable: false });
  });

  it('scriptOutcome targets one mutation only', async () => {
    const t = createInMemorySyncTransport({ mode: 'success' });
    t.scriptOutcome('m1', { status: 'conflict', errorCode: 'X', retryable: false });
    const out = await t.pushEvents([env('m1'), env('m2')]);
    expect(out[0]).toMatchObject({ status: 'conflict' });
    expect(out[1]).toMatchObject({ status: 'accepted' });
  });
});
