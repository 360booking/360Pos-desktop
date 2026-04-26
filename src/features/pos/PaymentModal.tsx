/**
 * Payment modal — Sprint 7.
 *
 * Two payment paths today (no Mixed/partial yet):
 *
 *   Cash:   immediate registerCashPayment for a configurable amount
 *           (default = remaining). Over-tender is accepted and
 *           change_due gets surfaced inline.
 *
 *   Card:   two-step state machine driven by the SimulatorPaymentAdapter.
 *           1. user taps "Card" → status='dialling' → terminal.charge()
 *              fires.
 *           2. simulator returns approved / declined / unknown after a
 *              short jittered delay.
 *           3. approved → registerCardPaymentResult; modal closes.
 *           4. declined → toast on the modal, retry available.
 *           5. unknown  → registerCardPaymentResult({status:'unknown'})
 *                         which emits CARD_PAYMENT_UNKNOWN; the modal
 *                         shows a recovery prompt and DOES NOT mark the
 *                         order paid. Manual reconciliation is required.
 *
 * Card payments are blocked offline (`assertCardPaymentAllowed` in
 * pos-core registerCardPaymentResult); we also disable the button
 * upfront so the operator gets a clear "online required" hint.
 *
 * The real BT POS adapter ships in Sprint 8+; this modal works against
 * any PaymentTerminalAdapter implementation, so the swap is a one-line
 * change in PosShell.
 */
import { useMemo, useState } from 'react';
import {
  Banknote,
  CreditCard,
  X,
  AlertTriangle,
  CheckCircle2,
  Loader,
  WifiOff,
} from 'lucide-react';
import { formatMoney } from '@/core/pos-core';
import type { OrderTotals } from '@/core/pos-core';
import { SimulatorPaymentAdapter } from '@/adapters/payment/simulator';
import { getConfig } from '@/lib/config';
import { useRecovery } from '@/store/recovery';
import { getSyncEngine } from '@/lib/sync/bootstrap';

type CardPhase =
  | 'idle'
  | 'dialling'
  | 'approved'
  | 'declined'
  | 'unknown'
  | 'cancelled';

interface PaymentModalProps {
  orderId: string;
  totals: OrderTotals;
  onClose: () => void;
  onCash: (amountCents: number, acceptOverTender: boolean) => Promise<void>;
  onCardOutcome: (
    amountCents: number,
    status: 'approved' | 'declined' | 'cancelled' | 'unknown',
    terminal: { authCode?: string; rrn?: string; trace?: string },
  ) => Promise<void>;
}

/** A small helper so the test suite can swap the adapter via a hook. */
let _terminalFactory: () => Promise<{
  charge(req: {
    mutationId: string;
    orderId: string;
    amountCents: number;
    currency: 'RON';
  }): Promise<{
    status: 'approved' | 'declined' | 'cancelled' | 'unknown';
    authCode?: string;
    rrn?: string;
    rawTrace: string;
  }>;
}> = async () => new SimulatorPaymentAdapter();

export function __setTerminalFactoryForTests(fn: typeof _terminalFactory) {
  _terminalFactory = fn;
}

export function PaymentModal({ orderId, totals, onClose, onCash, onCardOutcome }: PaymentModalProps) {
  const cfg = getConfig();
  const isOnline = cfg.syncTransportMode === 'http';
  const remaining = Math.max(0, totals.totalCents - totals.paidCents);

  const [tender, setTender] = useState<number>(remaining);
  const [cashWorking, setCashWorking] = useState(false);
  const [cashError, setCashError] = useState<string | null>(null);

  const [cardPhase, setCardPhase] = useState<CardPhase>('idle');
  const [cardError, setCardError] = useState<string | null>(null);

  const tenderCents = useMemo(() => Math.max(0, Math.round(tender)), [tender]);
  const changeDue = Math.max(0, tenderCents - remaining);

  async function handleCash() {
    setCashError(null);
    setCashWorking(true);
    try {
      await onCash(tenderCents, tenderCents > remaining);
      onClose();
    } catch (err) {
      setCashError((err as Error).message);
    } finally {
      setCashWorking(false);
    }
  }

  async function handleCard() {
    if (!isOnline) {
      setCardError('Plata cu cardul cere conexiune online.');
      return;
    }
    setCardError(null);
    setCardPhase('dialling');
    try {
      const adapter = await _terminalFactory();
      const result = await adapter.charge({
        mutationId: `pm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        orderId,
        amountCents: remaining,
        currency: 'RON',
      });
      setCardPhase(result.status);
      await onCardOutcome(remaining, result.status, {
        authCode: result.authCode,
        rrn: result.rrn,
        trace: result.rawTrace,
      });
      if (result.status === 'approved') {
        // Give the user a beat to see the success badge before closing.
        setTimeout(onClose, 600);
      } else if (result.status === 'declined') {
        setCardError('Plata a fost respinsă de terminal.');
      } else if (result.status === 'unknown') {
        // Sprint 8 — also raise a Recovery Tray entry so the unknown
        // doesn't disappear when the modal closes.
        const engine = getSyncEngine();
        if (engine) {
          void useRecovery.getState().raise(engine.exec, {
            id: `cr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            orderId,
            amountCents: remaining,
            terminalTrace: result.rawTrace ?? null,
            terminalAuthCode: result.authCode ?? null,
            terminalRrn: result.rrn ?? null,
          });
        }
        setCardError(
          'Status terminal necunoscut — verifică manual și rezolvă din Recovery Tray.',
        );
      }
    } catch (err) {
      setCardPhase('idle');
      setCardError((err as Error).message);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-950/95 p-5 shadow-2xl">
        <header className="flex items-start justify-between mb-4">
          <h3 className="text-base font-semibold text-white">Plată comandă</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </header>

        <section className="mb-4 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm">
          <Row label="Total" value={formatMoney(totals.totalCents)} big />
          {totals.paidCents > 0 && (
            <Row label="Plătit" value={formatMoney(totals.paidCents)} accent="emerald" />
          )}
          <Row label="Rest de plată" value={formatMoney(remaining)} />
        </section>

        {/* ─── Cash ──────────────────────────────────────────────────── */}
        <section className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-2">
              <Banknote className="h-4 w-4 text-emerald-300" /> Cash
            </span>
            <span className="text-[11px] text-slate-500">
              Rest dat înapoi: {formatMoney(changeDue)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={tender / 100}
              step="0.01"
              min="0"
              onChange={(e) => setTender(Math.round(Number(e.target.value) * 100))}
              className="flex-1 rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white tabular-nums focus:outline-none focus:border-violet-400/60"
            />
            <button
              type="button"
              onClick={() => void handleCash()}
              disabled={cashWorking || tenderCents <= 0}
              className="touch-target rounded-xl px-4 py-2 text-sm font-semibold inline-flex items-center justify-center gap-2 bg-emerald-600/40 text-emerald-200 border border-emerald-400/40 hover:bg-emerald-600/60 disabled:opacity-50"
            >
              <Banknote className="h-4 w-4" /> {cashWorking ? 'Se înregistrează…' : 'Cash'}
            </button>
          </div>
          {cashError && (
            <div className="mt-2 text-[12px] text-rose-300 inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" /> {cashError}
            </div>
          )}
        </section>

        {/* ─── Card ──────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-violet-300" /> Card POS
            </span>
            {!isOnline && (
              <span className="text-[11px] text-rose-300 inline-flex items-center gap-1">
                <WifiOff className="h-3 w-3" /> offline
              </span>
            )}
          </div>

          {cardPhase === 'idle' && (
            <button
              type="button"
              onClick={() => void handleCard()}
              disabled={!isOnline || remaining <= 0}
              className="touch-target w-full rounded-xl py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 bg-violet-600/40 text-violet-100 border border-violet-400/40 hover:bg-violet-600/60 disabled:opacity-50"
            >
              <CreditCard className="h-4 w-4" /> Trimite {formatMoney(remaining)} la terminal
            </button>
          )}
          {cardPhase === 'dialling' && (
            <div className="rounded-xl border border-violet-400/40 bg-violet-500/10 px-3 py-3 text-[13px] text-violet-100 inline-flex items-center gap-2 w-full">
              <Loader className="h-4 w-4 animate-spin" />
              Trimite suma către terminal — așteaptă confirmarea clientului…
            </div>
          )}
          {cardPhase === 'approved' && (
            <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 px-3 py-3 text-[13px] text-emerald-200 inline-flex items-center gap-2 w-full">
              <CheckCircle2 className="h-4 w-4" /> Plată reușită.
            </div>
          )}
          {(cardPhase === 'declined' || cardPhase === 'unknown' || cardPhase === 'cancelled') && (
            <div className="space-y-2">
              <div
                className={`rounded-xl border px-3 py-3 text-[13px] inline-flex items-center gap-2 w-full ${
                  cardPhase === 'declined'
                    ? 'border-rose-400/40 bg-rose-500/10 text-rose-200'
                    : 'border-amber-400/40 bg-amber-500/10 text-amber-200'
                }`}
              >
                <AlertTriangle className="h-4 w-4" />
                {cardError ??
                  (cardPhase === 'declined'
                    ? 'Plata a fost respinsă.'
                    : 'Status terminal necunoscut.')}
              </div>
              <button
                type="button"
                onClick={() => {
                  setCardPhase('idle');
                  setCardError(null);
                }}
                className="touch-target w-full rounded-xl py-2.5 text-sm font-semibold bg-violet-600/30 text-violet-200 border border-violet-400/40 hover:bg-violet-600/50"
              >
                Reîncearcă
              </button>
            </div>
          )}
          {cardError && cardPhase === 'idle' && (
            <div className="mt-2 text-[12px] text-rose-300 inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" /> {cardError}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  big = false,
  accent,
}: {
  label: string;
  value: string;
  big?: boolean;
  accent?: 'emerald';
}) {
  const valueClass = big
    ? 'text-base font-bold text-white'
    : accent === 'emerald'
      ? 'text-sm font-semibold text-emerald-300'
      : 'text-sm font-semibold text-slate-200';
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-300">{label}</span>
      <span className={`tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}
