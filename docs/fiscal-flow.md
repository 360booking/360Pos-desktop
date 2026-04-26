# Fiscal Flow (Datecs)

## VAT mapping (verified Sprint 1)

> Source files audited: `backend/src/services/fiscal_service.py`, `backend/src/services/restaurant_order_service.py`, `backend/src/models/restaurant.py`, `backend/src/api/restaurant_orders.py`, `frontend/src/lib/api/restaurant_orders.ts`.

There is **no Romanian A/B/C/D/E enum** in this codebase. The real mapping is:

- **Per-tenant** rates stored in `restaurants.pos_config_json.fiscal`:
  - `vat_rate` (default `0.19`, i.e. 19%)
  - `vat_rate_food` (optional override; applied when `category.type === 'restaurant'`)
  - `vat_rate_bar` (optional override; applied when `category.type === 'bar'`)
- The selection logic lives in `fiscal_service.py:229–246`.
- Menu items have **no** VAT field. The rate is *snapshotted* onto `RestaurantOrderItem.vat_rate` only when `issue_receipt()` runs.
- Prices are **GROSS / VAT-inclusive** (Romanian retail). VAT is backed out:
  ```
  net = round_half_up(gross / (1 + rate));
  vat = gross - net
  ```
  (`fiscal_service.compute_vat_breakdown`, lines 151–162.)
- The order total uses `subtotal − discount + tax_total + tip_total`. `tax_total` is currently always 0 — kept reserved for future per-line tax. `vat_total` is filled only at receipt issuance.

**Inconsistencies flagged for follow-up (do not fix in pos-core, but track):**
1. `tax_total` and `vat_total` are two separate columns on `RestaurantOrder`. Order list endpoints expose `taxTotal` (always 0); `vatTotal` is only returned by `/orders/{id}/receipt`. POS UI cannot preview VAT before fiscalisation. *(pos-core works around this by computing VAT estimative locally; see calculator.)*
2. The comment in `restaurant.py:889` says tip is excluded from VAT, but the formula `total = subtotal − discount + tax + tip` feeds the all-encompassing `total` into the divisor formula at receipt time, so tip *does* get a proportional VAT share in the current backend. **pos-core deliberately deviates: tip is excluded from the VAT base** (matches the stated intent). Documented as a parity delta.
3. Category type is read at receipt issue time, not at item insert time — if a category is reclassified between adding the item and issuing the receipt, the rate drifts. pos-core mirrors backend behaviour by snapshotting at *order item insert* time on the desktop side; backend may overwrite at receipt time. To converge, backend should snapshot at insert too — out of scope for this sprint.

### Tip-in-VAT — official rule (decision: 2026-04-25)

**Rule:** the tip is **not** part of the VAT base. pos-core enforces this; backend currently does not.

**Operator-visible consequence:** the local "TVA" preview in the cart pane may differ by a few bani from the figure printed by the fiscal printer. The POS shell labels its preview accordingly:
- `Subtotal` and `TVA (X% efectiv)` are local *previews*.
- `Total` is local truth as long as no fiscal receipt is issued.
- **The fiscal receipt printed by the cash register is the authoritative VAT figure.** The desktop captures it from the Datecs response and persists it onto `fiscal_receipts.fiscal_number` — never invents one.

**Backend ticket — TODO (Sprint 3):** when `/api/pos/sync/push` lands, either align the backend formula to exclude tip from the VAT base, or add a temporary compatibility flag (`POS_TIP_IN_VAT_BASE = false`) so both compute the same way. Until then, the docs flag the divergence and the UI surfaces "preview" wording.

**Sprint 3 update — done.** `backend/src/services/fiscal_service.py` now uses `_vat_base_for(order)` which returns `subtotal − discount` by default (tip excluded). The legacy behaviour can be restored per-deployment with `POS_TIP_IN_VAT_BASE=true`. Tests in `backend/tests/test_tip_in_vat_alignment.py` cover both modes. pos-core and the backend are now numerically aligned for tipped orders. Per-rate breakdown (`compute_vat_breakdown_per_rate`) was already discount/tip-correct because it sums per-line gross — documented inline.

**Why this approach:**
- We do not copy a known-incorrect backend behaviour just for short-term parity.
- pos-core stays on the right side of the rule; the backend follows in Sprint 3.
- The user-facing risk (~5–15 bani difference on a tipped bill) is small and visible. Operators are trained to trust the fiscal slip, not the screen, for tax totals.

## pos-core mapping

In `pos-desktop/src/core/pos-core/vat.ts`:
- `TenantVatConfig = { defaultRateBp, foodRateBp?, barRateBp? }` — integer basis points (1900 = 19%) to keep math float-free.
- `pickRateForCategory(cfg, type)` mirrors `fiscal_service.py:229–246` exactly.
- `backOutVat(gross, rateBp)` mirrors `compute_vat_breakdown` exactly, with `Math.round` providing ROUND_HALF_UP parity (verified by tests).



The fiscal printer (Datecs DP-25 today, others later) is the **only** authority on the fiscal number. We do not allocate fiscal numbers locally. We do not retry on uncertain outcomes.

## Components

```
React UI ──invoke──▶ FiscalService (TS)
                       │
                       ├── persist fiscal_attempt (SQLite)  ← BEFORE any I/O
                       │
                       ├──▶ FiscalDeviceAdapter (interface)
                       │      ├── DatecsAdapter         (Sprint 5: talks to fiscal-bridge sidecar)
                       │      └── SimulatorAdapter       (default; randomised outcomes)
                       │
                       ├── persist fiscal response + raw trace (SQLite)
                       │
                       └── enqueue sync event for backend
```

## Adapter interface (Sprint 0 contract)

```ts
interface FiscalDeviceAdapter {
  readonly id: string;          // 'datecs-dp25', 'simulator', ...
  readonly vendor: 'datecs' | 'simulator' | 'tremol' | 'partner';

  status(): Promise<FiscalStatus>;
  printReceipt(req: FiscalReceiptRequest): Promise<FiscalReceiptResponse>;
  printZReport(): Promise<ZReportResponse>;
  printXReport(): Promise<XReportResponse>;
}

interface FiscalReceiptRequest {
  mutationId: string;        // idempotency
  orderId: string;
  fiscalAttemptId: string;   // local primary key
  lines: FiscalLine[];       // {name, qty, unitPriceCents, vatGroup}
  payments: FiscalPayment[]; // cash/card; sum must equal sum(lines)
  operator: { code: string; password: string };
}

interface FiscalReceiptResponse {
  status: 'printed' | 'failed' | 'unknown';
  fiscalNumber?: string;     // ONLY set when status === 'printed'
  fiscalDate?: string;
  rawTrace: string;          // raw bytes / framed protocol log, for forensics
  errorCode?: string;
  errorMessage?: string;
}
```

`unknown` means: we sent the command, we did not receive an unambiguous ACK. The receipt may or may not have been printed. **Never retry automatically.**

## Lifecycle (happy path)

1. Operator taps "Fiscalizează".
2. UI calls `FiscalService.printReceipt(order)`.
3. Service generates `mutation_id` + `fiscal_attempt_id` (UUID v4).
4. Service inserts `fiscal_attempts` row with status `pending`, the full request payload, the device ID, and timestamps.
5. Service calls `adapter.printReceipt(...)`.
6. Adapter returns `FiscalReceiptResponse`.
7. Service updates the `fiscal_attempts` row with the response (`status`, `fiscal_number`, `raw_trace`, etc.).
8. If `status === 'printed'`, service inserts a `fiscal_receipts` row with the real fiscal number.
9. Service enqueues a sync event for `/api/pos/fiscal/receipts`.
10. UI shows the receipt confirmation.

## Lifecycle (unknown / timeout)

1–6 same as above.
7. Service updates `fiscal_attempts.status = 'unknown'`.
8. **No `fiscal_receipts` row is created.**
9. Service emits a UI event → Recovery Modal opens.
10. Manager is prompted: *"Bonul s-a imprimat fizic la casă?"*
   - **Yes** → manager enters the fiscal number from the physical receipt; service writes `fiscal_receipts` with `recovery_source = 'manual'` and links to the original `fiscal_attempt_id`.
   - **No** → service marks the attempt `confirmed_failed`; the order returns to "needs fiscal" state and the operator may retry (which creates a NEW attempt with a NEW mutation_id).
11. Backend receives the resolved state via sync.

## Idempotency keys

The chain that prevents double receipts:

| Key | Generated where | Stored in | Purpose |
|---|---|---|---|
| `mutation_id` | UI click handler | `events.mutation_id`, `fiscal_attempts.mutation_id` (UNIQUE) | Backend dedup; replay safety |
| `fiscal_attempt_id` | FiscalService.start | `fiscal_attempts.id` | Local dedup; recovery linkage |
| `local_receipt_id` | FiscalService.success | `fiscal_receipts.id` | Local PK for the printed receipt |
| `order_id` | Order creation | every related row | Group all attempts/receipts per order |
| `device_id` | Device pairing | `fiscal_attempts.device_id` | Audit which terminal printed |
| `fiscal_number` (real) | Datecs response | `fiscal_receipts.fiscal_number` (UNIQUE per tenant) | Source of truth for tax authority |

A hard SQLite unique index on `fiscal_attempts.mutation_id` guarantees two clicks → at most one attempt. A unique index on `(tenant_id, fiscal_number)` server-side guarantees the fiscal number is never registered twice.

## What the service refuses to do

- Pre-allocate fiscal numbers.
- Retry a `failed` attempt without explicit operator click (which generates a new mutation_id).
- Retry an `unknown` attempt at all — only the manager can resolve it.
- Print a fiscal receipt for an order whose payment state has any `payment.status === 'unknown'` (card payments must be resolved first).
- Print without a non-empty operator code/password.

## Demo mode

When `simulatorMode = true` (default in open-source builds), the SimulatorAdapter is used:
- 90% of receipts succeed instantly with a fake fiscal number `SIM-<unix-ms>`.
- 5% return `failed` with a synthetic error.
- 5% return `unknown` after a 2.5s delay — useful for exercising the Recovery flow.

## Simulator vs real (build-time gate)

Real Datecs adapter (Sprint 5) is **opt-in via config**: `config.json.fiscalAdapter = 'datecs'`. Default is `simulator`. The open-source GitHub build never ships the Datecs adapter unless built from a private fork — see `github-public-release.md`.
