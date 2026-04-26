/**
 * Sprint 10 / E — lastBootstrap module is the surface the
 * Diagnostics snapshot + TablesEmptyState read from. Lock its
 * contract so a future refactor can't silently drop counts.
 */
import { describe, expect, it } from 'vitest';

import {
  rememberBootstrap,
  readLastBootstrap,
  readLastBootstrapRestaurantId,
} from '../lastBootstrap';
import type { BootstrapResponse } from '@/lib/api/bootstrap';
import type { RunBootstrapResult } from '../runBootstrap';

const sampleBootstrap: BootstrapResponse = {
  serverTime: '2026-04-26T18:00:00Z',
  tenant: { id: 't-1' },
  restaurant: { id: 'r-1', name: 'My Bistro' },
  vatConfig: { defaultRate: 0.19, foodRate: null, barRate: null },
  categories: [{ id: 'c1', name: 'Mains', type: null, sortOrder: 0 }],
  products: [
    {
      id: 'p1',
      sku: null,
      name: 'Soup',
      priceCents: 1000,
      categoryId: 'c1',
      isActive: true,
    },
  ],
  tables: [
    { id: 't1', tableNumber: '1', capacity: 4, qrToken: null, isReservable: true },
    { id: 't2', tableNumber: '2', capacity: 2, qrToken: null, isReservable: true },
  ],
  users: [],
  settings: {},
  syncCursor: {},
};

describe('lastBootstrap', () => {
  it('exposes the latest bootstrap result + restaurant id used', () => {
    const ok: RunBootstrapResult = {
      ok: true,
      summary: {
        categories: 1,
        products: 1,
        tables: 2,
        productsDeactivated: 0,
        hydratedAt: sampleBootstrap.serverTime,
      },
      bootstrap: sampleBootstrap,
    };
    rememberBootstrap(ok, 'r-1');
    const last = readLastBootstrap();
    expect(last?.ok).toBe(true);
    if (last?.ok) {
      expect(last.bootstrap.tables.length).toBe(2);
      expect(last.bootstrap.restaurant?.id).toBe('r-1');
    }
    expect(readLastBootstrapRestaurantId()).toBe('r-1');
  });

  it('records error results too — Diagnostics needs to surface them', () => {
    const err: RunBootstrapResult = { ok: false, error: new Error('HTTP 401') };
    rememberBootstrap(err, 'r-2');
    expect(readLastBootstrap()?.ok).toBe(false);
    expect(readLastBootstrapRestaurantId()).toBe('r-2');
  });
});
