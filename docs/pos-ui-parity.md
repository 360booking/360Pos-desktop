# POS UI Parity — Web ↔ Windows Desktop

Goal: the Windows POS must look and feel ~1:1 with the existing Web POS so a waiter trained on web needs zero retraining on desktop. Differences are allowed *only* where Windows / touchscreen / offline / hardware status demands them, and every difference is documented in this file.

## Source of truth (Web POS)

Inspected during Sprint 0:

| Web file | Lines | Role |
|---|---|---|
| `frontend/src/pages/admin/restaurant/POSPage.tsx` | 1931 | Three-column shell, all action handlers, polling, mobile/cart switching |
| `frontend/src/pages/admin/restaurant/KDSPage.tsx` | 965 | KDS grid (kitchen tickets) |
| `frontend/src/components/admin/restaurant/OfflineIndicator.tsx` | — | Pill: online/offline + queue depth |
| `frontend/src/components/admin/restaurant/LocalOnlyBanner.tsx` | — | Banner shown when running offline |
| `frontend/src/components/admin/restaurant/ReadyOrdersBanner.tsx` | — | Toasts for "ready from kitchen" |
| `frontend/src/components/admin/restaurant/WaiterCallsBanner.tsx` | — | Customer call-waiter pings |
| `frontend/src/components/admin/restaurant/FiscalOrderPanel.tsx` | — | Fiscal print + close flow |
| `frontend/src/components/admin/restaurant/PaymentLinkModal.tsx` | — | Stripe-link payment flow |
| `frontend/src/lib/offlineAwareOrders.ts` | — | Offline mutation wrapper + outbox |
| `frontend/src/lib/syncWorker.ts` | — | Reconnect-and-flush worker |
| `frontend/src/lib/api/restaurant_orders.ts` | — | TS mirror of Pydantic POS models |
| `frontend/src/styles/globals.css` | — | Tailwind base + a few global rules |
| `frontend/tailwind.config.js` | — | Stock Tailwind 3.4 (no theme extensions) |

## Design tokens harvested

| Token | Value |
|---|---|
| Shell background | `bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-950` |
| Body text | `text-slate-100` |
| Muted text | `text-slate-400` |
| Glass card | `bg-white/[0.04] backdrop-blur-sm border border-white/10 rounded-2xl` |
| Pane separator | `border-white/10` |
| Sidebar background | `bg-slate-950/60 backdrop-blur` |
| Primary gradient | `bg-gradient-to-r from-violet-600 to-indigo-600` (hover: `from-violet-500 to-indigo-500`) |
| Destructive | `bg-rose-600/90` (hover: `bg-rose-500`) border `border-rose-400/40` |
| Success accent | `text-emerald-400` |
| Warning accent | `text-amber-300` |
| Accent icons | `text-violet-400` |
| Pill button | `rounded-full px-4 py-1.5 text-sm font-medium` |
| Table card | `aspect-[4/3] rounded-xl` |
| Menu card | `rounded-2xl p-4 min-h-[140px]` |
| Icons | `lucide-react` |
| Font | system stack (`-apple-system, Segoe UI, Roboto, …`) |
| Layout columns | left `w-72`, center `flex-1`, right `w-80`, mobile = single pane + bottom tab bar |

These tokens become the design contract for `pos-desktop`. They are NOT abstracted into a tokens file in Sprint 0 — we copy them verbatim into the desktop app's Tailwind classes so the visual diff stays auditable. A future shared-ui package (Sprint 1+) can extract them, but only after parity is verified.

## What we reuse vs. copy vs. rewrite

### Reuse as-is (Sprint 0)
- `tailwind.config.js` — copied verbatim into pos-desktop. Same content globs, no extensions.
- Lucide icon set — same package, same names.
- System font stack — copied into pos-desktop globals.

### Copy controlled (Sprint 0 — duplicates, with TODO to deduplicate later)
- POS shell layout (3-pane + status header) — re-implemented in `pos-desktop/src/features/pos/PosShell.tsx` using the same Tailwind class strings as `POSPage.tsx`. Not extracted yet because `POSPage.tsx` is 1931 lines of tightly coupled state and pulling out only the JSX would risk regressing the live web POS.
- Card styles, button gradients, status pills — duplicated as Tailwind classes, no `@layer components` abstraction yet.

### Postponed to later sprints
- `OfflineIndicator`, `LocalOnlyBanner`, `ReadyOrdersBanner`, `WaiterCallsBanner` → re-implemented in desktop in Sprint 2 once the local sync engine drives them. The web versions read from `lib/syncWorker.ts` which targets browser IndexedDB; desktop reads from SQLite via Tauri.
- `FiscalOrderPanel`, `PaymentLinkModal` → ported in Sprint 5 (fiscal) and Sprint 7 (payments). Their internals talk to web-only APIs.
- Real menu / table / order rendering with live data → Sprint 4 (UI parity sprint).

### Will NOT be a shared package in Sprint 0
A `packages/shared-ui` is desirable, but extracting it now means modifying `frontend/` imports — explicitly out of scope ("Nu muta frontend-ul existent. Nu rupe deploy-ul"). Documented in `pos-desktop-architecture.md` as a Sprint 1+ candidate.

## Sprint 1 update: VAT row label

`CartPane` shows `TVA (X% efectiv)` where X is the *effective blended* rate computed from the active items. The web POS shows `TVA (19%)` hard-coded — that's misleading on a mixed food + bar order. **Documented delta:** desktop shows the live blended rate; web sticks with the static label until aligned.

## Allowed deltas (Web → Desktop)

| Delta | Reason | Where |
|---|---|---|
| Top status bar with backend / DB / fiscal / payment / printer / queue / online indicators | Desktop is the only place that owns hardware; operator must see device health at a glance | `pos-desktop/src/features/pos/StatusBar.tsx` |
| "Settings → Devices" screen with COM-port selectors and "Test" buttons | Web cannot enumerate COM ports; desktop must | `pos-desktop/src/features/settings/DeviceSettings.tsx` (Sprint 5/6/7) |
| Diagnostic / "Export logs" screen | Field support needs structured logs | Sprint 11 |
| Hard-block UI (modal) when an operation is forbidden offline (card payment, B2B invoicing, etc.) | Web does the same via `HARD_BLOCK_KINDS` set; desktop reuses the rule but visually emphasises it because desktop is where offline is actually likely | Cross-cutting |
| No mobile bottom tab bar | Desktop target is a 1366×768+ touchscreen, not a phone. Mobile layout from the web is dropped | All pages |
| Larger hit areas on touch targets (min 44×44 px) | Capacitive POS touchscreens with gloves | All buttons |
| Single-instance enforcement | Two POS-desktops on same machine = two SQLite handles = corruption risk | Tauri shell |

Any future delta MUST be appended here with a one-line justification. If a delta is not justified, the rule is: match web.

## Open questions affecting parity (to resolve before Sprint 4)
1. Do we render the same dark gradient on a 1080p portrait monitor (some restaurants mount portrait), or fall back to a static dark slate? — needs photo of pilot install.
2. Should "Trimite la bucătărie" stay split from "Plătește" or become a wizard on desktop? Web has them as two separate buttons; we keep that for parity unless ergonomics testing says otherwise.
3. Status bar location: top (matches admin shell) vs. bottom (matches Windows convention)? Default: top, to mirror web.

## Verification checklist (used at end of every UI sprint)
- [ ] Side-by-side screenshot of POS web vs POS desktop on the same data — colours, spacing, font weight match.
- [ ] Operator can complete: select table → add 3 items → send to kitchen → cash payment → fiscal print, without any visual reorientation.
- [ ] No new icon set introduced; lucide-react only.
- [ ] No `@layer components` divergence; deltas live as one-off classes in dedicated desktop files.
- [ ] All deltas listed in this file.

---

## Sprint 4 audit — 2026-04-26

Full pass of `frontend/src/pages/admin/restaurant/POSPage.tsx` (1931 lines) against `pos-desktop/src/features/pos/PosShell.tsx` (349 lines, post-Sprint 4/3). Visual chrome match is good; feature surface is a long way off — most of the hand-off flows (delivery, walk-ins, kitchen pings, payment confirmations) are still on the web side only.

### Visual chrome — matches exactly
- Shell gradient: `bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-950 text-slate-100` ✅
- Pane backgrounds: `bg-slate-950/60 backdrop-blur border-white/10` ✅
- Card hover: `hover:border-violet-400/60 hover:bg-white/[0.08]` ✅
- Primary button gradient: `from-violet-600 to-indigo-600 shadow-lg shadow-violet-900/40` ✅
- Status pills, table card aspect ratio, menu card sizing — all 1:1.

### Tier 1 deltas — present in web, missing in desktop

These are full features, not visual fixes; each is a candidate for its own sprint slice.

#### Tables pane (left)
- **Walk-in / online / phone / aggregator / pickup `SourceSection`s** — collapsible coloured sections above the table grid showing un-seated orders (Cash/Card badges, customer name/phone/address preview). Web only.
- **`KitchenQueueStrip`** — pending ticket count, oldest ticket age, median prep time. Drives waiter awareness of bottlenecks. Web only.
- **Per-table elapsed time** — when a table has a sent order, web shows a Clock icon + `formatElapsed(sent_at)` in the corner. Desktop shows status colour only.
- **Per-table running total** — web shows the open-tab amount on the table card; desktop shows nothing.
- **"+ Comandă telefonică"** secondary footer button (rose-tinted, opens a delivery sheet). Desktop missing.
- **Notification bell toggle** for ready-from-kitchen audio cues (`Bell` / `BellOff`). Desktop missing.

#### Menu pane (centre)
- **Disabled state on product cards when no active order** — web greys them with `opacity-40 cursor-not-allowed`; desktop relies on `useOrderActions.addProduct` to silently no-op (we currently auto-create a draft). Behavioural difference, not visual.
- **Search bar / favourites** — none in either today, but flagged as a likely Sprint 6 ask.

#### Cart pane (right)
- **Inline quantity stepper** per item — web has Minus/Plus buttons (`border-white/10 bg-slate-900/60 rounded-lg`) plus a Trash2 icon for void. Desktop shows a static line.
- **Conditional totals rows** — web renders Discount (emerald), Tip (amber), and `paid` amount (emerald when `paymentStatus !== 'unpaid'`) only when those values are non-zero. Desktop shows only Subtotal / VAT / Total.
- **"Trimite update (N)"** amber variant when items have been added after the last kitchen send. Desktop only has a single disabled `Trimite` stub.
- **"Trimis" locked badge** when the order is fully sent and there's nothing new. Desktop missing.
- **Discount + Tip micro-buttons** on draft orders (`%` and `Bacșiș`). Desktop missing.
- **Card POS two-step confirmation** — web fires a `showCardPosConfirm` modal with step-by-step instructions, "Anulează" / "Plată reușită" buttons. Desktop's Card POS button is permanently disabled.
- **Delivery panel** — when an order has `customer.address`, web shows a rose-bordered box with payment method + customer details + "Trimite link de plată" button (PaymentLinkModal). Desktop missing entirely.
- **Per-line VAT label** — web doesn't show this either, but the desktop's blended-rate label in the totals row is currently the only VAT signal.

#### Modals / drawers fired from the panes (web only)
1. **New-order sheet** — table picker for free tables + walk-in fallback.
2. **Delivery sheet** — customer name, phone, address, delivery payment method, notes.
3. **Payment modal** — remaining amount, optional CUI capture, Cash/Card buttons.
4. **Card-POS confirmation** — instructions while the terminal runs.
5. **Payment-link modal** — Stripe-link URL flow for online checkout.
6. **Fiscal order panel** — receipt preview + reprint.
7. **Cancel order** — reason capture before status flips.

None of these are wired in desktop yet.

### Tier 2 deltas — stubs that desktop already shows but doesn't drive

- `Trimite` button is rendered as `disabled`. Wiring lands when `SENT_TO_KITCHEN` joins the forwarder (Sprint 5). Same for Card POS.
- The VAT label uses the *blended* effective rate (Sprint 1 deviation, see above) — keep until web aligns.

### Tier 3 deltas — desktop-only additions (justified)

- **`StatusBar`** with backend / DB / bootstrap / fiscal / card / printer / queue cells — listed in the "Allowed deltas" table at the top of this file. Web has no equivalent because the browser can't see hardware.
- **Bootstrap-stale indicator** (Sprint 4 / 2). Web has no bootstrap concept; the page just refetches on focus.
- **No mobile bottom-tab bar.** Desktop is always 3-pane. Already documented in "Allowed deltas".

### Empty / loading / error state deltas

- **Loading.** Web: `AdminLayout` with centred spinner + "Se încarcă POS-ul…". Desktop: StatusBar + three empty panes; no spinner.
- **Gated / error.** Web: full-page interstitial with AlertTriangle + back button. Desktop: nothing — operator sees an empty shell.
- **Empty cart.** Both show centred Receipt + guidance copy. Web adds a mobile-only "Deschide meniu" jump button (n/a on desktop).

### Recommended sprint allocation for the deltas

The tier-1 list is too large for a single sprint. Suggested slicing:

| Sprint | Slice | Notes |
|---|---|---|
| 5 ✅ | Inline quantity stepper + per-item void; Trimite / Trimite-update / Trimis state machine; SENT_TO_KITCHEN forwarder | Shipped 2026-04-26 |
| 5 ✅ | Per-table elapsed time + running total | Shipped 2026-04-26 (read from `useCurrentOrder`; multi-table sync = Sprint 6) |
| 6 ✅ | KitchenQueueStrip | Shipped 2026-04-26 — read-only strip above panes, fed by /api/pos/sync/pull |
| 6 ✅ | Open-tabs / multi-table visibility | Shipped 2026-04-26 — TablesPane shows orders from other devices with a lock badge |
| 7 | Walk-in `SourceSection`s + new-order sheet + delivery sheet | Deferred from Sprint 6; rolls into the payment sprint |
| 7 | Payment modal + Card-POS confirmation + payment-link flow | Pairs with the BT POS adapter |
| 8 | Fiscal order panel | Pairs with the Datecs adapter |
| 11 | Notification bell + ready-from-kitchen toasts | Polish |

---

## Sprint 5 closeout — 2026-04-26

Closed in this sprint (Tier-1 rows now striking through):

- ~~Inline quantity stepper per item — web has Minus/Plus buttons + Trash2~~. Desktop has the same Minus/Plus controls in `border-white/10 bg-slate-900/60 rounded-lg overflow-hidden` plus the per-line trash button. `useOrderActions.incrementQuantity` / `decrementQuantity` / `removeItem` route everything through `runAction()` so the events land in the outbox before the UI updates.
- ~~Conditional totals rows (Discount / Bacșiș / Plătit)~~. CartPane now renders the discount line emerald, tip amber, paid emerald, exactly like web — only when the underlying value is non-zero.
- ~~"Trimite update (N)" amber variant~~. New `SendButton` component handles all four states: violet "Trimite" on a fresh draft, amber "Trimite update (N)" when items were added after a previous send, locked "Trimis" badge once everything is sent, and a disabled stub when there's no order.
- ~~Per-table elapsed time + running total~~. `TablesPane` now reads `useCurrentOrder` + `OrderTotals` and stamps each card with a status pill (`Liberă | Deschisă | Netrimis | Trimis | Plată parțială | Plătită`), the running total for the active table, and a `formatElapsed()` clock relative to `order.openedAt`. Limitation: only the table the operator is currently working on shows live state — multi-table simultaneous tracking lands when open-tabs sync ships in Sprint 6.

Backend additions:
- `_handle_sent_to_kitchen` → `restaurant_order_service.send_to_kitchen` (creates one ticket per station). Idempotent: duplicate replays return the same `kitchenTicketIds`.
- `_handle_item_voided` → soft-flags the line (`status='void'`, `line_total=0`) and recalculates totals. Never deletes the row.
- `_handle_item_qty_updated` → `restaurant_order_service.update_item(quantity=…)`. Rejects `quantity <= 0` to keep the void path explicit.
- `_resolve_server_item_id(local_item_id)` → maps the desktop's local UUID to the server-side `RestaurantOrderItem.id` by scanning `pos_sync_events.payload_json` for the prior `ORDER_ITEM_ADDED` whose `localItemId` matches. Cheap because of the `tenant_id` filter.

Pos-core additions:
- `setItemQuantity(order, {itemId, quantity}, ctx)` action + `ORDER_ITEM_QTY_UPDATED` event type.
- `OrderItemAddedPayload` gains `localItemId` so the backend can resolve later mutations on the same line. Existing tests still pass.

Visual deltas remaining (Tier-1 leftovers): walk-in source sections, new-order/delivery sheets, kitchen queue strip, payment modal, card-POS confirmation, fiscal panel, notification bell. Allocations for these are unchanged in the table above.

---

## Sprint 6 closeout — 2026-04-26

Closed in this sprint:

- ~~`KitchenQueueStrip` — read-only display, needs a kitchen tickets feed~~. Shipped as `features/pos/KitchenQueueStrip.tsx`. Compact horizontal strip between StatusBar and the three panes; shows total pending + preparing per station, plus the oldest ticket age. Reads `useRemote.tickets` so it's automatically refreshed on every pull tick. No actions yet — the cook still uses the KDS app for status transitions.
- ~~Open-tabs visibility~~. `TablesPane` now reads `useRemote.orders` and overlays foreign-device orders on the table grid. Each foreign card shows a small `Lock` icon plus the same status pill / total / elapsed time as a locally-active table. The local order always wins when both exist (the pull snapshot may lag the operator's own writes by a few seconds).

New explicit deltas (Tier-3 — desktop-only, justified):

| Delta | Reason | Where |
|---|---|---|
| `KitchenQueueStrip` between StatusBar and panes | Web POS already has it (POSPage.tsx), but desktop adds an even tighter form factor for touchscreens | `pos-desktop/src/features/pos/KitchenQueueStrip.tsx` |
| Lock badge on foreign-device tables | Web POS doesn't show this because every browser is "the same client"; desktop has multiple stations writing to the same `restaurant_orders`, so ownership matters | `pos-desktop/src/features/pos/PosShell.tsx` `TableButton` |

Backend additions:
- `GET /api/pos/sync/pull?since=<iso>` is no longer a stub — returns `changes={orders, orderItems, kitchenTickets}` + `nextCursor` + `serverTime`. Open orders only on first contact; incremental on subsequent calls.
- Five new pull tests cover: cold start (empty), open-order surfacing, incremental cursor filtering, closed-order exclusion on first contact, closed-order surfacing on incremental.

Pos-desktop additions:
- `src/sql/migrations/0003_remote_read_model.sql` — three new SQLite tables (`remote_orders`, `remote_order_items`, `remote_kitchen_tickets`).
- `src-tauri/src/main.rs` registers migration v3.
- `src/lib/api/pull.ts` — typed client.
- `src/lib/sync/applyPull.ts` — UPSERT/DELETE merge into SQLite + cursor persistence.
- `src/lib/sync/runPull.ts` — orchestrator that never throws.
- `src/lib/sync/pullScheduler.ts` — 8-second interval with offline-skip + `runNow()`.
- `src/store/remote.ts` — zustand slice exposing the cached snapshot.
- 3 new vitest tests (`applyPull.test.ts`).

Slice A (walk-in / delivery sheets) is **NOT** done — explicitly deferred per the user's decision (visibility prioritised over commercial intake). Rolled into Sprint 7 alongside the payment sprint.

Each slice closes a row from this audit; when the row's deltas are gone, strike them from the Tier-1 list above.

### What does NOT need to change

- The `feedback` (lower-right toast) layer in web is driven by `react-hot-toast`; desktop already imports the same package. No work needed.
- Both panes use the same lucide icons. No icon swap.
- Both rely on Tailwind 3.4 with no theme extensions. Class strings copy verbatim — no rebuild step.
