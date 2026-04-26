import type {
  FiscalDeviceAdapter,
  FiscalReceiptRequest,
  FiscalReceiptResponse,
  FiscalReportResponse,
  FiscalStatus,
} from './types';
import { jitter, pickOutcome } from '../shared/random';

/**
 * Deterministic-ish simulator. 90% success / 5% failure / 5% unknown.
 * Used everywhere by default and in CI. See docs/hardware-adapters.md.
 */
export class SimulatorFiscalAdapter implements FiscalDeviceAdapter {
  readonly id = 'fiscal-simulator';
  readonly vendor = 'simulator' as const;

  async status(): Promise<FiscalStatus> {
    await jitter(50, 150);
    return { online: true, paperOk: true, ready: true, raw: 'SIM_STATUS_OK' };
  }

  async printReceipt(req: FiscalReceiptRequest): Promise<FiscalReceiptResponse> {
    const outcome = pickOutcome();
    if (outcome === 'success') {
      await jitter(200, 600);
      const fiscalNumber = `SIM-${Date.now()}`;
      return {
        status: 'printed',
        fiscalNumber,
        fiscalDate: new Date().toISOString(),
        rawTrace: `SIM print mut=${req.mutationId} order=${req.orderId} -> ${fiscalNumber}`,
      };
    }
    if (outcome === 'failed') {
      await jitter(100, 300);
      return {
        status: 'failed',
        rawTrace: `SIM print mut=${req.mutationId} -> ERR_PAPER`,
        errorCode: 'ERR_PAPER',
        errorMessage: 'Simulated paper jam',
      };
    }
    // unknown: hold the line, then return without an ACK.
    await jitter(2500, 4000);
    return {
      status: 'unknown',
      rawTrace: `SIM print mut=${req.mutationId} -> NO_ACK`,
      errorCode: 'TIMEOUT',
      errorMessage: 'Simulated NAK / timeout',
    };
  }

  async printZReport(): Promise<FiscalReportResponse> {
    await jitter(300, 600);
    return { status: 'printed', rawTrace: 'SIM Z report ok' };
  }

  async printXReport(): Promise<FiscalReportResponse> {
    await jitter(200, 500);
    return { status: 'printed', rawTrace: 'SIM X report ok' };
  }
}
