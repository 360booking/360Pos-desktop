/**
 * Local printer config cache (SQLite settings table).
 *
 * Why: when the desktop is offline (backend unreachable) we still need
 * the printer host:port to send a kitchen ticket. The web admin owns
 * the canonical config — we mirror it locally on every successful
 * `kitchenPrintersApi.list()` so the offline fallback has fresh data.
 */
import { initDb } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { KitchenPrinter } from '@/lib/api/kitchenPrinters';

const KEY = 'kitchen_printers_cache';

export async function readPrintersCache(): Promise<KitchenPrinter[]> {
  try {
    const db = await initDb();
    const rows = await db.select<{ value_json: string }[]>(
      'SELECT value_json FROM settings WHERE key = ?',
      [KEY],
    );
    const raw = rows[0]?.value_json;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as KitchenPrinter[]) : [];
  } catch (err) {
    logger.warn('print.cache', 'read failed', { err: String(err) });
    return [];
  }
}

export async function writePrintersCache(printers: KitchenPrinter[]): Promise<void> {
  try {
    const db = await initDb();
    await db.execute(
      `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                      updated_at = datetime('now')`,
      [KEY, JSON.stringify(printers || [])],
    );
  } catch (err) {
    logger.warn('print.cache', 'write failed', { err: String(err) });
  }
}

export function pickPrinterForStation(
  printers: KitchenPrinter[],
  station: string | null | undefined,
): KitchenPrinter | null {
  if (!printers || printers.length === 0) return null;
  const target = (station || '').trim().toLowerCase();
  for (const p of printers) {
    if ((p.station || '').trim().toLowerCase() === target && p.enabled !== false) {
      return p;
    }
  }
  for (const p of printers) {
    if (p.enabled !== false) return p;
  }
  return null;
}
