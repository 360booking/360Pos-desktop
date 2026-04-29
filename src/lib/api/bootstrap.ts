/**
 * GET /api/pos/bootstrap client.
 *
 * Returns the master-data snapshot the desktop hydrates SQLite from on
 * first pair / manual refresh. Sprint 3 just shapes the response and
 * proves the contract end-to-end; persisting it into local SQLite tables
 * lands in Sprint 4 alongside the live UI wiring.
 */
import { getApiClient } from './client';

export interface BootstrapVatConfig {
  defaultRate: number;
  foodRate: number | null;
  barRate: number | null;
}

export interface BootstrapProduct {
  id: string;
  sku: string | null;
  name: string;
  priceCents: number;
  categoryId: string | null;
  isActive: boolean;
  // Optional so older test fixtures + older backends without the
  // imageUrl field still type-check; absent = no image.
  imageUrl?: string | null;
}

export interface BootstrapCategory {
  id: string;
  name: string;
  type: string | null;
  sortOrder: number;
}

export interface BootstrapTable {
  id: string;
  tableNumber: string;
  capacity: number | null;
  qrToken: string | null;
  isReservable: boolean;
}

export interface BootstrapResponse {
  serverTime: string;
  tenant: { id: string } | null;
  restaurant: { id: string; name: string } | null;
  vatConfig: BootstrapVatConfig;
  categories: BootstrapCategory[];
  products: BootstrapProduct[];
  tables: BootstrapTable[];
  users: Array<{ id: string; role: string; name: string | null }>;
  settings: Record<string, unknown>;
  syncCursor: Record<string, number>;
}

export async function fetchBootstrap(restaurantId?: string): Promise<BootstrapResponse> {
  const r = await getApiClient().get<BootstrapResponse>('/api/pos/bootstrap', {
    params: restaurantId ? { restaurant_id: restaurantId } : undefined,
  });
  return r.data;
}
