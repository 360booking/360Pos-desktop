import { describe, expect, it } from 'vitest';
import axios, { type AxiosError, type AxiosInstance } from 'axios';
import { createHttpSyncTransport } from '../httpTransport';
import type { PushEnvelope } from '../transport';

const env = (mutationId: string, order = 'o1'): PushEnvelope => ({
  mutationId,
  attempt: 0,
  event: {
    mutationId,
    type: 'ORDER_CREATED' as never,
    localTimestamp: '2026-04-27T12:00:00Z',
    deviceId: 'dev-1',
    orderLocalId: order,
    orderServerId: null,
    payload: { x: 1 },
  },
});

/** Build an axios instance whose adapter is fully scripted by the test. */
function withAdapter(adapter: (cfg: any) => Promise<any>): AxiosInstance {
  return axios.create({
    baseURL: 'http://test.invalid',
    timeout: 1000,
    // axios passes the request config to the adapter; we return a Promise
    // that resolves to a Response or rejects with a thrown error.
    adapter: adapter as never,
  });
}

describe('HttpSyncTransport — server happy paths', () => {
  it('maps server "accepted" / "duplicate" results into outcomes by mutationId', async () => {
    const ax = withAdapter(async () => ({
      data: {
        results: [
          { mutationId: 'm2', status: 'duplicate' },
          { mutationId: 'm1', status: 'accepted', serverState: { ack: true } },
        ],
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    }));
    const t = createHttpSyncTransport({ axios: ax });
    const out = await t.pushEvents([env('m1'), env('m2')]);
    expect(out).toEqual([
      { mutationId: 'm1', status: 'accepted', serverState: { ack: true } },
      { mutationId: 'm2', status: 'duplicate' },
    ]);
  });

  it('marks envelope failed (retryable) when server omits its mutation', async () => {
    const ax = withAdapter(async () => ({
      data: { results: [] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    }));
    const out = await createHttpSyncTransport({ axios: ax }).pushEvents([env('m1')]);
    expect(out[0]).toMatchObject({
      status: 'failed',
      errorCode: 'MISSING_RESULT',
      retryable: true,
    });
  });
});

describe('HttpSyncTransport — error mapping', () => {
  function reject(status: number, code?: string): AxiosInstance {
    return withAdapter(async (config) => {
      const err = new Error(`HTTP ${status}`) as AxiosError;
      err.isAxiosError = true;
      err.config = config as never;
      err.code = code;
      err.response = {
        status,
        statusText: 'X',
        headers: {},
        data: {},
        config: config as never,
      };
      throw err;
    });
  }

  function rejectNoResponse(code: string): AxiosInstance {
    return withAdapter(async (config) => {
      const err = new Error(code) as AxiosError;
      err.isAxiosError = true;
      err.config = config as never;
      err.code = code;
      throw err;
    });
  }

  it('409 → conflict, retryable=false', async () => {
    const out = await createHttpSyncTransport({ axios: reject(409) }).pushEvents([env('m1')]);
    expect(out[0]).toMatchObject({ status: 'conflict', retryable: false, errorCode: 'CONFLICT' });
  });

  it('422 → failed, retryable=false (validation error)', async () => {
    const out = await createHttpSyncTransport({ axios: reject(422) }).pushEvents([env('m1')]);
    expect(out[0]).toMatchObject({ status: 'failed', retryable: false, errorCode: 'HTTP_422' });
  });

  it('400 → failed, retryable=false', async () => {
    const out = await createHttpSyncTransport({ axios: reject(400) }).pushEvents([env('m1')]);
    expect(out[0]).toMatchObject({ status: 'failed', retryable: false, errorCode: 'HTTP_400' });
  });

  it('401 / 403 → failed, retryable=false (auth must be fixed)', async () => {
    const a = await createHttpSyncTransport({ axios: reject(401) }).pushEvents([env('m1')]);
    const b = await createHttpSyncTransport({ axios: reject(403) }).pushEvents([env('m2')]);
    expect(a[0]).toMatchObject({ status: 'failed', retryable: false, errorCode: 'HTTP_401' });
    expect(b[0]).toMatchObject({ status: 'failed', retryable: false, errorCode: 'HTTP_403' });
  });

  it('500 → failed, retryable=true', async () => {
    const out = await createHttpSyncTransport({ axios: reject(500) }).pushEvents([env('m1')]);
    expect(out[0]).toMatchObject({ status: 'failed', retryable: true, errorCode: 'HTTP_500' });
  });

  it('network error (no response) → failed retryable, NETWORK', async () => {
    const out = await createHttpSyncTransport({ axios: rejectNoResponse('ENOTFOUND') }).pushEvents([env('m1')]);
    expect(out[0]).toMatchObject({ status: 'failed', retryable: true, errorCode: 'NETWORK' });
  });

  it('timeout (ECONNABORTED) → failed retryable, TIMEOUT', async () => {
    const out = await createHttpSyncTransport({ axios: rejectNoResponse('ECONNABORTED') }).pushEvents([env('m1')]);
    expect(out[0]).toMatchObject({ status: 'failed', retryable: true, errorCode: 'TIMEOUT' });
  });
});

describe('HttpSyncTransport — request shape', () => {
  it('sends events array with mutationId/type/payload at /api/pos/sync/push', async () => {
    let captured: { url?: string; data?: unknown } = {};
    const ax = withAdapter(async (cfg) => {
      captured = { url: cfg.url, data: JSON.parse(String(cfg.data)) };
      return {
        data: { results: [{ mutationId: 'm1', status: 'accepted' }] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: cfg,
      };
    });
    await createHttpSyncTransport({ axios: ax }).pushEvents([env('m1')]);
    expect(captured.url).toBe('/api/pos/sync/push');
    expect(captured.data).toMatchObject({
      events: [
        expect.objectContaining({
          mutationId: 'm1',
          type: 'ORDER_CREATED',
          payload: { x: 1 },
          deviceId: 'dev-1',
          orderLocalId: 'o1',
        }),
      ],
    });
  });
});

describe('HttpSyncTransport — empty batch', () => {
  it('returns [] without making a request', async () => {
    let called = false;
    const ax = withAdapter(async () => {
      called = true;
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config: {} };
    });
    const out = await createHttpSyncTransport({ axios: ax }).pushEvents([]);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});
