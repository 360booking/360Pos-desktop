/**
 * BT POS (ECR Protocol) — Sprint 9 skeleton.
 *
 * Real implementation is intentionally deferred to Sprint 10 / pilot
 * Windows session. This file holds the contract + the throw-on-call
 * stubs so:
 *
 *   - the rest of the codebase can import + reference it now (e.g.
 *     RecoveryTray's "Retry status check" calls statusForRrn);
 *   - swapping simulator → real adapter is a one-line change in
 *     PaymentModal's `_terminalFactory` and a config flag;
 *   - integration tests against a real terminal can be authored on
 *     Windows without touching this file again.
 *
 * BT's ECR Protocol runs over a local TCP/serial channel exposed by
 * the fiscal-bridge sidecar (`fiscal-bridge.exe` on Windows, listening
 * on 127.0.0.1:17891 — see `reference_bt_pos_terminal_integration` in
 * the project memory). The actual wire protocol is BT-specific and
 * documented in BT's "ECR Protocol Specifications". Sprint 10 task:
 *
 *   1. Read the ECR spec (BT will share the PDF on activation).
 *   2. Implement charge() / refund() / cancel() with explicit timeouts
 *      that map terminal NAK / no-response to ChargeResponse.status=
 *      'unknown' so PaymentModal's recovery flow kicks in.
 *   3. Implement statusForRrn() — terminal status-by-RRN query — so
 *      RecoveryTray's "Retry status check" can confirm the unknown.
 *   4. Capture a wire trace on first install for forensics.
 */
import type {
  ChargeRequest,
  ChargeResponse,
  PaymentTerminalAdapter,
  PaymentTerminalStatus,
  RefundRequest,
} from './types';

export interface BtEcrConfig {
  /** Where the sidecar exposes the ECR bridge. */
  bridgeUrl: string; // e.g. 'http://127.0.0.1:17891'
  /** Terminal serial / merchant id, baked into every charge envelope. */
  terminalId?: string;
  /** Operator override — defaults to the desktop's pos_devices.device_id. */
  operatorId?: string;
}

/** Status-by-RRN response used by RecoveryTray "Retry" button. */
export interface TerminalStatusForRrn {
  rrn: string;
  status: 'approved' | 'declined' | 'cancelled' | 'unknown' | 'not_found';
  authCode?: string;
  rawTrace?: string;
}

export class BtEcrPaymentAdapter implements PaymentTerminalAdapter {
  readonly id = 'payment-bt-ecr';
  readonly vendor = 'bt-ecr' as const;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(public readonly cfg: BtEcrConfig) {}

  async status(): Promise<PaymentTerminalStatus> {
    throw new Error('BT POS adapter — pilot Windows. Sprint 10 wires the real ECR exchange.');
  }

  async charge(_req: ChargeRequest): Promise<ChargeResponse> {
    throw new Error('BT POS adapter — pilot Windows. Sprint 10 wires the real ECR exchange.');
  }

  async refund(_req: RefundRequest): Promise<ChargeResponse> {
    throw new Error('BT POS adapter — pilot Windows. Sprint 10 wires the real ECR exchange.');
  }

  async cancel(): Promise<void> {
    throw new Error('BT POS adapter — pilot Windows. Sprint 10 wires the real ECR exchange.');
  }

  /** Used by RecoveryTray to verify whether an `unknown` charge actually
   * went through. Real BT ECR has a "QUERY by RRN" command; until the
   * pilot, this stays a stub. */
  async statusForRrn(_rrn: string): Promise<TerminalStatusForRrn> {
    throw new Error(
      'BT POS adapter statusForRrn — pilot Windows. Wires up alongside the rest of the ECR commands in Sprint 10.',
    );
  }
}

/** RecoveryTray-friendly null-object so the Retry button can call into
 * something even when no real adapter is configured. Returns
 * `not_found` so the UI surfaces "manual reconciliation required". */
export const NULL_BT_ECR_ADAPTER = {
  async statusForRrn(rrn: string): Promise<TerminalStatusForRrn> {
    return {
      rrn,
      status: 'not_found',
      rawTrace: 'BT POS adapter not configured — Sprint 10 hookup pending.',
    };
  },
};
