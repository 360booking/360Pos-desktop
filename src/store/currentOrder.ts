/**
 * Current-order zustand store — Sprint 4 / 3.
 *
 * Holds the in-progress draft/open Order. The cart pane reads from here
 * and the menu pane mutates it via runAction. Once an order is closed
 * (paid + closed_at set) we clear it from the store so the next "Comandă
 * nouă" starts fresh.
 */
import { create } from 'zustand';
import type { Order } from '@/core/pos-core';

interface CurrentOrderState {
  order: Order | null;
  setOrder: (o: Order | null) => void;
  clear: () => void;
}

export const useCurrentOrder = create<CurrentOrderState>((set) => ({
  order: null,
  setOrder: (o) => set({ order: o }),
  clear: () => set({ order: null }),
}));
