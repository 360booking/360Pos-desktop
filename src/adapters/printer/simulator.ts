import type {
  PrintJob,
  PrintResult,
  PrinterStatus,
  ReceiptPrinterAdapter,
} from './types';
import { jitter, pickOutcome } from '../shared/random';

export class SimulatorPrinterAdapter implements ReceiptPrinterAdapter {
  readonly id = 'printer-simulator';
  readonly vendor = 'simulator' as const;

  async status(): Promise<PrinterStatus> {
    await jitter(20, 80);
    return { online: true, paperOk: true, coverClosed: true };
  }

  async print(job: PrintJob): Promise<PrintResult> {
    const start = Date.now();
    const outcome = pickOutcome();
    if (outcome === 'success') {
      await jitter(150, 450);
      return {
        status: 'printed',
        durationMs: Date.now() - start,
        rawTrace: `SIM print station=${job.station} tpl=${job.template} mut=${job.mutationId}`,
      };
    }
    if (outcome === 'failed') {
      await jitter(100, 300);
      return {
        status: 'failed',
        durationMs: Date.now() - start,
        rawTrace: `SIM print station=${job.station} mut=${job.mutationId} -> OUT_OF_PAPER`,
        errorCode: 'OUT_OF_PAPER',
        errorMessage: 'Simulated paper out',
      };
    }
    await jitter(2500, 4000);
    return {
      status: 'unknown',
      durationMs: Date.now() - start,
      rawTrace: `SIM print station=${job.station} mut=${job.mutationId} -> NO_ACK`,
      errorCode: 'TIMEOUT',
      errorMessage: 'Simulated printer timeout',
    };
  }
}
