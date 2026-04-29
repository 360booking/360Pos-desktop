/**
 * Settings → Imprimante (Sprint 12).
 *
 * Mirror al paginii web `/admin/restaurant/printers` cu o singură
 * diferență cheie: butonul "Test" rulează pe DESKTOP (Tauri TCP direct,
 * comanda Rust `escpos_send`), nu prin backend. Asta confirmă LAN-ul
 * local PC ↔ imprimantă fără să implici serverul — exact ce vrei când
 * imprimanta e pe aceeași rețea cu PC-ul, dar backend-ul e în cloud.
 *
 * Config-ul rămâne tenant-wide (același JSONB pe `restaurants` ca în
 * web), dar îl cachezi local automat la fiecare GET ca să funcționeze
 * și offline (când backend-ul cade dar imprimanta tot e ok).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Loader2,
  Plus,
  Printer,
  RefreshCw,
  Trash2,
  Wifi,
  X,
} from 'lucide-react';
import {
  kitchenPrintersApi,
  type KitchenPrinter,
  type KitchenPrinterJob,
} from '@/lib/api/kitchenPrinters';
import { writePrintersCache } from '@/lib/print/cache';
import { testPrintLocal } from '@/lib/print/dispatch';

const STATION_PRESETS = ['kitchen', 'bar', 'pizza', 'grill', 'reception'];
const PAPER_OPTIONS: Array<32 | 42 | 48> = [32, 42, 48];

function emptyPrinter(): KitchenPrinter {
  return {
    name: '',
    station: 'kitchen',
    host: '',
    port: 9100,
    paper_width_chars: 48,
    enabled: true,
  };
}

function normalize(p: KitchenPrinter): KitchenPrinter {
  return {
    id: p.id,
    name: p.name || '',
    station: (p.station || 'kitchen').toLowerCase(),
    host: p.host || '',
    port: Number(p.port || 9100),
    paper_width_chars: Number(p.paper_width_chars || 48),
    enabled: p.enabled !== false,
  };
}

export function KitchenPrintersTab() {
  const [printers, setPrinters] = useState<KitchenPrinter[]>([]);
  const [jobs, setJobs] = useState<KitchenPrinterJob[]>([]);
  const [failedUnack, setFailedUnack] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<number, { ok: boolean; msg: string }>>({});
  const [showJobs, setShowJobs] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, jobsRes] = await Promise.all([
        kitchenPrintersApi.list(),
        kitchenPrintersApi.jobs({ limit: 50 }).catch(() => ({ jobs: [], failedUnacknowledged: 0 })),
      ]);
      const cleaned = list.map(normalize);
      setPrinters(cleaned);
      void writePrintersCache(cleaned);
      setJobs(jobsRes.jobs || []);
      setFailedUnack(jobsRes.failedUnacknowledged || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Eroare la încărcare.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const cleaned = printers.map(normalize);
      const result = await kitchenPrintersApi.replace(cleaned);
      const next = result.map(normalize);
      setPrinters(next);
      await writePrintersCache(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Eroare la salvare.');
    } finally {
      setSaving(false);
    }
  };

  const test = async (idx: number) => {
    const p = printers[idx];
    if (!p?.host) return;
    setTestResult((t) => ({ ...t, [idx]: { ok: false, msg: 'Se trimite din desktop...' } }));
    const result = await testPrintLocal(p.host, p.port || 9100, p.paper_width_chars || 48);
    setTestResult((t) => ({
      ...t,
      [idx]: result.ok
        ? { ok: true, msg: `OK — ${result.bytes} bytes trimiși` }
        : { ok: false, msg: result.error || 'Eroare necunoscută' },
    }));
  };

  const retryJob = async (jobId: string) => {
    try {
      await kitchenPrintersApi.retryJob(jobId);
      void refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Retry eșuat.');
    }
  };

  const ackAll = async () => {
    try {
      await kitchenPrintersApi.ackAll();
      void refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Eroare.');
    }
  };

  const updateAt = (idx: number, patch: Partial<KitchenPrinter>) => {
    setPrinters((arr) => arr.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const failedCount = useMemo(() => jobs.filter((j) => j.status !== 'ok').length, [jobs]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-100 inline-flex items-center gap-2">
            <Printer className="h-4 w-4 text-violet-300" /> Imprimante de bucătărie
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            Backend printează automat la "Trimite la bucătărie". Dacă desktop-ul e offline,
            printează direct de aici folosind config-ul cached.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Reîncarcă
        </button>
      </div>

      {error && (
        <div className="text-xs px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-red-200">
          {error}
        </div>
      )}

      {failedUnack > 0 && (
        <div className="text-xs px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            {failedUnack} job{failedUnack === 1 ? '' : 'uri'} eșuate care nu au fost confirmate.
          </span>
          <button
            onClick={() => void ackAll()}
            className="underline hover:no-underline"
          >
            Marchează toate
          </button>
        </div>
      )}

      <div className="rounded-lg border border-white/10 bg-slate-900/40">
        <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-slate-400">
            Imprimante configurate
          </span>
          <button
            onClick={() => setPrinters((p) => [...p, emptyPrinter()])}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-violet-500/20 text-violet-200 hover:bg-violet-500/30"
          >
            <Plus className="h-3 w-3" /> Adaugă
          </button>
        </div>

        {loading && (
          <div className="p-4 text-xs text-slate-400 inline-flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Se încarcă...
          </div>
        )}
        {!loading && printers.length === 0 && (
          <div className="p-4 text-xs text-slate-400">
            Nicio imprimantă configurată. Adaugă cel puțin una ca bonurile să fie printate.
          </div>
        )}

        <div className="divide-y divide-white/5">
          {printers.map((p, idx) => (
            <div key={idx} className="p-3 grid grid-cols-12 gap-2 items-end text-xs text-slate-200">
              <div className="col-span-3">
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  Nume
                </label>
                <input
                  type="text"
                  value={p.name}
                  onChange={(e) => updateAt(idx, { name: e.target.value })}
                  placeholder="Bucătărie 1"
                  className="w-full bg-slate-950/60 border border-white/10 rounded px-2 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  Stație
                </label>
                <input
                  type="text"
                  list="station-presets"
                  value={p.station}
                  onChange={(e) => updateAt(idx, { station: e.target.value })}
                  className="w-full bg-slate-950/60 border border-white/10 rounded px-2 py-1.5 text-xs text-slate-100"
                />
                <datalist id="station-presets">
                  {STATION_PRESETS.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>
              <div className="col-span-3">
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  IP / hostname
                </label>
                <input
                  type="text"
                  value={p.host}
                  onChange={(e) => updateAt(idx, { host: e.target.value })}
                  placeholder="192.168.1.50"
                  className="w-full bg-slate-950/60 border border-white/10 rounded px-2 py-1.5 text-xs text-slate-100 font-mono"
                />
              </div>
              <div className="col-span-1">
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  Port
                </label>
                <input
                  type="number"
                  value={p.port}
                  onChange={(e) => updateAt(idx, { port: Number(e.target.value) || 9100 })}
                  className="w-full bg-slate-950/60 border border-white/10 rounded px-2 py-1.5 text-xs text-slate-100 font-mono"
                />
              </div>
              <div className="col-span-1">
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  Lățime
                </label>
                <select
                  value={p.paper_width_chars}
                  onChange={(e) =>
                    updateAt(idx, { paper_width_chars: Number(e.target.value) })
                  }
                  className="w-full bg-slate-950/60 border border-white/10 rounded px-2 py-1.5 text-xs text-slate-100"
                >
                  {PAPER_OPTIONS.map((w) => (
                    <option key={w} value={w}>
                      {w}c
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-1 flex items-center gap-1 mt-5">
                <input
                  type="checkbox"
                  id={`ena-${idx}`}
                  checked={p.enabled}
                  onChange={(e) => updateAt(idx, { enabled: e.target.checked })}
                  className="accent-violet-500"
                />
                <label htmlFor={`ena-${idx}`} className="text-[10px] text-slate-400">
                  Activ
                </label>
              </div>
              <div className="col-span-1 flex gap-1">
                <button
                  onClick={() => void test(idx)}
                  disabled={!p.host}
                  title="Test print (din desktop)"
                  className="p-2 rounded border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 disabled:opacity-30"
                >
                  <Wifi className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setPrinters((arr) => arr.filter((_, i) => i !== idx))}
                  title="Șterge"
                  className="p-2 rounded border border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/20"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {testResult[idx] && (
                <div
                  className={`col-span-12 text-[11px] inline-flex items-center gap-1 ${
                    testResult[idx].ok ? 'text-emerald-300' : 'text-red-300'
                  }`}
                >
                  {testResult[idx].ok ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <X className="h-3 w-3" />
                  )}
                  {testResult[idx].msg}
                </div>
              )}
            </div>
          ))}
        </div>

        {printers.length > 0 && (
          <div className="px-3 py-2 border-t border-white/10 flex items-center justify-end">
            <button
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-violet-500 text-white hover:bg-violet-400 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Salvează
            </button>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-white/10 bg-slate-900/40">
        <button
          onClick={() => setShowJobs((s) => !s)}
          className="w-full px-3 py-2 flex items-center justify-between text-left hover:bg-white/5"
        >
          <span className="text-xs uppercase tracking-wider text-slate-400">
            Istoric printări ({jobs.length}, {failedCount} eșuate)
          </span>
          <span className="text-[10px] text-slate-500">
            {showJobs ? 'ascunde' : 'arată'}
          </span>
        </button>
        {showJobs && jobs.length > 0 && (
          <div className="border-t border-white/10 max-h-72 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-white/5 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 text-left">Când</th>
                  <th className="px-2 py-1.5 text-left">Stație</th>
                  <th className="px-2 py-1.5 text-left">Imprimantă</th>
                  <th className="px-2 py-1.5 text-left">Status</th>
                  <th className="px-2 py-1.5 text-left">Detalii</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {jobs.map((j) => (
                  <tr key={j.id} className="text-slate-200">
                    <td className="px-2 py-1.5 text-slate-400">
                      {j.createdAt ? new Date(j.createdAt).toLocaleString('ro-RO') : '—'}
                    </td>
                    <td className="px-2 py-1.5">{j.station || '—'}</td>
                    <td className="px-2 py-1.5 font-mono text-[10px]">
                      {j.printerHost || '—'}
                    </td>
                    <td className="px-2 py-1.5">
                      {j.status === 'ok' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-300">
                          <Check className="h-3 w-3" /> ok
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-red-300">
                          <X className="h-3 w-3" /> {j.status}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-[10px] text-slate-400 max-w-[16ch] truncate">
                      {j.error || `${j.attempts} încercări`}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {j.status !== 'ok' && j.ticketId && (
                        <button
                          onClick={() => void retryJob(j.id)}
                          className="text-[10px] text-violet-300 hover:text-violet-200"
                        >
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
