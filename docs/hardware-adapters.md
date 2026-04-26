# Hardware Adapters

Three adapter contracts. Each has at least one simulator implementation (default) and a production implementation added in a later sprint.

## Common rules

- Adapters live in `pos-desktop/src/adapters/<kind>/`.
- Each kind exports an interface, a registry, and one or more implementations.
- A service layer (`pos-desktop/src/features/<feature>/service.ts`) is the only consumer. UI components never import adapters directly.
- Every adapter call carries a `mutationId` for idempotency.
- Every adapter call returns a structured result that includes a `rawTrace` for diagnostics.

## FiscalDeviceAdapter

See `fiscal-flow.md` for the full lifecycle. Sprint 0 ships the interface + simulator.

## PaymentTerminalAdapter

```ts
interface PaymentTerminalAdapter {
  readonly id: string;
  readonly vendor: 'simulator' | 'bt-ecr' | 'ingenico' | 'verifone';

  status(): Promise<PaymentTerminalStatus>;
  charge(req: ChargeRequest): Promise<ChargeResponse>;
  refund(req: RefundRequest): Promise<RefundResponse>;
  cancel(): Promise<void>;        // cancel current in-flight charge
}

interface ChargeRequest {
  mutationId: string;
  orderId: string;
  amountCents: number;
  currency: 'RON' | 'EUR' | 'USD';
}

interface ChargeResponse {
  status: 'approved' | 'declined' | 'cancelled' | 'unknown';
  authCode?: string;
  rrn?: string;
  last4?: string;
  cardScheme?: string;
  rawTrace: string;
  errorCode?: string;
  errorMessage?: string;
}
```

Rules:
- Card charging is **always** an online operation. `charge()` MUST throw `OfflineNotAllowedError` if the offline detector reports the device offline at the moment of call.
- `unknown` triggers a recovery dialog like fiscal — never auto-retried, never auto-fiscalised.
- The adapter is intentionally narrow so a future "payment-client" companion app (replacing the in-process adapter) can implement it via HTTP without changing UI code.

## ReceiptPrinterAdapter

```ts
interface ReceiptPrinterAdapter {
  readonly id: string;
  readonly vendor: 'simulator' | 'epson-tm' | 'star' | 'datecs-printer';

  status(): Promise<PrinterStatus>;
  print(job: PrintJob): Promise<PrintResult>;
}

interface PrintJob {
  mutationId: string;
  station: 'kitchen' | 'bar' | 'pizza' | string;
  template: 'kitchen_ticket' | 'bar_ticket' | 'cancel_ticket' | 'reprint';
  data: KitchenTicketData;
  copies?: number;
}

interface PrintResult {
  status: 'printed' | 'failed' | 'unknown';
  durationMs: number;
  rawTrace: string;
  errorCode?: string;
  errorMessage?: string;
}

interface PrinterStatus {
  online: boolean;
  paperOk: boolean;
  coverClosed: boolean;
  errorCode?: string;
}
```

Rules:
- `out_of_paper` and `cover_open` are surfaced in the status bar with a destructive colour. `send-to-kitchen` is hard-blocked while either is true.
- Retry is allowed for printer (unlike fiscal): the printer doesn't keep state; if the previous attempt was `unknown`, the reprint is marked `template = 'reprint'` and visibly stamped "REPRINT".
- One queue per station; a stuck pizza printer doesn't block the bar.

## Simulators (Sprint 0)

All three simulators are implemented in Sprint 0 with deterministic-but-jittery behaviour:

| Outcome | Simulator probability | Latency |
|---|---|---|
| Success | 90% | 200–600 ms |
| Failure (synthetic error code) | 5% | 100–300 ms |
| Unknown (timeout-like) | 5% | 2.5–4 s |

They drive the UI through every path without any hardware attached. CI runs against simulators only.

## Production adapters (later sprints)

| Adapter | Sprint | Transport | Notes |
|---|---|---|---|
| Datecs DP-25 | 5 | Sidecar Python (existing fiscal-bridge) over stdio JSON-RPC | Reuses FP-55 protocol code; no rewrite. |
| ESC/POS printer | 6 | Rust crate `escpos` over `serialport-rs` | Direct in src-tauri, exposed as a Tauri command. |
| BT POS terminal (ECR) | 7 | Sidecar (Rust or Python) over local TCP/COM | Protocol gated on BT enabling ECR mode. |

## Where adapters get their COM-port settings

From `lib/config.ts`, which reads `~/AppData/360booking-pos/config.json` (template at `pos-desktop/config.example.json`). Keys: `fiscalComPort`, `paymentComPort`, `printerComPort`. The Settings → Devices screen (Sprint 5/6/7) writes those keys after the operator picks from a Tauri-enumerated COM port list.

## Failure surface

Every adapter logs:
- A structured row in `device_logs` for every call (level, source, message, context).
- A trace blob into `fiscal_attempts.raw_trace` / `payments.raw_response` / `print_jobs.raw_trace` for the specific call.

This is the source for the "Export logs" diagnostic (Sprint 11).
