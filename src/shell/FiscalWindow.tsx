/**
 * Window „Casa de marcat” — opened from the POS (Setări → Casa de marcat →
 * „Configurează casa de marcat”), or with Ctrl+Shift+F for service.
 *
 * Tabs:
 *   Casa de marcat    — the guide (fiscal-guide/FiscalGuide): summary on
 *                       top, find the register → automatic link line →
 *                       test bill, every technical tool under „Avansat”;
 *   Setări aplicație  — restaurant address, kiosk, start with Windows,
 *                       offline VAT (moved off the first-run screen).
 */
import { useState } from 'react';

import { FiscalGuide } from '@/features/settings/fiscal-guide/FiscalGuide';

import { StationSettings } from './StationSettings';

type Tab = 'fiscal' | 'app';

export function FiscalWindow() {
  const [tab, setTab] = useState<Tab>('fiscal');
  const tabBtn = (t: Tab, label: string) => (
    <button
      className={`rounded-lg px-4 py-2 text-sm font-semibold ${tab === t ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
      onClick={() => setTab(t)}
    >
      {label}
    </button>
  );
  return (
    <div className="h-full overflow-auto bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold">Casa de marcat</h1>
          <div className="flex gap-2">
            {tabBtn('fiscal', 'Casa de marcat')}
            {tabBtn('app', 'Setări aplicație')}
          </div>
        </div>
        {tab === 'fiscal' ? <FiscalGuide /> : <StationSettings compact />}
      </div>
    </div>
  );
}
