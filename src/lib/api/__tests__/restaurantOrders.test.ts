import { describe, expect, it, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
const postMock = vi.fn();
const patchMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../client', () => ({
  getApiClient: () => ({
    get: getMock,
    post: postMock,
    patch: patchMock,
    delete: deleteMock,
  }),
}));

import {
  restaurantOrdersApi,
  openTableViaRest,
  RestaurantOrderApiError,
} from '../restaurantOrders';

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  patchMock.mockReset();
  deleteMock.mockReset();
});

const sampleOrder = {
  id: 'ord-1',
  tenantId: 'ten',
  restaurantId: 'rest',
  source: 'pos',
  externalOrderId: null,
  tableId: 'tbl-1',
  tableNumber: '1',
  waiterId: null,
  status: 'draft',
  paymentStatus: 'unpaid',
  customer: { name: null, phone: null, email: null, address: null },
  subtotal: 0,
  discountTotal: 0,
  taxTotal: 0,
  total: 0,
  currency: 'RON',
  notes: null,
  sentToKitchenAt: null,
  closedAt: null,
  createdAt: '2026-04-28T10:00:00Z',
  updatedAt: '2026-04-28T10:00:00Z',
  items: [],
  payments: [],
  kitchenTickets: [],
};

describe('restaurantOrdersApi', () => {
  it('create posts to /api/restaurant/orders and returns the order', async () => {
    postMock.mockResolvedValueOnce({ data: sampleOrder });
    const out = await restaurantOrdersApi.create({ source: 'pos', tableId: 'tbl-1' });
    expect(postMock).toHaveBeenCalledWith('/api/restaurant/orders', { source: 'pos', tableId: 'tbl-1' });
    expect(out.id).toBe('ord-1');
  });

  it('addItem posts to /api/restaurant/orders/{id}/items', async () => {
    postMock.mockResolvedValueOnce({ data: sampleOrder });
    await restaurantOrdersApi.addItem('ord-1', { menuItemId: 'menu-1', quantity: 2 });
    expect(postMock).toHaveBeenCalledWith('/api/restaurant/orders/ord-1/items', {
      menuItemId: 'menu-1',
      quantity: 2,
    });
  });

  it('removeItem deletes /api/restaurant/orders/{id}/items/{itemId}', async () => {
    deleteMock.mockResolvedValueOnce({ data: sampleOrder });
    await restaurantOrdersApi.removeItem('ord-1', 'item-7');
    expect(deleteMock).toHaveBeenCalledWith('/api/restaurant/orders/ord-1/items/item-7');
  });

  it('sendToKitchen posts to /api/restaurant/orders/{id}/send', async () => {
    postMock.mockResolvedValueOnce({ data: sampleOrder });
    await restaurantOrdersApi.sendToKitchen('ord-1');
    expect(postMock).toHaveBeenCalledWith('/api/restaurant/orders/ord-1/send');
  });

  it('wraps axios errors as RestaurantOrderApiError with status + detail', async () => {
    postMock.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { detail: 'table already has draft', existing_order_id: 'ord-1' },
      },
      message: 'Request failed with status code 409',
    });
    await expect(restaurantOrdersApi.create({ tableId: 'tbl-1' })).rejects.toMatchObject({
      name: 'RestaurantOrderApiError',
      status: 409,
      message: 'table already has draft',
      existingOrderId: 'ord-1',
    });
  });
});

describe('openTableViaRest', () => {
  it('returns the new draft on plain success', async () => {
    postMock.mockResolvedValueOnce({ data: sampleOrder });
    const out = await openTableViaRest('tbl-1');
    expect(out.id).toBe('ord-1');
  });

  it('on 409 with existing_order_id, GET that order and return it', async () => {
    postMock.mockRejectedValueOnce({
      response: { status: 409, data: { detail: 'busy', existing_order_id: 'ord-9' } },
      message: '409',
    });
    getMock.mockResolvedValueOnce({ data: { ...sampleOrder, id: 'ord-9' } });
    const out = await openTableViaRest('tbl-1');
    expect(getMock).toHaveBeenCalledWith('/api/restaurant/orders/ord-9');
    expect(out.id).toBe('ord-9');
  });

  it('on 409 without existing_order_id, falls back to listing drafts', async () => {
    postMock.mockRejectedValueOnce({
      response: { status: 409, data: { detail: 'busy' } },
      message: '409',
    });
    getMock.mockResolvedValueOnce({
      data: [{ ...sampleOrder, id: 'ord-existing', tableId: 'tbl-1' }],
    });
    const out = await openTableViaRest('tbl-1');
    expect(out.id).toBe('ord-existing');
  });

  it('non-409 errors bubble up untouched', async () => {
    postMock.mockRejectedValueOnce({
      response: { status: 500, data: { detail: 'oops' } },
      message: '500',
    });
    await expect(openTableViaRest('tbl-1')).rejects.toBeInstanceOf(RestaurantOrderApiError);
  });
});
