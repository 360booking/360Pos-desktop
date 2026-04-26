import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { claimOrder, releaseOrder } from '../orderLock';

vi.mock('../client', () => {
  const fakeClient = { post: vi.fn() };
  return {
    getApiClient: () => fakeClient,
    __fakeClient: fakeClient,
  };
});

import * as clientMod from '../client';

const fakeClient = (clientMod as unknown as { __fakeClient: { post: ReturnType<typeof vi.fn> } }).__fakeClient;

beforeEach(() => fakeClient.post.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('claimOrder', () => {
  it('POSTs to /api/pos/orders/{id}/claim with the device id', async () => {
    fakeClient.post.mockResolvedValueOnce({
      data: { status: 'claimed', orderId: 'o1', ownerDeviceId: 'POS-01', expiresAt: '2026-04-26T12:00:00Z', message: null },
    });
    const r = await claimOrder('o1', { deviceId: 'POS-01', force: false });
    expect(fakeClient.post).toHaveBeenCalledWith('/api/pos/orders/o1/claim', {
      deviceId: 'POS-01',
      force: false,
    });
    expect(r.status).toBe('claimed');
  });

  it('passes through conflict status', async () => {
    fakeClient.post.mockResolvedValueOnce({
      data: { status: 'conflict', orderId: 'o1', ownerDeviceId: 'POS-02', expiresAt: '2026-04-26T12:00:00Z', message: 'LOCK_HELD_BY_OTHER_DEVICE' },
    });
    const r = await claimOrder('o1', { deviceId: 'POS-01' });
    expect(r.status).toBe('conflict');
    expect(r.ownerDeviceId).toBe('POS-02');
  });
});

describe('releaseOrder', () => {
  it('POSTs to /api/pos/orders/{id}/release', async () => {
    fakeClient.post.mockResolvedValueOnce({
      data: { status: 'claimed', orderId: 'o1', ownerDeviceId: null, expiresAt: null, message: null },
    });
    const r = await releaseOrder('o1', 'POS-01');
    expect(fakeClient.post).toHaveBeenCalledWith('/api/pos/orders/o1/release', {
      deviceId: 'POS-01',
    });
    expect(r.ownerDeviceId).toBeNull();
  });
});
