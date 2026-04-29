/**
 * Local print dispatcher — used as offline fallback when the backend is
 * unreachable but the printer is still on the LAN. Online prints stay on
 * the backend (single source of truth, audit row in kitchen_printer_jobs).
 */
import { logger } from '@/lib/logger';
import { readPrintersCache, pickPrinterForStation } from './cache';
import {
  buildKitchenTicket,
  buildTestTicket,
  sendEscpos,
  type KitchenTicketContext,
  type KitchenTicketItem,
  type EscposResult,
} from './escpos';

export type LocalPrintOutcome =
  | { ok: true; bytes: number; host: string }
  | { ok: false; reason: 'no_printer' | 'send_failed'; error: string };

export async function printKitchenTicketLocal(
  station: string,
  ticketCtx: Omit<KitchenTicketContext, 'station' | 'paperWidthChars'>,
  items: KitchenTicketItem[],
): Promise<LocalPrintOutcome> {
  const printers = await readPrintersCache();
  const printer = pickPrinterForStation(printers, station);
  if (!printer) {
    logger.warn('print.local', 'no printer cached for station', { station });
    return {
      ok: false,
      reason: 'no_printer',
      error: `No printer cached for station ${station}`,
    };
  }
  const data = buildKitchenTicket(
    {
      ...ticketCtx,
      station,
      paperWidthChars: printer.paper_width_chars || 48,
      printedAt: ticketCtx.printedAt ?? new Date(),
    },
    items,
  );
  const result = await sendEscpos(printer.host, printer.port || 9100, data);
  return result.ok
    ? { ok: true, bytes: result.bytes, host: `${printer.host}:${printer.port}` }
    : {
        ok: false,
        reason: 'send_failed',
        error: result.error || 'unknown',
      };
}

/** Used by the Settings → Imprimante "Test print" button. Calls the
 *  Tauri TCP command directly, NOT the backend — this confirms the
 *  desktop can reach the printer on its own LAN, which is the more
 *  useful diagnostic for the operator. */
export async function testPrintLocal(
  host: string,
  port: number,
  paperWidth: number,
): Promise<EscposResult> {
  const data = buildTestTicket(paperWidth);
  return sendEscpos(host, port, data);
}
