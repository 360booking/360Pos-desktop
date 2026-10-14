/**
 * Etapa 5 — station settings form (tenant address, kiosk, start with
 * Windows, offline VAT). Used by the first-run setup screen
 * and by the "Stație" tab of the fiscal settings window.
 */
import { useEffect, useState } from 'react';

import { errText, shellApi, type ShellConfig, type ShellState } from './api';

const input =
  'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500';
const btn =
  'rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed';

export function StationSettings({
  onSaved,
  compact = false,
}: {
  onSaved?: (s: ShellState) => void;
  compact?: boolean;
}) {
  const [state, setState] = useState<ShellState | null>(null);
  const [cfg, setCfg] = useState<ShellConfig | null>(null);
  const [vatText, setVatText] = useState('21');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    shellApi
      .getConfig()
      .then((s) => {
        setState(s);
        setCfg(s.config);
        setVatText(String(Math.round(s.config.offlineDefaultVat * 1000) / 10));
      })
      .catch((e) => setMsg({ ok: false, text: errText(e) }));
  }, []);

  if (!cfg) {
    return <div className="text-sm text-slate-400">{msg?.text ?? 'Se încarcă…'}</div>;
  }

  const set = <K extends keyof ShellConfig>(k: K, v: ShellConfig[K]) => setCfg({ ...cfg, [k]: v });

  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const origin = await shellApi.testTenant(cfg.tenantUrl);
      set('tenantUrl', origin);
      setMsg({ ok: true, text: `${origin} răspunde.` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const save = async (openPos: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const vat = Number(vatText.replace(',', '.')) / 100;
      if (!Number.isFinite(vat)) throw new Error('Cota TVA nu este un număr.');
      const s = await shellApi.setConfig({ ...cfg, offlineDefaultVat: vat });
      setState(s);
      setCfg(s.config);
      setMsg({ ok: true, text: 'Salvat.' });
      onSaved?.(s);
      if (openPos) await shellApi.openPos();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <label className="block space-y-1">
        <span className="text-sm font-semibold text-slate-200">Adresa restaurantului</span>
        <div className="flex gap-2">
          <input
            className={input}
            placeholder="ex. pizzeria.360booking.ro"
            value={cfg.tenantUrl}
            onChange={(e) => set('tenantUrl', e.target.value)}
            spellCheck={false}
            autoFocus={!compact}
          />
          <button className={`${btn} bg-slate-700 text-slate-100 hover:bg-slate-600`} disabled={busy} onClick={test}>
            Testează
          </button>
        </div>
        <span className="text-xs text-slate-400">
          POS-ul se deschide la {state?.posUrl ?? '…/admin/restaurant/pos'}. Te autentifici o singură dată; sesiunea rămâne salvată pe stație.
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-200">
          <input type="checkbox" checked={cfg.kiosk} onChange={(e) => set('kiosk', e.target.checked)} />
          <span>
            Mod chioșc (ecran complet, fără bară de titlu)
            <span className="block text-xs text-slate-400">F11 sau Ctrl+Shift+K îl pornește/oprește oricând. Oprit, fereastra rămâne maximizată.</span>
          </span>
        </label>
        <label className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-200">
          <input type="checkbox" checked={cfg.autostart} onChange={(e) => set('autostart', e.target.checked)} />
          <span>
            Pornește odată cu Windows
            <span className="block text-xs text-slate-400">Pentru utilizatorul Windows curent.</span>
          </span>
        </label>
      </div>

      {!compact && (
        <details className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-300">
          <summary className="cursor-pointer select-none font-semibold text-slate-200">Avansat</summary>
          <AdvancedFields cfg={cfg} set={set} vatText={vatText} setVatText={setVatText} />
        </details>
      )}
      {compact && <AdvancedFields cfg={cfg} set={set} vatText={vatText} setVatText={setVatText} />}

      {msg && (
        <div className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-900/40 text-emerald-200' : 'bg-rose-900/40 text-rose-200'}`}>
          {msg.text}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button className={`${btn} bg-sky-600 text-white hover:bg-sky-500`} disabled={busy} onClick={() => save(true)}>
          Salvează și deschide POS-ul
        </button>
        <button className={`${btn} bg-slate-700 text-slate-100 hover:bg-slate-600`} disabled={busy} onClick={() => save(false)}>
          Doar salvează
        </button>
      </div>
      {state && (
        <div className="text-xs text-slate-500">
          Versiune {state.version}
          {state.dataDir ? ` · date locale: ${state.dataDir}` : ''}
        </div>
      )}
    </div>
  );
}

function AdvancedFields({
  cfg,
  set,
  vatText,
  setVatText,
}: {
  cfg: ShellConfig;
  set: <K extends keyof ShellConfig>(k: K, v: ShellConfig[K]) => void;
  vatText: string;
  setVatText: (v: string) => void;
}) {
  return (
    <div className="mt-3 grid gap-4 sm:grid-cols-3">
      <label className="block space-y-1">
        <span className="text-xs font-semibold text-slate-300">TVA implicit pe bonul offline (%)</span>
        <input className={input} value={vatText} onChange={(e) => setVatText(e.target.value)} inputMode="decimal" />
        <span className="block text-[11px] text-slate-500">Doar pentru produsele fără cotă primită de la server.</span>
      </label>
      <label className="flex items-start gap-2 text-xs text-slate-300 sm:col-span-3">
        <input
          type="checkbox"
          checked={cfg.offlineAllowSimulator}
          onChange={(e) => set('offlineAllowSimulator', e.target.checked)}
        />
        <span>
          Permite casa offline cu simulatorul — <b>doar pentru test</b>. Bonurile simulate ajung pe server ca bonuri reale
          offline; nu bifa pe o stație de producție.
        </span>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-semibold text-slate-300">Interfață</span>
        <select className={input} value={cfg.mode} onChange={(e) => set('mode', e.target.value as ShellConfig['mode'])}>
          <option value="web">POS web (recomandat)</option>
          <option value="legacy">POS desktop vechi</option>
        </select>
      </label>
    </div>
  );
}
