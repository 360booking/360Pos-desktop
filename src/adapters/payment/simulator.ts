import type {
  ChargeRequest,
  ChargeResponse,
  PaymentTerminalAdapter,
  PaymentTerminalStatus,
  RefundRequest,
} from './types';
import { jitter, pickOutcome } from '../shared/random';

export class SimulatorPaymentAdapter implements PaymentTerminalAdapter {
  readonly id = 'payment-simulator';
  readonly vendor = 'simulator' as const;

  async status(): Promise<PaymentTerminalStatus> {
    await jitter(50, 150);
    return { online: true, ready: true };
  }

  async charge(req: ChargeRequest): Promise<ChargeResponse> {
    const outcome = pickOutcome();
    if (outcome === 'success') {
      await jitter(800, 1800);
      return {
        status: 'approved',
        authCode: `SIM${Math.floor(Math.random() * 1_000_000)
          .toString()
          .padStart(6, '0')}`,
        rrn: Date.now().toString(),
        last4: '4242',
        cardScheme: 'VISA',
        rawTrace: `SIM charge mut=${req.mutationId} amt=${req.amountCents} -> APPROVED`,
      };
    }
    if (outcome === 'failed') {
      await jitter(400, 900);
      return {
        status: 'declined',
        rawTrace: `SIM charge mut=${req.mutationId} -> DECLINED`,
        errorCode: '05',
        errorMessage: 'Simulated declined by issuer',
      };
    }
    await jitter(2500, 4000);
    return {
      status: 'unknown',
      rawTrace: `SIM charge mut=${req.mutationId} -> NO_RESPONSE`,
      errorCode: 'TIMEOUT',
      errorMessage: 'Simulated terminal timeout',
    };
  }

  async refund(req: RefundRequest): Promise<ChargeResponse> {
    await jitter(600, 1200);
    return {
      status: 'approved',
      authCode: `RFND${Date.now()}`,
      rrn: req.originalRrn,
      rawTrace: `SIM refund mut=${req.mutationId} amt=${req.amountCents} rrn=${req.originalRrn}`,
    };
  }

  async cancel(): Promise<void> {
    await jitter(50, 100);
  }
}
