/**
 * Contract for fiscal printers (Datecs, Tremol, Partner, …).
 *
 * The contract is intentionally narrow: a fiscal printer prints a
 * receipt, runs Z/X reports, and reports its status. Recovery flows
 * (handling `unknown`) live in the FiscalService, not here.
 *
 * See docs/fiscal-flow.md for the lifecycle that consumes this.
 */
export type FiscalVendor = 'datecs' | 'tremol' | 'partner' | 'simulator';

export interface FiscalDeviceAdapter {
  readonly id: string;
  readonly vendor: FiscalVendor;

  status(): Promise<FiscalStatus>;
  printReceipt(req: FiscalReceiptRequest): Promise<FiscalReceiptResponse>;
  printZReport(): Promise<FiscalReportResponse>;
  printXReport(): Promise<FiscalReportResponse>;
}

export interface FiscalStatus {
  online: boolean;
  paperOk: boolean;
  ready: boolean;
  errorCode?: string;
  errorMessage?: string;
  raw?: string;
}

export type FiscalVatGroup = 'A' | 'B' | 'C' | 'D' | 'E';

export interface FiscalLine {
  name: string;
  quantity: number;
  unitPriceCents: number;
  vatGroup: FiscalVatGroup;
}

export type FiscalPaymentMethod = 'cash' | 'card' | 'voucher' | 'other';

export interface FiscalPayment {
  method: FiscalPaymentMethod;
  amountCents: number;
}

export interface FiscalReceiptRequest {
  mutationId: string;
  orderId: string;
  fiscalAttemptId: string;
  lines: FiscalLine[];
  payments: FiscalPayment[];
  operator: { code: string; password: string };
}

export interface FiscalReceiptResponse {
  status: 'printed' | 'failed' | 'unknown';
  fiscalNumber?: string;
  fiscalDate?: string;
  rawTrace: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface FiscalReportResponse {
  status: 'printed' | 'failed' | 'unknown';
  rawTrace: string;
  errorCode?: string;
  errorMessage?: string;
}
