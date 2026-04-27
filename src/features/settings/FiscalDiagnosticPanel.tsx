/**
 * Fiscal Sprint 1 — diagnostic panel.
 *
 * Validates the end-to-end path: TS adapter → Tauri command → Rust simulator
 * provider → response. Once Datecs lands, the same buttons exercise the
 * real driver because the adapter contract does not change.
 *
 * Flow exercised:
 *   1. test connection
 *   2. get status
 *   3. print test receipt (synthetic single-line order)
 *   4. confirms response shape lines up with the pos-core state machine
 *      (status === 'printed' → fiscally_printed transition).
 *
 * Z-report is intentionally absent (audit Q7 — strict gating in Sprint 2).
 */
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle2, AlertTriangle, Loader2, Receipt, Wifi, Send } from 'lucide-react';
import { getFiscal, enableRustFiscalIfAllowed } from '@/adapters';
import { rustFiscalTestConnection } from '@/adapters/fiscal/rust';
import type { FiscalReceiptResponse, FiscalStatus } from '@/adapters/fiscal/types';

type AsyncState<T> =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'ok'; value: T }
  | { state: 'err'; error: string };

export function FiscalDiagnosticPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [conn, setConn] = useState<AsyncState<{ ok: boolean; detail: string }>>({ state: 'idle' });
  const [status, setStatus] = useState<AsyncState<FiscalStatus>>({ state: 'idle' });
  const [receipt, setReceipt] = useState<AsyncState<FiscalReceiptResponse>>({ state: 'idle' });
  const [adapterId, setAdapterId] = useState<string>(() => safeAdapterId());

  function safeAdapterId(): string {
    try {
      return getFiscal().id;
    } catch {
      return '—';
    }
  }

  async function refreshGate() {
    const on = await enableRustFiscalIfAllowed();
    setEnabled(on);
    setAdapterId(safeAdapterId());
  }

  async function runTestConnection() {
    setConn({ state: 'busy' });
    try {
      const r = await rustFiscalTestConnection();
      setConn({ state: 'ok', value: r });
    } catch (err) {
      setConn({ state: 'err', error: String(err) });
    }
  }

  async function runGetStatus() {
    setStatus({ state: 'busy' });
    try {
      const r = await getFiscal().status();
      setStatus({ state: 'ok', value: r });
    } catch (err) {
      setStatus({ state: 'err', error: String(err) });
    }
  }

  async function runPrintTestReceipt() {
    setReceipt({ state: 'busy' });
    try {
      const mutationId = crypto.randomUUID();
      const r = await getFiscal().printReceipt({
        mutationId,
        orderId: `diag-${Date.now()}`,
        fiscalAttemptId: crypto.randomUUID(),
        operator: { code: '1', password: '0000' },
        lines: [
          { name: 'Test produs diagnostic', quantity: 1, unitPriceCents: 100, vatGroup: 'A' },
        ],
        payments: [{ method: 'cash', amountCents: 100 }],
      });
      setReceipt({ state: 'ok', value: r });
    } catch (err) {
      setReceipt({ state: 'err', error: String(err) });
    }
  }

  async function rawCommand() {
    // Calls fiscal_use_rust_enabled to make sure the IPC bridge itself works,
    // independent of any provider state — used as a lowest-level sanity check
    // when the higher-level commands fail.
    try {
      const v = await invoke<boolean>('fiscal_use_rust_enabled');
      alert(`fiscal_use_rust_enabled() → ${v}`);
    } catch (err) {
      alert(`IPC failed: ${err}`);
    }
  }

  const stateMachineHint = (() => {
    if (receipt.state !== 'ok') return null;
    if (receipt.value.status === 'printed') {
      return (
        <span className="inline-flex items-center gap-1 text-emerald-300 text-xs">
          <CheckCircle2 className="h-3.5 w-3.5" />
          State machine: paid → fiscal_pending → fiscally_printed (acceptat)
        </span>
      );
    }
    if (receipt.value.status === 'unknown') {
      return (
        <span className="inline-flex items-center gap-1 text-amber-300 text-xs">
          <AlertTriangle className="h-3.5 w-3.5" />
          State machine: ar trăi în fiscal_pending; manager flow obligatoriu (no auto-retry).
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-rose-300 text-xs">
        <AlertTriangle className="h-3.5 w-3.5" />
        State machine: rămâne în paid; payment_approved_fiscalization_failed pentru retry manual.
      </span>
    );
  })();

  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-100 mb-1 inline-flex items-center gap-2">
        <Receipt className="h-5 w-5 text-violet-300" /> Casă de marcat — diagnostic Sprint 1
      </h2>
      <p className="text-sm text-slate-400 mb-6">
        Path-ul Rust simulator → Tauri command → adapter TS. Datecs DP-25 / FP-55 vine în PR-ul următor; același trait acoperă ambele.
      </p>

      <div className="rounded-xl border border-white/10 bg-slate-900/40 p-4 mb-4 space-y-2 text-sm">
        <div className="flex items-baseline gap-3">
          <span className="text-slate-400 w-44">Adapter activ</span>
          <span className="text-slate-100 font-mono text-xs">{adapterId}</span>
        </div>
        <div className="flex items-baseline gap-3">
          <span className="text-slate-400 w-44">FISCAL_USE_RUST</span>
          <span className={enabled ? 'text-emerald-300' : enabled === false ? 'text-amber-300' : 'text-slate-500'}>
            {enabled === null ? 'nedeterminat' : enabled ? 'activ — adapter Rust' : 'inactiv — fallback simulator JS'}
          </span>
        </div>
        <div className="pt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={refreshGate}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60"
          >
            Verifică gate
          </button>
          <button
            type="button"
            onClick={rawCommand}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60"
          >
            Ping IPC
          </button>
        </div>
      </div>

      <Section
        icon={<Wifi className="h-4 w-4 text-violet-300" />}
        title="Test connection"
        action={
          <button
            type="button"
            onClick={runTestConnection}
            disabled={conn.state === 'busy'}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
          >
            {conn.state === 'busy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Run
          </button>
        }
      >
        {conn.state === 'ok' && (
          <pre className="text-xs text-emerald-200 font-mono whitespace-pre-wrap">{JSON.stringify(conn.value, null, 2)}</pre>
        )}
        {conn.state === 'err' && (
          <pre className="text-xs text-rose-300 font-mono whitespace-pre-wrap">{conn.error}</pre>
        )}
      </Section>

      <Section
        icon={<CheckCircle2 className="h-4 w-4 text-violet-300" />}
        title="Get status"
        action={
          <button
            type="button"
            onClick={runGetStatus}
            disabled={status.state === 'busy'}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
          >
            {status.state === 'busy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Run
          </button>
        }
      >
        {status.state === 'ok' && (
          <pre className="text-xs text-emerald-200 font-mono whitespace-pre-wrap">{JSON.stringify(status.value, null, 2)}</pre>
        )}
        {status.state === 'err' && (
          <pre className="text-xs text-rose-300 font-mono whitespace-pre-wrap">{status.error}</pre>
        )}
      </Section>

      <Section
        icon={<Send className="h-4 w-4 text-violet-300" />}
        title="Print test receipt (1 RON, TVA 19%, cash)"
        action={
          <button
            type="button"
            onClick={runPrintTestReceipt}
            disabled={receipt.state === 'busy'}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
          >
            {receipt.state === 'busy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Run
          </button>
        }
      >
        {receipt.state === 'ok' && (
          <>
            <pre className="text-xs text-emerald-200 font-mono whitespace-pre-wrap">{JSON.stringify(receipt.value, null, 2)}</pre>
            {stateMachineHint}
          </>
        )}
        {receipt.state === 'err' && (
          <pre className="text-xs text-rose-300 font-mono whitespace-pre-wrap">{receipt.error}</pre>
        )}
      </Section>

      <p className="text-xs text-slate-500 mt-6">
        Z-report nu apare aici — protejat strict prin PIN admin în Sprint 2 (audit Q7). Storno + sertar bani — Sprint 2.
      </p>
    </div>
  );
}

function Section({
  icon,
  title,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 rounded-xl border border-white/10 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-100 inline-flex items-center gap-2">
          {icon} {title}
        </h3>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}
