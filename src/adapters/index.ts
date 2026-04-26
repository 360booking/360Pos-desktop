/**
 * Adapter registry — single import point for the rest of the app.
 *
 * UI never imports concrete adapters; it imports `getFiscal()` etc. so the
 * implementation can be swapped via config (`fiscalAdapter: 'simulator' | 'datecs'`).
 *
 * In Sprint 0 only simulators exist. Sprint 5+ adds production impls.
 */
import type { FiscalDeviceAdapter } from './fiscal/types';
import type { PaymentTerminalAdapter } from './payment/types';
import type { ReceiptPrinterAdapter } from './printer/types';
import { SimulatorFiscalAdapter } from './fiscal/simulator';
import { SimulatorPaymentAdapter } from './payment/simulator';
import { SimulatorPrinterAdapter } from './printer/simulator';
import type { AppConfig } from '@/lib/config';

let _fiscal: FiscalDeviceAdapter | null = null;
let _payment: PaymentTerminalAdapter | null = null;
let _printer: ReceiptPrinterAdapter | null = null;

export function configureAdapters(config: AppConfig): void {
  // Sprint 0: every selection resolves to the simulator. The real Datecs /
  // ESC/POS / ECR adapters are gated by build profile (see
  // docs/github-public-release.md) and slot in here in later sprints.
  switch (config.fiscalAdapter) {
    case 'datecs':
    case 'simulator':
    default:
      _fiscal = new SimulatorFiscalAdapter();
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
