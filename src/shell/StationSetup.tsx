/**
 * Etapa 5 — first run: which restaurant does this till open?
 */
import { shellApi } from './api';
import { StationSettings } from './StationSettings';

export function StationSetup() {
  return (
    <div className="h-full overflow-auto bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-2xl space-y-6 p-8">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Configurare stație POS</h1>
          <p className="text-sm text-slate-400">
            Scrie adresa restaurantului din 360booking. Aplicația deschide POS-ul web, rulează agentul casei de marcat și
            păstrează o casă offline pentru când pică internetul.
          </p>
        </div>
        <StationSettings />
        <div className="flex flex-wrap gap-2 border-t border-slate-800 pt-4">
          <button
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-700"
            onClick={() => void shellApi.openFiscalSettings()}
          >
            Setări casă de marcat
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
  );
}
