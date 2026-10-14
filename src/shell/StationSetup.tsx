/**
 * First run (2026-10-14, „casa simplu”): one question — the restaurant's
 * address — and „Continuă”. Continuă checks the address with the same
 * test as before (shell_test_tenant: reachable + /api/health), saves it and
 * opens the web POS.
 *
 * Nothing else here on purpose: kiosk mode and start-with-Windows live in
 * the app settings (window „Casa de marcat” → „Setări aplicație”, same
 * stored settings as before), and the cash register is configured only from
 * the POS: Setări → Casa de marcat → „Configurează casa de marcat”.
 * Installs that already have an address never see this screen.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';

import { errText, shellApi, type ShellConfig } from './api';
import { explainAddressError } from './firstRun';

export function StationSetup() {
  const [cfg, setCfg] = useState<ShellConfig | null>(null);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    shellApi
      .getConfig()
      .then((s) => {
        setCfg(s.config);
        setAddress(s.config.tenantUrl ?? '');
      })
      .catch((e) => setError(errText(e)));
  }, []);

  const proceed = async () => {
    if (!cfg || busy) return;
    setBusy(true);
    setError(null);
    try {
      const origin = await shellApi.testTenant(address);
      await shellApi.setConfig({ ...cfg, tenantUrl: origin });
      await shellApi.openPos();
    } catch (e) {
      setError(explainAddressError(errText(e)));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full min-h-screen place-items-center overflow-auto bg-slate-950 p-6 text-slate-100">
      <form
        className="w-full max-w-lg space-y-6 rounded-2xl border border-slate-800 bg-slate-900/70 p-8 shadow-xl shadow-black/30"
        onSubmit={(e) => {
          e.preventDefault();
          void proceed();
        }}
      >
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Bun venit în 360restaurants POS</h1>
          <p className="text-sm text-slate-400">Scrie adresa restaurantului tău din 360booking.</p>
        </div>

        <label className="block space-y-2">
          <span className="text-sm font-semibold text-slate-200">Adresa restaurantului</span>
          <input
            ref={inputRef}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-lg text-slate-100 outline-none focus:border-sky-500"
            placeholder="pizzeria.360booking.ro"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setError(null);
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoFocus
            aria-invalid={Boolean(error)}
            aria-describedby="adresa-ajutor"
          />
          <span id="adresa-ajutor" className="block text-xs text-slate-400">
            Exemplu: <b className="text-slate-300">pizzeria.360booking.ro</b> — aceeași adresă la care intri în admin.
          </span>
        </label>

        {error && (
          <div role="alert" className="rounded-lg bg-rose-900/40 px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-3 text-base font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={busy || !cfg || !address.trim()}
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
          {busy ? 'Verific adresa…' : 'Continuă'}
          {!busy ? <ArrowRight className="h-5 w-5" /> : null}
        </button>

        <p className="text-center text-xs text-slate-500">
          Casa de marcat se configurează după aceea, din POS: Setări → Casa de marcat.
        </p>
      </form>
    </div>
  );
}
