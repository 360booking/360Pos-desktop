/**
 * Etapa 5 — first run: which restaurant does this till open? Then the next
 * action: the 3-step till guide (opens the fiscal window; when the till is
 * already configured and linked the guide opens straight on its summary).
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, Receipt } from 'lucide-react';

import { shellApi } from './api';
import { StationSettings } from './StationSettings';

export function StationSetup() {
  const [addressSaved, setAddressSaved] = useState(false);
  const [tillLinked, setTillLinked] = useState(false);

  useEffect(() => {
    shellApi
      .getConfig()
      .then((s) => setAddressSaved(Boolean(s.config.tenantUrl?.trim())))
      .catch(() => {});
    shellApi
      .fiscalHealth()
      .then((h) => setTillLinked(Boolean(h.agent.hasSavedCredentials)))
      .catch(() => {});
  }, []);

  return (
    <div className="h-full overflow-auto bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-2xl space-y-6 p-6 sm:p-8">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Configurare stație POS</h1>
          <p className="text-sm text-slate-400">
            Scrie adresa restaurantului din 360booking. Aplicația deschide POS-ul web, rulează agentul casei de marcat și
            păstrează o casă offline pentru când pică internetul.
          </p>
        </div>
        <StationSettings onSaved={(s) => setAddressSaved(Boolean(s.config.tenantUrl?.trim()))} />

        <div
          className={`space-y-3 rounded-xl border p-4 ${
            addressSaved && !tillLinked ? 'border-sky-600/60 bg-sky-950/30' : 'border-slate-800 bg-slate-900/60'
          }`}
        >
          <div className="flex items-start gap-3">
            <Receipt className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" />
            <div className="space-y-1">
              <div className="font-semibold text-slate-100">
                {addressSaved ? 'Pasul următor: casa de marcat' : 'După adresă: casa de marcat'}
              </div>
              {tillLinked ? (
                <p className="flex items-center gap-1.5 text-sm text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" /> Casa de marcat e deja legată de stația asta.
                </p>
              ) : (
                <p className="text-sm text-slate-400">
                  Dacă pe calculatorul ăsta e legată casa de marcat, configureaz-o acum: 3 pași, cam 5 minute. Oricând
                  mai târziu: Ctrl+Shift+F.
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500"
              onClick={() => void shellApi.openFiscalSettings()}
            >
              {tillLinked ? 'Vezi casa de marcat' : 'Configurează casa de marcat (3 pași)'}
            </button>
            <button
              className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-700"
              onClick={() => void shellApi.openOffline()}
            >
              Casa offline
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
