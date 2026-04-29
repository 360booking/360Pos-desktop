/**
 * ESC/POS payload builder — port of backend `kitchen_printer.py`.
 *
 * Used both by:
 *   - Settings → Imprimante "Test print" (sanity bytes for the test page)
 *   - Offline fallback dispatch (when backend is unreachable, the desktop
 *     prints kitchen tickets locally so the cook still sees the order).
 *
 * Diacritics are stripped to ASCII because Epson's default codepage
 * (PC437) doesn't include ăâîșț; with stripped letters the bon stays
 * legible without per-printer codepage tuning.
 */
import { invoke } from '@tauri-apps/api/core';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const INIT = bytes(ESC, 0x40);
const CUT_PARTIAL = bytes(GS, 0x56, 0x42, 0x00);
const DOUBLE_HW = bytes(ESC, 0x21, 0x30);
const NORMAL = bytes(ESC, 0x21, 0x00);
const BOLD_ON = bytes(ESC, 0x45, 0x01);
const BOLD_OFF = bytes(ESC, 0x45, 0x00);
const ALIGN_CENTER = bytes(ESC, 0x61, 0x01);
const ALIGN_LEFT = bytes(ESC, 0x61, 0x00);

const DIACRITIC_MAP: Record<string, string> = {
  'ă': 'a', 'â': 'a', 'î': 'i', 'ș': 's', 'ş': 's', 'ț': 't', 'ţ': 't',
  'Ă': 'A', 'Â': 'A', 'Î': 'I', 'Ș': 'S', 'Ş': 'S', 'Ț': 'T', 'Ţ': 'T',
};

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

function asciiSafe(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .split('')
    .map((c) => DIACRITIC_MAP[c] ?? c)
    .join('');
}

function asciiBytes(s: string): Uint8Array {
  const safe = asciiSafe(s);
  const out = new Uint8Array(safe.length);
  for (let i = 0; i < safe.length; i++) {
    const code = safe.charCodeAt(i);
    out[i] = code > 127 ? 0x3f : code;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function lf(): Uint8Array {
  return bytes(LF);
}

function rule(width: number): Uint8Array {
  const out = new Uint8Array(width + 1);
  out.fill(0x2d, 0, width);
  out[width] = LF;
  return out;
}

export interface KitchenTicketItem {
  quantity: number;
  nameSnapshot: string;
  variantLabel?: string | null;
  kitchenNotes?: string | null;
}

export interface KitchenTicketContext {
  station: string;
  paperWidthChars: number;
  tableLabel?: string | null;
  source?: string | null;
  customerName?: string | null;
  orderShortId?: string | null;
  waiterShortId?: string | null;
  notes?: string | null;
  printedAt?: Date | null;
}

export function buildKitchenTicket(
  ctx: KitchenTicketContext,
  items: KitchenTicketItem[],
): Uint8Array {
  const width = Math.max(20, Math.min(64, ctx.paperWidthChars || 48));
  const parts: Uint8Array[] = [];
  parts.push(INIT);

  parts.push(ALIGN_CENTER, DOUBLE_HW, BOLD_ON);
  parts.push(asciiBytes(`*** ${(ctx.station || 'KITCHEN').toUpperCase()} ***`), lf());
  parts.push(BOLD_OFF, NORMAL);

  const labelParts: string[] = [];
  if (ctx.tableLabel) labelParts.push(`MASA ${ctx.tableLabel}`);
  else if (ctx.source) labelParts.push(ctx.source.toUpperCase());
  if (ctx.customerName) labelParts.push(ctx.customerName);
  if (labelParts.length > 0) {
    parts.push(DOUBLE_HW, asciiBytes(labelParts.join(' / ')), lf(), NORMAL);
  }
  if (ctx.orderShortId) {
    parts.push(ALIGN_CENTER, asciiBytes(`#${ctx.orderShortId}`), lf());
  }
  parts.push(ALIGN_LEFT, rule(width));

  parts.push(BOLD_ON);
  for (const it of items) {
    const qty = Math.max(1, Math.floor(it.quantity || 1));
    parts.push(asciiBytes(`${qty} x ${it.nameSnapshot || '?'}`), lf());
    if (it.variantLabel) parts.push(asciiBytes(`  ${it.variantLabel}`), lf());
    if (it.kitchenNotes) parts.push(asciiBytes(`  >> ${it.kitchenNotes}`), lf());
  }
  parts.push(BOLD_OFF, rule(width));

  const ts = formatTimestamp(ctx.printedAt ?? new Date());
  parts.push(asciiBytes(ts), lf());
  if (ctx.waiterShortId) parts.push(asciiBytes(`Ospatar: ${ctx.waiterShortId}`), lf());
  if (ctx.notes) parts.push(asciiBytes(`Note: ${ctx.notes}`), lf());

  parts.push(lf(), lf(), lf(), CUT_PARTIAL);
  return concat(parts);
}

export function buildTestTicket(paperWidthChars: number): Uint8Array {
  const width = Math.max(20, Math.min(64, paperWidthChars || 48));
  const parts: Uint8Array[] = [
    INIT,
    ALIGN_CENTER,
    DOUBLE_HW,
    BOLD_ON,
    asciiBytes('*** TEST PRINT ***'),
    lf(),
    BOLD_OFF,
    NORMAL,
    rule(width),
    asciiBytes('360booking POS desktop'),
    lf(),
    asciiBytes(formatTimestamp(new Date())),
    lf(),
    rule(width),
    lf(),
    lf(),
    lf(),
    CUT_PARTIAL,
  ];
  return concat(parts);
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface EscposResult {
  ok: boolean;
  bytes: number;
  error: string | null;
}

/** Wrapper over the Tauri `escpos_send` command. */
export async function sendEscpos(
  host: string,
  port: number,
  data: Uint8Array,
): Promise<EscposResult> {
  return await invoke<EscposResult>('escpos_send', {
    host,
    port: Math.floor(port) || 9100,
    data: Array.from(data),
  });
}
