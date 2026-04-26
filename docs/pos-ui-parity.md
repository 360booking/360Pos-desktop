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
