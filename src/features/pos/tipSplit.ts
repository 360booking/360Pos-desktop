/**
 * Bacșiș și „Împarte nota” — regulile, fără React (testate în
 * __tests__/tipSplit.test.ts). Totul copiază POS-ul web
 * (frontend/src/pages/admin/restaurant/POSPage.tsx + pos/SplitDialog.tsx)
 * și folosește aceleași cereri: POST /orders/{id}/tip, /items/move,
 * /split-seats. Bacșișul nu ajunge pe bonul fiscal: serverul îl scoate
 * (ca în POS-ul web), iar casa offline nu închide note cu bacșiș.
 */
import type { RestaurantOrder, OrderItem } from '@/lib/api/restaurantOrders';

// ── Bacșiș ────────────────────────────────────────────────────────────────

/** Suma scrisă de ospătar („10”, „12,50”) → bani; null = invalidă. */
export function parseTipInput(text: string): number | null {
  const t = text.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}

/** Bacșișul se pune pe o notă salvată pe server, cu produse, neplătită și
 *  neanulată (aceleași refuzuri ca serverul, `set_tip`). */
export function canSetTip(order: {
  serverId: string | null;
  state: string;
  items: Array<{ voidedAt: string | null }>;
} | null): boolean {
  if (!order || !order.serverId) return false;
  if (order.state === 'paid' || order.state === 'cancelled' || order.state === 'closed') return false;
  return order.items.some((it) => !it.voidedAt);
}

// ── Împarte nota ──────────────────────────────────────────────────────────

/** Ca harta meselor din POS-ul web: o notă plătită sau închisă eliberează masa. */
const ACTIVE_STATUSES = new Set(['draft', 'sent', 'preparing', 'ready', 'served']);

/** Notele deschise ale mesei, cea mai veche prima (Nota A, B, C…). */
export function tableChecks(orders: RestaurantOrder[], tableId: string | null): RestaurantOrder[] {
  if (!tableId) return [];
  return orders
    .filter((o) => o.tableId === tableId && ACTIVE_STATUSES.has(o.status) && o.paymentStatus !== 'paid')
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

const LITERE = 'ABCDEFGH';

/** „A”, „B”… după poziție; după H, numere. */
export function checkLetter(index: number): string {
  return LITERE[index] ?? String(index + 1);
}

/** Nota cu încasări, reducere sau bon nu se mai împarte (refuzul serverului,
 *  services/restaurant_mese.py). */
export function isCheckLocked(o: RestaurantOrder): boolean {
  return o.payments.length > 0 || o.discountTotal > 0 || Boolean(o.fiscalReceiptNumber);
}

/** Liniile care se văd în notă (fără cele anulate). */
export function visibleLines(o: RestaurantOrder): OrderItem[] {
  return o.items.filter((i) => i.status !== 'void');
}

export const NEW_CHECK = '__noua__';

/** Se poate muta o bucată din `item` (nota `from`) în ținta aleasă? */
export function canMoveItem(from: RestaurantOrder, item: OrderItem, target: string): boolean {
  return !isCheckLocked(from) && target !== from.id && !item.id.startsWith('local-') && item.status !== 'void';
}

/** Ce trimite o atingere pe produs: o bucată, în nota aleasă sau într-una nouă. */
export function moveRequest(target: string): { toOrderId?: string; newCheck?: boolean } {
  return target === NEW_CHECK ? { newCheck: true } : { toOrderId: target };
}

/** Ținta implicită la deschidere: ultima notă, dacă masa are mai multe;
 *  altfel o notă nouă. */
export function defaultTarget(checks: RestaurantOrder[]): string {
  return checks.length > 1 ? checks[checks.length - 1].id : NEW_CHECK;
}

/** După /items/move: înlocuiește cele două note; nota golită (anulată de
 *  server) dispare din listă. */
export function applyMoveResult(
  checks: RestaurantOrder[],
  r: { from: RestaurantOrder; to: RestaurantOrder },
): RestaurantOrder[] {
  const byId = new Map(checks.map((o) => [o.id, o]));
  byId.set(r.from.id, r.from);
  byId.set(r.to.id, r.to);
  return [...byId.values()]
    .filter((o) => ACTIVE_STATUSES.has(o.status) && o.paymentStatus !== 'paid')
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

/** „Împarte pe locuri” are rost doar când nota are produse pe locuri. */
export function hasSeats(o: RestaurantOrder | null | undefined): boolean {
  return Boolean(o && visibleLines(o).some((i) => (i.seatNo ?? 0) > 0));
}
