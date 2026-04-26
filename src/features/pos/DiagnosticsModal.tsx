/**
 * Diagnostics modal — Sprint 9.5.
 *
 * Opens from the StatusBar gear icon. Shows the full
 * DiagnosticsSnapshot + four "Test connectivity" buttons. The
 * snapshot is already token-free (see lib/diagnostics.ts), so the
 * Copy / Save actions can hand the operator a paste-safe blob with
 * zero confidential bits.
 *
 * Connectivity tests are read-only:
 *   - Test backend  → GET /api/pos/health (no auth)
 *   - Test bootstrap → GET /api/pos/bootstrap (auth)
 *   - Test pull     → GET /api/pos/sync/pull?device_id=<id>
 *   - Test push    → DELIBERATELY OMITTED. A push would create a
 *                    real ORDER_CREATED row; the operator can do
 *                    this through normal UI when actually testing.
 */
import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  RefreshCw,
  Server,
  X,
} from 'lucide-react';
import { snapshot, snapshotAsText, maskSecrets, type DiagnosticsSnapshot } from '@/lib/diagnostics';
import { getApiClient } from '@/lib/api/client';
import { fetchPullChanges } from '@/lib/api/pull';
import { getConfig } from '@/lib/config';

type TestKey = 'backend' | 'bootstrap' | 'pull';

interface TestResult {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  detail?: string;
  error?: string;
}

export function DiagnosticsModal({ onClose }: { onClose: () => void }) {
  const [snap, setSnap] = useState<DiagnosticsSnapshot>(() => snapshot());
  const [tests, setTests] = useState<Record<TestKey, TestResult | null>>({
    backend: null,
    bootstrap: null,
    pull: null,
  });
  const [running, setRunning] = useState<TestKey | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const masked = useMemo(() => maskSecrets(snap) as Record<string, unknown>, [snap]);

  function refresh() {
    setSnap(snapshot());
  }

  async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
    const t0 = performance.now();
    const result = await fn();
    return { result, ms: Math.round(performance.now() - t0) };
  }

  async function runTest(k: TestKey) {
    setRunning(k);
    try {
      if (k === 'backend') {
        const { result, ms } = await timed(async () => getApiClient().get('/api/pos/health', { timeout: 5_000 }));
        setTests((t) => ({
          ...t,
          backend: {
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            latencyMs: ms,
            detail: `pos_api_version=${(result.data as { pos_api_version?: string })?.pos_api_version ?? '?'}`,
          },
        }));
      } else if (k === 'bootstrap') {
        const { result, ms } = await timed(async () =>
          getApiClient().get('/api/pos/bootstrap', { timeout: 8_000 }),
        );
        const data = result.data as { categories?: unknown[]; products?: unknown[]; tables?: unknown[] };
        setTests((t) => ({
          ...t,
          bootstrap: {
            ok: result.status === 200,
            status: result.status,
            latencyMs: ms,
            detail: `cats=${data.categories?.length ?? 0} products=${data.products?.length ?? 0} tables=${data.tables?.length ?? 0}`,
          },
        }));
      } else if (k === 'pull') {
        const { result, ms } = await timed(async () => fetchPullChanges(null, getConfig().deviceId));
        setTests((t) => ({
          ...t,
          pull: {
            ok: true,
            latencyMs: ms,
            detail: `orders=${result.changes.orders.length} items=${result.changes.orderItems.length} tickets=${result.changes.kitchenTickets.length}`,
          },
        }));
      }
    } catch (err: unknown) {
      const e = err as { response?: { status?: number }; message?: string };
      setTests((t) => ({
        ...t,
        [k]: {
          ok: false,
          status: e.response?.status,
          error: e.message ?? String(err),
        },
      }));
    } finally {
      setRunning(null);
    }
  }

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(snapshotAsText());
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('failed');
      setTimeout(() => setCopyState('idle'), 2500);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 shadow-2xl flex flex-col">
        <header className="flex items-center justify-between p-4 border-b border-white/10">
          <h3 className="text-base font-semibold text-white inline-flex items-center gap-2">
            <Activity className="h-5 w-5 text-violet-300" />
            Diagnostics
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refresh}
              className="touch-target px-2 py-1 rounded-md text-[12px] bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60 inline-flex items-center gap-1"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
            <button
              type="button"
              onClick={() => void copyToClipboard()}
              className="touch-target px-2 py-1 rounded-md text-[12px] bg-violet-600/30 text-violet-200 border border-violet-400/40 hover:bg-violet-600/50 inline-flex items-center gap-1"
            >
              <ClipboardCopy className="h-3.5 w-3.5" />
              {copyState === 'copied' ? 'Copiat ✓' : copyState === 'failed' ? 'Eroare' : 'Copy'}
            </button>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* ─── Connectivity tests ───────────────────────────────── */}
          <section>
            <h4 className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-2 inline-flex items-center gap-2">
              <Server className="h-3.5 w-3.5" /> Backend connectivity
            </h4>
            <div className="grid grid-cols-1 gap-1.5">
              <TestRow
                label="Test backend (/api/pos/health)"
                result={tests.backend}
                running={running === 'backend'}
                onRun={() => void runTest('backend')}
              />
              <TestRow
                label="Test bootstrap (/api/pos/bootstrap)"
                result={tests.bootstrap}
                running={running === 'bootstrap'}
                onRun={() => void runTest('bootstrap')}
              />
              <TestRow
                label="Test pull (/api/pos/sync/pull)"
                result={tests.pull}
                running={running === 'pull'}
                onRun={() => void runTest('pull')}
              />
              <div className="text-[11px] text-slate-500 italic mt-1">
                Test push deliberat omis — ar crea o comandă reală în DB.
              </div>
            </div>
          </section>

          {/* ─── Snapshot table ───────────────────────────────────── */}
          <section>
            <h4 className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-2">
              Snapshot ({snap.generatedAt})
            </h4>
            <div className="rounded-lg border border-white/10 bg-slate-900/40 p-3 text-[12px] font-mono text-slate-200 overflow-x-auto space-y-0.5">
              {Object.entries(masked).map(([k, v]) => (
                <div key={k} className="flex">
                  <span className="text-slate-400 min-w-[14rem]">{k}</span>
                  <span className="text-slate-100">{JSON.stringify(v)}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              Tokens / secrets sunt mascate automat. Snapshot-ul de mai sus e safe de copiat în Slack/email.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

function TestRow({
  label,
  result,
  running,
  onRun,
}: {
  label: string;
  result: TestResult | null;
  running: boolean;
  onRun: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-slate-200">{label}</div>
        {result && (
          <div className={`text-[11px] mt-0.5 inline-flex items-center gap-1 ${result.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
            {result.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
            {result.ok ? 'OK' : 'FAIL'}
            {result.status != null && ` · ${result.status}`}
            {result.latencyMs != null && ` · ${result.latencyMs}ms`}
            {result.detail && ` · ${result.detail}`}
            {result.error && ` · ${result.error}`}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onRun}
        disabled={running}
        className="touch-target rounded-lg px-3 py-1.5 text-[12px] font-semibold bg-violet-600/30 text-violet-200 border border-violet-400/40 hover:bg-violet-600/50 disabled:opacity-50"
      >
        {running ? '…' : 'Test'}
      </button>
    </div>
  );
}
