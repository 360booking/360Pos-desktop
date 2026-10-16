/**
 * Window „Casa de marcat” — opened from the POS (Setări → Casa de marcat →
 * „Configurează casa de marcat”), or with Ctrl+Shift+F for service.
 *
 * Opens on the whole screen (shell/mod.rs::open_fiscal_settings). The bar on
 * top is always visible: „Înapoi la POS” and „Înapoi în admin” bring the
 * main window to the POS / the admin (the web app asks for the
 * administrator password first) and close this window — 2026-10-16,
 * patronul: „după configurare nu am cum să mă întorc”.
 *
 * Tabs:
 *   Casa de marcat    — the guide (fiscal-guide/FiscalGuide): summary on
 *                       top, find the register → automatic link line →
 *                       test bill, every technical tool under „Avansat”;
 *   Setări aplicație  — restaurant address, kiosk, start with Windows,
 *                       offline VAT (moved off the first-run screen).
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, LayoutDashboard } from 'lucide-react';

import { FiscalGuide } from '@/features/settings/fiscal-guide/FiscalGuide';

import { errText, shellApi } from './api';
import { StationSettings } from './StationSettings';

type Tab = 'fiscal' | 'app';
type Target = 'pos' | 'admin';

export function FiscalWindow() {
  const [tab, setTab] = useState<Tab>('fiscal');
  // The admin exists only with the web POS and a restaurant address.
  const [hasAdmin, setHasAdmin] = useState(false);
  const [leaving, setLeaving] = useState<Target | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    shellApi
      .getConfig()
      .then((s) => setHasAdmin(s.config.mode !== 'legacy' && Boolean(s.config.tenantUrl.trim())))
      .catch(() => setHasAdmin(false));
  }, []);

  const goBack = async (target: Target) => {
    if (leaving) return;
    setLeaving(target);
    setError(null);
    try {
      await shellApi.fiscalBack(target);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLeaving(null);
    }
  };

  const tabBtn = (t: Tab, label: string) => (
    <button
      className={`rounded-lg px-4 py-2 text-sm font-semibold ${tab === t ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
      onClick={() => setTab(t)}
    >
      {label}
    </button>
  );
  const backBtn =
    'inline-flex min-h-11 items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-wait disabled:opacity-60';

  return (
    <div className="flex h-full min-h-screen flex-col bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-900/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
          <button
            className={`${backBtn} bg-sky-600 text-white hover:bg-sky-500`}
            disabled={leaving !== null}
            onClick={() => void goBack('pos')}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {leaving === 'pos' ? 'Se deschide POS-ul…' : 'Înapoi la POS'}
          </button>
          {hasAdmin && (
            <button
              className={`${backBtn} bg-slate-700 text-slate-100 hover:bg-slate-600`}
              disabled={leaving !== null}
              onClick={() => void goBack('admin')}
              title="Adminul cere parola administratorului"
            >
              <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
              {leaving === 'admin' ? 'Se deschide adminul…' : 'Înapoi în admin'}
            </button>
          )}
          <div className="ml-auto flex gap-2">
            {tabBtn('fiscal', 'Casa de marcat')}
            {tabBtn('app', 'Setări aplicație')}
          </div>
        </div>
        {error && (
          <div role="alert" className="mx-auto max-w-5xl px-4 pb-3 text-sm text-rose-300 sm:px-6">
            {error}
          </div>
        )}
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
          <h1 className="text-xl font-bold">Casa de marcat</h1>
          {tab === 'fiscal' ? <FiscalGuide /> : <StationSettings compact />}
        </div>
      </main>
    </div>
  );
}
