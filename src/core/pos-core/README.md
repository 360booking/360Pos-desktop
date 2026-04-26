# pos-core

Pure TypeScript domain core for the 360booking POS desktop. **No React, no I/O, no SQLite, no fetch, no COM.** Every export is a pure function or a plain data type.

This package mirrors the live backend semantics (verified in Sprint 1 by reading `backend/src/services/restaurant_order_service.py` and `fiscal_service.py`). The backend stays the **final** authority on totals, VAT and discount math; pos-core does the **same** math locally for UX/offline only. The two implementations must agree numerically — that is enforced by the test fixtures in `__tests__/parity.test.ts`.

## Layout

```
pos-core/
├── README.md
├── index.ts                    ← public barrel
├── types/                       ← Order, OrderItem, Payment, etc.
├── money.ts                     ← cents-as-integers utilities
├── vat.ts                       ← rate = basis points (1900 = 19%)
├── calculator.ts                ← totals: subtotal, discount, tip, vat, total, paid, remaining, change
├── state-machine.ts             ← 9 states + transition guards
├── actions.ts                   ← 13 pure (state, command) → (state, events)
├── events.ts                    ← SyncEvent envelope + 13 event types
└── __tests__/                   ← Vitest
```

## Money

All currency is **integer cents**. Boundary helpers:
- `toCents(12.50)` → `1250`
- `fromCents(1250)` → `12.50` (display only — never feed back into math)
- `formatMoney(1250, 'RON')` → `'12,50 RON'`
- `safeAddCents(a, b)`, `safeMultiplyCents(qty, unit)` — overflow-checked
- `validateCents(x)` — guards integer-ness

## VAT

Backend reality (see `docs/fiscal-flow.md` § "VAT mapping"):
- VAT rate is **per-tenant**, not per-product, not Romanian A/B/C/D/E.
- Tenant config: `{ defaultRate, foodRate?, barRate? }` — derived from `restaurants.pos_config_json.fiscal`.
- Category `type === 'bar'` → `barRate`; `type === 'restaurant'` → `foodRate`; otherwise → `defaultRate`.
- Prices stored on menu items are **GROSS** (VAT-inclusive — Romanian retail standard).
- VAT is backed out: `vat = gross - gross / (1 + rate)`.

In pos-core, rate is an **integer basis point**: `1900` = 19%, `900` = 9%, `0` = exempt. Keeps math in integer-land.

## State machine

```
draft ──addItem──▶ open ──sendToKitchen──▶ sent_to_kitchen
                                        │
                                        ├─partialPay──▶ partially_paid ─fullPay──▶ paid
                                        └─fullPay────▶ paid
paid ──createFiscalAttempt──▶ fiscal_pending ──ack──▶ fiscally_printed ──close──▶ closed
                                              └──unknown──▶ stays fiscal_pending (manager resolves)
any → cancelled (only from draft/open/sent_to_kitchen)
```

## Guards (raise typed errors when violated)

- `OrderCancelledError` — cannot fiscalise a cancelled order
- `OrderFiscalisedError` — cannot modify items after fiscalisation
- `OrderNotPaidError` — cannot close an unpaid order
- `OfflineCardPaymentError` — card payment forbidden offline
- `FiscalUnknownNoRetryError` — cannot create a new fiscal attempt while a previous one is `unknown`
- `OrderNotOwnedError` — cannot edit an order without local ownership while offline

See `actions.ts` for the call sites.

## Events

Every action returns `{ next: Order; events: SyncEvent[] }`. Each event has `mutationId`, `localTimestamp`, `deviceId`, `orderLocalId`, `orderServerId`, `payload`. Consumers (the sync engine in Sprint 2) persist these to `events` and `sync_outbox` and replay them.
