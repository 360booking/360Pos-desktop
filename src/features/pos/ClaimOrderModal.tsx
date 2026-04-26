/**
 * "Preluare comandă" modal — Sprint 7.
 *
 * Opens when the operator taps a table whose order is locked by
 * another device. Shows owner + expires_at and offers "Preluare" (calls
 * /api/pos/orders/{id}/claim with force=false) plus, for managers, a
 * "Preluare forțată" button that sends force=true.
 *
 * Offline guard is enforced upstream (TablesPane checks `isOnline`); we
 * still render a clear message if claim fails.
 */
import { useState } from 'react';
import { Lock, AlertTriangle, X, ShieldCheck } from 'lucide-react';
import { claimOrder, type ClaimOrderResponse } from '@/lib/api/orderLock';
import { getConfig } from '@/lib/config';

interface ClaimOrderModalProps {
  orderId: string;
  ownerDeviceId: string | null;
  expiresAt: string | null;
  /** True when the operator's account allows the force-claim variant. */
  canForce: boolean;
  onClose: () => void;
  onClaimed: (orderId: string) => void;
}

export function ClaimOrderModal({
  orderId,
  ownerDeviceId,
  expiresAt,
  canForce,
  onClose,
  onClaimed,
}: ClaimOrderModalProps) {
  const [submitting, setSubmitting] = useState<'normal' | 'force' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<ClaimOrderResponse | null>(null);

  async function attempt(force: boolean) {
    setSubmitting(force ? 'force' : 'normal');
    setError(null);
    try {
      const cfg = getConfig();
      const r = await claimOrder(orderId, {
        deviceId: cfg.deviceId ?? 'unpaired',
        tenantId: cfg.tenantId,
        restaurantId: cfg.restaurantId,
        force,
      });
      setResponse(r);
      if (r.status === 'claimed' || r.status === 'already_owned') {
        onClaimed(orderId);
      } else {
        setError(r.message ?? r.status);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-950/95 p-5 shadow-2xl">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2 text-white">
            <Lock className="h-5 w-5 text-amber-300" />
            <h3 className="text-base font-semibold">Preluare comandă</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white"
            aria-label="Închide"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2 text-sm text-slate-300 mb-4">
          <p>
            Această comandă este deschisă pe alt dispozitiv:
          </p>
          <div className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px]">
            <div>
              Device: <span className="font-mono text-slate-200">{ownerDeviceId ?? 'necunoscut'}</span>
            </div>
            {expiresAt && (
              <div className="text-slate-400 text-[11px] mt-0.5">
                Lock expiră: {new Date(expiresAt).toLocaleTimeString()}
              </div>
            )}
          </div>
          <p className="text-[12px] text-slate-400">
            Preluare normală reușește doar dacă lock-ul a expirat.
            Preluare forțată cere drepturi de manager și suprascrie lock-ul activ.
          </p>
        </div>

        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {response?.status === 'claimed' ? (
          <div className="text-[12px] text-emerald-300 mb-3">
            Lock dobândit — poți edita comanda.
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void attempt(false)}
            disabled={submitting !== null}
            className="touch-target rounded-xl py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-2 bg-violet-600/40 text-violet-100 border border-violet-400/40 hover:bg-violet-600/60 disabled:opacity-50"
          >
            {submitting === 'normal' ? 'Se preia…' : 'Preluare'}
          </button>
          {canForce && (
            <button
              type="button"
              onClick={() => void attempt(true)}
              disabled={submitting !== null}
              className="touch-target rounded-xl py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-2 bg-rose-600/30 text-rose-200 border border-rose-400/40 hover:bg-rose-600/50 disabled:opacity-50"
            >
              <ShieldCheck className="h-4 w-4" />
              {submitting === 'force' ? 'Se forțează…' : 'Preluare forțată'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
