/**
 * Contract for card terminals (BT POS / Ingenico / Verifone).
 *
 * Designed so a future companion app ("payment-client") can implement
 * this interface over local HTTP without forcing UI changes. See
 * docs/hardware-adapters.md.
 */
export type PaymentVendor = 'simulator' | 'bt-ecr' | 'ingenico' | 'verifone';

export interface PaymentTerminalAdapter {
  readonly id: string;
  readonly vendor: PaymentVendor;

  status(): Promise<PaymentTerminalStatus>;
  charge(req: ChargeRequest): Promise<ChargeResponse>;
  refund(req: RefundRequest): Promise<ChargeResponse>;
  cancel(): Promise<void>;
}

export interface PaymentTerminalStatus {
  online: boolean;
  ready: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export type Currency = 'RON' | 'EUR' | 'USD';

export interface ChargeRequest {
  mutationId: string;
  orderId: string;
  amountCents: number;
  currency: Currency;
}

export interface RefundRequest {
  mutationId: string;
  originalRrn: string;
  amountCents: number;
  currency: Currency;
}

export interface ChargeResponse {
  status: 'approved' | 'declined' | 'cancelled' | 'unknown';
  authCode?: string;
  rrn?: string;
  last4?: string;
  cardScheme?: string;
  rawTrace: string;
  errorCode?: string;
  errorMessage?: string;
}

export class OfflineNotAllowedError extends Error {
  constructor() {
    super('Card payments cannot be processed offline.');
    this.name = 'OfflineNotAllowedError';
  }
}
