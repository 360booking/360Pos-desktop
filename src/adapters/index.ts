/**
 * Adapter registry — single import point for the rest of the app.
 *
 * UI never imports concrete adapters; it imports `getFiscal()` etc. so the
 * implementation can be swapped via config (`fiscalAdapter: 'simulator' | 'datecs'`).
 *
 * Sprint 11 (fiscal port): `RustFiscalAdapter` calls into the Rust providers
 * via Tauri commands.
 *
 * 2026-10-14 („o singură cale”): inside the desktop app the fiscal adapter is
 * ALWAYS the Rust one — never the JS simulator, whatever `use_rust` says. The
 * Rust side refuses the simulator / an unconfigured station with a clear
 * Romanian error, so nothing here can answer "printed" without a register.
 * The JS `SimulatorFiscalAdapter` is left only for the browser (vite dev, CI).
 */
import type { FiscalDeviceAdapter } from './fiscal/types';
import type { PaymentTerminalAdapter } from './payment/types';
import type { ReceiptPrinterAdapter } from './printer/types';
import { SimulatorFiscalAdapter } from './fiscal/simulator';
import { RustFiscalAdapter, rustFiscalEnabled } from './fiscal/rust';
import { SimulatorPaymentAdapter } from './payment/simulator';
import { SimulatorPrinterAdapter } from './printer/simulator';
import type { AppConfig } from '@/lib/config';

let _fiscal: FiscalDeviceAdapter | null = null;

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
let _payment: PaymentTerminalAdapter | null = null;
let _printer: ReceiptPrinterAdapter | null = null;

export function configureAdapters(config: AppConfig): void {
  // Synchronous bootstrap stays as-is so existing callers never await. The
  // Rust path takes over only after `enableRustFiscalIfAllowed()` resolves
  // — that's invoked from the device-status hook on mount.
  switch (config.fiscalAdapter) {
    case 'datecs':
    case 'simulator':
    default:
      _fiscal = inTauri() ? new RustFiscalAdapter() : new SimulatorFiscalAdapter();
      break;
  }
  switch (config.paymentAdapter) {
    case 'bt-ecr':
    case 'simulator':
    default:
      _payment = new SimulatorPaymentAdapter();
      break;
  }
  switch (config.printerAdapter) {
    case 'escpos':
    case 'simulator':
    default:
      _printer = new SimulatorPrinterAdapter();
      break;
  }
}

/** Promote the fiscal adapter to RustFiscalAdapter when FISCAL_USE_RUST=true.
 *  Idempotent. Safe to call from non-Tauri (returns false there). */
export async function enableRustFiscalIfAllowed(): Promise<boolean> {
  if (_fiscal instanceof RustFiscalAdapter) return true;
  if (inTauri()) {
    _fiscal = new RustFiscalAdapter();
    return true;
  }
  const enabled = await rustFiscalEnabled();
  if (!enabled) return false;
  _fiscal = new RustFiscalAdapter();
  return true;
}

export function getFiscal(): FiscalDeviceAdapter {
  if (!_fiscal) configureAdapters(/* default */ { simulatorMode: true } as AppConfig);
  return _fiscal!;
}

export function getPayment(): PaymentTerminalAdapter {
  if (!_payment) configureAdapters(/* default */ { simulatorMode: true } as AppConfig);
  return _payment!;
}

export function getPrinter(): ReceiptPrinterAdapter {
  if (!_printer) configureAdapters(/* default */ { simulatorMode: true } as AppConfig);
  return _printer!;
}

export type { FiscalDeviceAdapter } from './fiscal/types';
export type { PaymentTerminalAdapter } from './payment/types';
export type { ReceiptPrinterAdapter } from './printer/types';
export * from './fiscal/types';
export * from './payment/types';
export * from './printer/types';
