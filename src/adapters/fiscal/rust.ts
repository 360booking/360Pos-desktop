// Rust-backed fiscal adapter — bridges the TS contract to the Tauri commands
// in src-tauri/src/fiscal/. Sprint 1 only wires the simulator provider; the
// Datecs DP-25 / FP-55 path lands in subsequent PRs but goes through the
// same trait so this adapter does not need to change.
//
// The TS contract uses CENT integers (basis points for VAT). The Rust DTO
// uses decimal RON / decimal VAT to match the existing Python wire shape.
// The conversion layer lives here so the rest of the app keeps its
// integer-cent invariant.
import { invoke } from '@tauri-apps/api/core';
import { getConfig } from '@/lib/config';
import type {
  FiscalCancelRequest,
  FiscalDeviceAdapter,
  FiscalReceiptRequest,
  FiscalReceiptResponse,
  FiscalReportResponse,
  FiscalStatus,
} from './types';

interface RustReceiptItem {
  name: string;
  quantity: number;
  unit_price: number;
  vat_rate: number;
}

interface RustReceiptPayment {
  method: 'cash' | 'card' | 'voucher' | 'other';
  amount: number;
}

interface RustReceiptRequest {
  mutation_id: string;
  order_local_id: string;
  fiscal_attempt_id: string;
  items: RustReceiptItem[];
  payments: RustReceiptPayment[];
  currency: string;
  customer_cif: string | null;
  customer_name: string | null;
  footer_note: string | null;
}

interface RustReceiptResponse {
  status: 'printed' | 'failed' | 'unknown';
  fiscal_number: string | null;
  fiscal_date: string | null;
  raw_trace: string;
  error_code: string | null;
  error_message: string | null;
}

interface RustFiscalStatus {
  online: boolean;
  paper_ok: boolean;
  ready: boolean;
  busy: boolean;
  error_code: string | null;
  error_message: string | null;
  raw: string | null;
}

interface RustTestResult {
  ok: boolean;
  detail: string;
}

function mapRequest(req: FiscalReceiptRequest): RustReceiptRequest {
  return {
    mutation_id: req.mutationId,
    order_local_id: req.orderId,
    fiscal_attempt_id: req.fiscalAttemptId,
    items: req.lines.map((l) => ({
      name: l.name,
      quantity: l.quantity,
      unit_price: l.unitPriceCents / 100,
      vat_rate: vatGroupToRate(l.vatGroup),
    })),
    payments: req.payments.map((p) => ({
      method: p.method === 'other' ? 'other' : p.method,
      amount: p.amountCents / 100,
    })),
    currency: 'RON',
    customer_cif: null,
    customer_name: null,
    footer_note: null,
  };
}

// VAT mapping mirrors fiscal-bridge/bridge/printers/datecs_dp25.py:43-48.
// The Rust provider reads the decimal rate, not the letter; for the simulator
// the letter is irrelevant. Once Datecs lands, the Rust side does the mapping.
function vatGroupToRate(group: string): number {
  switch (group) {
    case 'A': return 0.19;
    case 'B': return 0.09;
    case 'C': return 0.05;
    case 'D': return 0.0;
    case 'E': return 0.0;
    default:  return 0.19;
  }
}

export class RustFiscalAdapter implements FiscalDeviceAdapter {
  readonly id = 'fiscal-rust';
  readonly vendor = 'simulator' as const; // overridden once Datecs provider lands

  async status(): Promise<FiscalStatus> {
    const r = await invoke<RustFiscalStatus>('fiscal_get_status');
    return {
      online: r.online,
      paperOk: r.paper_ok,
      ready: r.ready,
      errorCode: r.error_code ?? undefined,
      errorMessage: r.error_message ?? undefined,
      raw: r.raw ?? undefined,
    };
  }

  async printReceipt(req: FiscalReceiptRequest): Promise<FiscalReceiptResponse> {
    // deviceId is ferried so the Rust command can persist a fiscal_attempts
    // row stamped with the local pos-desktop identity. Falls back to null
    // when the device hasn't been paired yet — Rust then logs and skips
    // persistence rather than failing the print.
    const deviceId = getConfig().deviceId ?? null;
    const r = await invoke<RustReceiptResponse>('fiscal_print_receipt', {
      request: mapRequest(req),
      deviceId,
    });
    return {
      status: r.status,
      fiscalNumber: r.fiscal_number ?? undefined,
      fiscalDate: r.fiscal_date ?? undefined,
      rawTrace: r.raw_trace,
      errorCode: r.error_code ?? undefined,
      errorMessage: r.error_message ?? undefined,
    };
  }

  async cancelReceipt(req: FiscalCancelRequest): Promise<FiscalReceiptResponse> {
    const deviceId = getConfig().deviceId ?? null;
    const r = await invoke<RustReceiptResponse>('fiscal_cancel_receipt', {
      request: {
        mutation_id: req.mutationId,
        order_local_id: req.orderId,
        fiscal_attempt_id: req.fiscalAttemptId,
        original_fiscal_number: req.originalFiscalNumber,
        original_fiscal_date: req.originalFiscalDate ?? null,
        items: req.lines.map((l) => ({
          name: l.name,
          quantity: l.quantity,
          unit_price: l.unitPriceCents / 100,
          vat_rate: vatGroupToRate(l.vatGroup),
        })),
        payments: req.payments.map((p) => ({
          method: p.method === 'other' ? 'other' : p.method,
          amount: p.amountCents / 100,
        })),
        currency: 'RON',
        reason: req.reason,
      },
      deviceId,
    });
    return {
      status: r.status,
      fiscalNumber: r.fiscal_number ?? undefined,
      fiscalDate: r.fiscal_date ?? undefined,
      rawTrace: r.raw_trace,
      errorCode: r.error_code ?? undefined,
      errorMessage: r.error_message ?? undefined,
    };
  }

  async printZReport(): Promise<FiscalReportResponse> {
    // Sprint 2 / Q7 — Z-report behind a single-use confirm nonce. The UI
    // is expected to gate the click behind an explicit dialog; here we
    // only enforce the nonce so accidental remote invocations cannot fire
    // a Z directly.
    try {
      const token = await invoke<string>('fiscal_request_z_confirm');
      const r = await invoke<RustReceiptResponse>('fiscal_print_z_report', {
        confirmToken: token,
      });
      return {
        status: r.status,
        rawTrace: r.raw_trace,
        errorCode: r.error_code ?? undefined,
        errorMessage: r.error_message ?? undefined,
      };
    } catch (e) {
      return {
        status: 'failed',
        rawTrace: String(e),
        errorCode: 'Z_REPORT_FAILED',
        errorMessage: String(e),
      };
    }
  }

  async printXReport(): Promise<FiscalReportResponse> {
    try {
      const r = await invoke<RustReceiptResponse>('fiscal_print_x_report');
      return {
        status: r.status,
        rawTrace: r.raw_trace,
        errorCode: r.error_code ?? undefined,
        errorMessage: r.error_message ?? undefined,
      };
    } catch (e) {
      return {
        status: 'failed',
        rawTrace: String(e),
        errorCode: 'X_REPORT_FAILED',
        errorMessage: String(e),
      };
    }
  }

  /** Pop the cash drawer pulse. Returns ok true/false; failure detail is
   *  in the error string. UI surfaces it as a toast. */
  async openDrawer(): Promise<{ ok: boolean; error?: string }> {
    try {
      await invoke<void>('fiscal_open_drawer');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  /** Reprint the last fiscal receipt as a labelled DUPLICATE. */
  async reprintLast(): Promise<FiscalReportResponse> {
    try {
      const r = await invoke<RustReceiptResponse>('fiscal_reprint_last');
      return {
        status: r.status,
        rawTrace: r.raw_trace,
        errorCode: r.error_code ?? undefined,
        errorMessage: r.error_message ?? undefined,
      };
    } catch (e) {
      return {
        status: 'failed',
        rawTrace: String(e),
        errorCode: 'REPRINT_FAILED',
        errorMessage: String(e),
      };
    }
  }

  /** Print periodic memory between two dates (DDMMYY format expected). */
  async printPeriodicMemory(
    dateFrom: string,
    dateTo: string,
  ): Promise<FiscalReportResponse> {
    try {
      const r = await invoke<RustReceiptResponse>('fiscal_print_periodic_memory', {
        dateFrom,
        dateTo,
      });
      return {
        status: r.status,
        rawTrace: r.raw_trace,
        errorCode: r.error_code ?? undefined,
        errorMessage: r.error_message ?? undefined,
      };
    } catch (e) {
      return {
        status: 'failed',
        rawTrace: String(e),
        errorCode: 'PERIODIC_MEMORY_FAILED',
        errorMessage: String(e),
      };
    }
  }
}

// One-shot probe: does the Rust path want to take over? Reads the
// FISCAL_USE_RUST env switch via a Tauri command. Falls back to false in
// non-Tauri contexts (browser dev) so the simulator JS adapter stays in
// charge there.
export async function rustFiscalEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>('fiscal_use_rust_enabled');
  } catch {
    return false;
  }
}

export async function rustFiscalTestConnection(): Promise<RustTestResult> {
  return invoke<RustTestResult>('fiscal_test_connection');
}
