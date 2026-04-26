/**
 * Contract for kitchen / bar receipt printers (ESC/POS class).
 *
 * Unlike the fiscal adapter, kitchen printers may be retried — the device
 * does not keep state. Reprints carry template = 'reprint' and are
 * stamped REPRINT visibly. See docs/hardware-adapters.md.
 */
export type PrinterVendor = 'simulator' | 'epson-tm' | 'star' | 'datecs-printer';

export type PrinterStation = 'kitchen' | 'bar' | 'pizza' | string;

export interface ReceiptPrinterAdapter {
  readonly id: string;
  readonly vendor: PrinterVendor;

  status(): Promise<PrinterStatus>;
  print(job: PrintJob): Promise<PrintResult>;
}

export interface PrintJob {
  mutationId: string;
  station: PrinterStation;
  template: 'kitchen_ticket' | 'bar_ticket' | 'cancel_ticket' | 'reprint';
  data: KitchenTicketData;
  copies?: number;
}

export interface KitchenTicketData {
  orderNumber: string;
  tableLabel: string;
  operatorName: string;
  sentAt: string;
  items: Array<{
    name: string;
    quantity: number;
    notes?: string;
    modifiers?: string[];
  }>;
  notes?: string;
  reprintMarker?: boolean;
}

export interface PrintResult {
  status: 'printed' | 'failed' | 'unknown';
  durationMs: number;
  rawTrace: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface PrinterStatus {
  online: boolean;
  paperOk: boolean;
  coverClosed: boolean;
  errorCode?: string;
}
