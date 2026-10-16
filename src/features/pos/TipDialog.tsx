/**
 * „Adaugi bacșiș?” — ca dialogul din POS-ul web: suma în lei, salvată pe
 * notă (POST /orders/{id}/tip). Bacșișul intră în totalul de încasat, dar
 * nu pe bonul fiscal (îl scoate serverul). 0 scoate bacșișul.
 */
import { useState } from 'react';
import { Gift, X } from 'lucide-react';

import { parseTipInput } from './tipSplit';

export function TipDialog({
  currentCents,
  onClose,
  onSave,
}: {
  currentCents: number;
  onClose: () => void;
  onSave: (amountCents: number) => Promise<void>;
}) {
  const [text, setText] = useState(currentCents > 0 ? (currentCents / 100).toFixed(2) : '10');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const cents = parseTipInput(text);
    if (cents == null) {
      setError('Valoare invalidă. Scrie suma în lei, de exemplu 10.');
      return;
    }
    setBusy(true);
    try {
      await onSave(cents);
      onClose();
    } catch {
      // The caller shows the toast; the dialog stays open for a retry.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <form
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-950/95 p-5 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <header className="mb-4 flex items-start justify-between">
          <h3 className="flex items-center gap-2 text-base font-semibold text-white">
            <Gift className="h-4 w-4 text-amber-300" /> Adaugi bacșiș?
          </h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Închide">
            <X className="h-4 w-4" />
          </button>
        </header>
        <label className="block space-y-1.5">
          <span className="text-sm text-slate-300">Bacșiș (lei)</span>
          <input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            inputMode="decimal"
            autoFocus
            aria-invalid={Boolean(error)}
            className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-3 text-lg text-white tabular-nums focus:border-violet-400/60 focus:outline-none"
          />
        </label>
        {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
        <p className="mt-2 text-xs text-slate-400">Bacșișul se adaugă la total, dar nu apare pe bonul fiscal.</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            className="touch-target rounded-xl border border-white/10 bg-white/[0.04] py-3 text-sm font-semibold text-slate-200 hover:bg-white/[0.08]"
          >
            Renunță
          </button>
          <button
            type="submit"
            disabled={busy}
            className="touch-target rounded-xl border border-amber-400/40 bg-amber-500/25 py-3 text-sm font-semibold text-amber-100 hover:bg-amber-500/35 disabled:opacity-50"
          >
            {busy ? 'Se salvează…' : 'Adaugă bacșișul'}
          </button>
        </div>
      </form>
    </div>
  );
}
