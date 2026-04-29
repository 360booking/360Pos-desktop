/**
 * Settings → Rapoarte casă de marcat (Sprint 12).
 *
 * Operator-facing entry points for the daily/legal cash-register operations:
 *   - X-report  — readout, daily counters untouched. No confirm.
 *   - Z-report  — closes the day, zeros the counters. Double confirm.
 *   - Bon duplicat — reprint the LAST receipt as a labelled COPIE.
 *   - Sertar  — pop the cash drawer (no fiscal payload).
 *   - Storno BF  — refund/void by original BF number + reason.
 *   - Raport periodic memoria fiscală — for monthly ANAF readout.
 *
 * Every action goes through the BACKEND endpoints under /api/fiscal/*
 * so the bridge_agent driver tracks them in fiscal_receipts and the
 * web admin can audit alongside POS-issued receipts. Local Tauri
 * commands exist as a backup path but the primary flow stays
 * server-of-truth.
 */
import { useState } from 'react';
import {
  AlertTriangle,
  ClipboardCopy,
  Coins,
  FileSearch,
  Loader2,
  Receipt,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import { getApiClient } from '@/lib/api/client';

interface ReportResp {
  ok: boolean;
  driver_type?: string | null;
  message: string;
  raw_response?: string | null;
}

type Outcome = { ok: boolean; text: string } | null;

export function ReportsTab() {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const run = async (
    key: string,
    description: string,
    fn: () => Promise<{ ok: boolean; message: string }>,
  ) => {
    setBusyKey(key);
    setOutcome(null);
    try {
      const r = await fn();
      setOutcome({ ok: r.ok, text: `${description}: ${r.message}` });
    } catch (e) {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? String(e);
      setOutcome({ ok: false, text: `${description} eșuat: ${detail}` });
    } finally {
      setBusyKey(null);
    }
  };

  const onXReport = () =>
    run('x', 'X-report', async () => {
      const r = await getApiClient().post<ReportResp>('/api/fiscal/x-report', {});
      return { ok: r.data.ok, message: r.data.message };
    });

  const onZReport = async () => {
    if (
      !confirm(
        'Z-report ÎNCHIDE ziua fiscală și RESETEAZĂ contoarele. ' +
          'Operațiunea NU se poate anula.\n\nContinui?',
      )
    )
      return;
    if (!confirm('Confirmare finală: emit Z-report acum?')) return;
    return run('z', 'Z-report', async () => {
      const r = await getApiClient().post<ReportResp>('/api/fiscal/z-report', {});
      return { ok: r.data.ok, message: r.data.message };
    });
  };

  const onReprint = () =>
    run('reprint', 'Bon duplicat', async () => {
      const r = await getApiClient().post<ReportResp>('/api/fiscal/reprint-last', {});
      return { ok: r.data.ok, message: r.data.message };
    });

  const onDrawer = () =>
    run('drawer', 'Sertar', async () => {
      const r = await getApiClient().post<ReportResp>('/api/fiscal/open-drawer', {});
      return { ok: r.data.ok, message: r.data.message };
    });

  const onStornoByBf = async () => {
    const bf = prompt('Numărul BF al bonului care se stornează:');
    if (!bf || !bf.trim()) return;
    const reason = prompt('Motivul storno (obligatoriu, va fi printat pe bon):');
    if (!reason || !reason.trim()) return;
    if (
      !confirm(
        `Storno bon ${bf.trim()}. Casa va emite un bon nou cu valori NEGATIVE. ` +
          'Operațiunea NU poate fi anulată.\n\nContinui?',
      )
    )
      return;
    return run('storno', `Storno BF ${bf.trim()}`, async () => {
      const r = await getApiClient().post<{
        ok: boolean;
        message: string;
        storno_fiscal_number?: string | null;
      }>(
        '/api/fiscal/storno-by-bf',
        { bf: bf.trim(), reason: reason.trim() },
        { timeout: 60_000 }, // serial fiscal storno can take 10-15s
      );
      const stornoNum = r.data.storno_fiscal_number;
      const tail = stornoNum ? ` Bon storno: ${stornoNum}.` : '';
      return {
        ok: r.data.ok,
        message: (r.data.message || (r.data.ok ? 'Emis.' : 'Eșec.')) + tail,
      };
    });
  };

  const onPeriodic = async () => {
    const dateFrom = prompt('Data început (YYYY-MM-DD):');
    if (!dateFrom || !dateFrom.trim()) return;
    const dateTo = prompt('Data sfârșit (YYYY-MM-DD):');
    if (!dateTo || !dateTo.trim()) return;
    return run('periodic', 'Raport periodic memorie', async () => {
      const r = await getApiClient().post<ReportResp>('/api/fiscal/periodic-memory', {
        date_from: dateFrom.trim(),
        date_to: dateTo.trim(),
      });
      return { ok: r.data.ok, message: r.data.message };
    });
  };

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-base font-semibold text-slate-100">Rapoarte casă de marcat</h2>
        <p className="text-xs text-slate-400 mt-1">
          Operațiile legale pe Datecs DP-25 (sau alt driver compatibil). Toate trec
          prin backend → bridge → casă, deci sunt audit-ate în <code>fiscal_receipts</code>.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ActionCard
          icon={<FileSearch className="h-4 w-4" />}
          title="X-report"
          hint="Citire control, fără reset. Sigur de rulat oricând."
          tone="neutral"
          busy={busyKey === 'x'}
          onClick={onXReport}
        />
        <ActionCard
          icon={<RefreshCw className="h-4 w-4" />}
          title="Z-report (închidere zi)"
          hint="Închide ziua, resetează contoarele. Necesar zilnic."
          tone="warning"
          busy={busyKey === 'z'}
          onClick={onZReport}
        />
        <ActionCard
          icon={<Receipt className="h-4 w-4" />}
          title="Bon duplicat (COPIE)"
          hint="Reprintează ultimul bon ca duplicat non-fiscal."
          tone="neutral"
          busy={busyKey === 'reprint'}
          onClick={onReprint}
        />
        <ActionCard
          icon={<Coins className="h-4 w-4" />}
          title="Deschide sertar"
          hint="Puls fizic spre sertarul casei. Fără bon."
          tone="neutral"
          busy={busyKey === 'drawer'}
          onClick={onDrawer}
        />
        <ActionCard
          icon={<Undo2 className="h-4 w-4" />}
          title="Storno după BF"
          hint="Anulează un bon emis cunoscând numărul BF."
          tone="danger"
          busy={busyKey === 'storno'}
          onClick={onStornoByBf}
        />
        <ActionCard
          icon={<ClipboardCopy className="h-4 w-4" />}
          title="Raport periodic memorie"
          hint="Raport ANAF între două date (uzual lunar)."
          tone="neutral"
          busy={busyKey === 'periodic'}
          onClick={onPeriodic}
        />
      </div>

      {outcome && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            outcome.ok
              ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
              : 'border-rose-400/40 bg-rose-500/10 text-rose-200'
          }`}
        >
          {outcome.text}
        </div>
      )}

      <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Z-report-ul trebuie făcut <strong>zilnic</strong>. Dacă nu se face, casa
          intră în blocaj fiscal după ~24h și nu mai emite bonuri noi.
        </span>
      </div>
    </div>
  );
}

function ActionCard({
  icon,
  title,
  hint,
  tone,
  busy,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  tone: 'neutral' | 'warning' | 'danger';
  busy: boolean;
  onClick: () => void;
}) {
  const toneClasses =
    tone === 'danger'
      ? 'border-rose-400/40 hover:border-rose-300/60 hover:bg-rose-500/10'
      : tone === 'warning'
        ? 'border-amber-400/40 hover:border-amber-300/60 hover:bg-amber-500/10'
        : 'border-white/10 hover:border-violet-400/60 hover:bg-violet-500/5';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`text-left rounded-xl border bg-slate-900/40 p-3 transition disabled:opacity-50 ${toneClasses}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-violet-300">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}</span>
        <span className="text-sm font-semibold text-slate-100">{title}</span>
      </div>
      <span className="block text-[11px] text-slate-400">{hint}</span>
    </button>
  );
}
