/**
 * Settings overlay — Sprint 11.
 *
 * Five tabs in a left sidebar:
 *   - Cont & Sincronizare (Val 1)  → user, tenant, restaurant, sync state
 *   - Casă de marcat (Val 2)        → placeholder
 *   - Imprimante (Val 2)             → placeholder
 *   - BT POS terminal (Val 2)        → placeholder
 *   - Diagnostic (Val 1)             → debug logs toggle + ship button
 *
 * Why two valuri: Val 1 unblocks the live "Trimite e silently dropped"
 * support cycle by giving us shipped logs from the field. Val 2 fills
 * in hardware config so operators stop hand-editing config.json.
 */
import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Download,
  Eraser,
  Loader2,
  LogOut,
  Printer,
  Receipt,
  RefreshCw,
  Send,
  Settings as SettingsIcon,
  Terminal,
  User as UserIcon,
  Wifi,
  X,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { logout as logoutCall } from '@/lib/api/auth';
import { stopSyncEngine, getSyncEngine } from '@/lib/sync/bootstrap';
import { initDb } from '@/lib/db';
import { snapshot, type DiagnosticsSnapshot } from '@/lib/diagnostics';
import {
  isDebugEnabled,
  loadDebugFlag,
  setDebugEnabled,
} from '@/lib/debugLog';
import {
  flushNow,
  readPendingDumpCount,
  readLastShippedAt,
  exportLogsAsText,
  type FlushOutcome,
} from '@/lib/diagnostics/shipper';
import { snapshot as snapshot11_5 } from '@/lib/diagnostics';
import { FiscalSetupWizard } from './FiscalSetupWizard';
import { getRecentLogEntries, subscribeLogs, clearLogEntries, isVerboseLogging, setVerboseLogging } from '@/lib/logger';

type TabKey = 'cont' | 'fiscal' | 'printer' | 'btpos' | 'diagnostic';

interface TabDef {
  key: TabKey;
  label: string;
  icon: typeof SettingsIcon;
  ready: boolean;
}

const TABS: TabDef[] = [
  { key: 'cont', label: 'Cont & Sincronizare', icon: UserIcon, ready: true },
  { key: 'fiscal', label: 'Casă de marcat', icon: Receipt, ready: true },
  { key: 'printer', label: 'Imprimante', icon: Printer, ready: false },
  { key: 'btpos', label: 'BT POS terminal', icon: Terminal, ready: false },
  { key: 'diagnostic', label: 'Diagnostic', icon: SettingsIcon, ready: true },
];

export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>('cont');
  return (
    <div
      className="fixed inset-0 z-[60] flex items-stretch bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="m-auto w-[min(1100px,96vw)] h-[min(720px,92vh)] rounded-2xl bg-slate-950 border border-white/10 shadow-2xl flex overflow-hidden">
        <aside className="w-56 shrink-0 bg-slate-900/60 border-r border-white/10 flex flex-col">
          <div className="px-4 py-4 border-b border-white/10 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100 inline-flex items-center gap-2">
              <SettingsIcon className="h-4 w-4 text-violet-300" /> Setări
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-white/10"
              title="Închide"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <nav className="flex-1 overflow-y-auto py-2">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`w-full text-left px-4 py-2.5 text-sm flex items-center gap-2 border-l-2 ${
                    active
                      ? 'border-violet-400 bg-violet-500/10 text-violet-100'
                      : 'border-transparent text-slate-300 hover:bg-white/5'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="flex-1">{t.label}</span>
                  {!t.ready && (
                    <span className="text-[9px] uppercase tracking-wider text-amber-300/80 bg-amber-500/10 border border-amber-400/30 rounded px-1.5 py-0.5">
                      curând
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
          <div className="px-4 py-3 border-t border-white/10 text-[10px] text-slate-500">
            POS desktop · Sprint 11
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto p-6">
          {tab === 'cont' && <ContSyncTab />}
          {tab === 'fiscal' && <FiscalSetupWizard />}
          {tab === 'printer' && <ComingSoonTab title="Imprimante" hint="Imprimantă chitanțe + ticket bucătărie + autoprint la Trimite/plată. Vine în Val 2." />}
          {tab === 'btpos' && <ComingSoonTab title="BT POS terminal" hint="Configurare ECR + IP terminal. Așteaptă activarea ECR la BT pentru testare reală. Vine în Val 2." />}
          {tab === 'diagnostic' && <DiagnosticTab />}
        </main>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="text-xs uppercase tracking-wider text-slate-400 font-semibold mb-3">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="text-slate-400 w-44 shrink-0">{label}</span>
      <span className={`text-slate-100 ${mono ? 'font-mono text-xs' : ''}`}>{value ?? '—'}</span>
    </div>
  );
}

function ContSyncTab() {
  const auth = useAuthStore();
  const [snap, setSnap] = useState<DiagnosticsSnapshot>(() => snapshot());
  const [busy, setBusy] = useState<'logout' | 'reload' | null>(null);
  function refresh() {
    setSnap(snapshot());
  }
  async function handleLogout() {
    setBusy('logout');
    try {
      await logoutCall(auth.refreshToken).catch(() => undefined);
      stopSyncEngine();
      await auth.clear();
    } finally {
      setBusy(null);
    }
  }
  async function handleReloadBootstrap() {
    setBusy('reload');
    try {
      const engine = getSyncEngine();
      if (engine) {
        await engine.bootstrapScheduler.runNow();
        await engine.pullScheduler.runNow();
      }
      refresh();
    } finally {
      setBusy(null);
    }
  }
  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-100 mb-1 inline-flex items-center gap-2">
        <UserIcon className="h-5 w-5 text-violet-300" /> Cont & Sincronizare
      </h2>
      <p className="text-sm text-slate-400 mb-6">Cine ești, unde se conectează aplicația și ce a livrat ultima sincronizare.</p>

      <Section title="Cont">
        <Field label="Email" value={snap.authUserEmail ?? '—'} />
        <Field label="Rol" value={snap.userRole ?? '—'} />
        <Field label="Tenant" value={snap.authTenantSlug ?? '—'} />
        <Field label="Restaurant selectat" value={snap.authRestaurantName ?? '—'} />
        <div className="pt-2">
          <button
            type="button"
            onClick={handleLogout}
            disabled={busy === 'logout'}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold bg-rose-500/15 text-rose-200 border border-rose-400/30 hover:bg-rose-500/25 disabled:opacity-50"
          >
            {busy === 'logout' ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
            Logout
          </button>
        </div>
      </Section>

      <Section title="Conexiune backend">
        <Field label="Backend URL" value={snap.backendUrl} mono />
        <Field label="Profil build" value={snap.buildProfile} />
        <Field label="Transport sync" value={snap.syncTransportMode} />
        <Field label="Device ID" value={snap.deviceId} mono />
        <Field
          label="Ultimul /health"
          value={snap.healthOk == null ? '—' : (
            <span className={snap.healthOk ? 'text-emerald-300' : 'text-rose-300'}>
              {snap.healthOk ? `OK ${snap.healthLatencyMs ?? '?'}ms` : `eșuat (${snap.healthErrorClass ?? 'unknown'})`}
            </span>
          )}
        />
      </Section>

      <Section title="Bootstrap (catalog inițial)">
        <Field
          label="Status"
          value={
            <span
              className={
                snap.bootstrapStatus === 'ok'
                  ? 'text-emerald-300'
                  : snap.bootstrapStatus === 'error'
                    ? 'text-rose-300'
                    : 'text-amber-300'
              }
            >
              {snap.bootstrapStatus === 'ok' ? 'OK' : snap.bootstrapStatus === 'error' ? `Eroare: ${snap.bootstrapError}` : 'nu a rulat'}
            </span>
          }
        />
        <Field label="Restaurant trimis" value={snap.bootstrapRestaurantIdSent ?? '—'} mono />
        <Field label="Restaurant rezolvat" value={snap.bootstrapRestaurantNameResolved ?? '—'} />
        <Field label="Categorii / Produse / Mese" value={`${snap.bootstrapCategoriesCount ?? 0} / ${snap.bootstrapProductsCount ?? 0} / ${snap.bootstrapTablesCount ?? 0}`} />
      </Section>

      <Section title="Stare locală">
        <Field label="Categorii / Produse / Mese (local)" value={`${snap.localCategoriesCount} / ${snap.localProductsCount} / ${snap.localTablesCount}`} />
        <Field label="Comenzi deschise (din pull)" value={snap.localOpenOrdersCount} />
        <Field label="Tichete bucătărie (din pull)" value={snap.localKitchenTicketsCount} />
        <Field label="Outbox în așteptare" value={snap.queueDepth} />
        <Field label="Outbox eșuate" value={snap.syncFailed} />
        <Field label="Outbox dead-letter" value={snap.syncDead} />
      </Section>

      <div>
        <button
          type="button"
          onClick={handleReloadBootstrap}
          disabled={busy === 'reload'}
          className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
        >
          {busy === 'reload' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Reîncarcă bootstrap + pull
        </button>
      </div>
    </div>
  );
}

function DiagnosticTab() {
  const [enabled, setEnabled] = useState(() => isDebugEnabled());
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [lastShipped, setLastShipped] = useState<string | null>(null);
  const [shipState, setShipState] = useState<'idle' | 'shipping' | 'ok' | 'err'>('idle');
  const [shipDetail, setShipDetail] = useState<FlushOutcome | null>(null);
  const [busyToggle, setBusyToggle] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'ok'>('idle');
  const [snap, setSnap] = useState(() => snapshot11_5());

  function refreshCounts() {
    setPendingCount(readPendingDumpCount());
    setLastShipped(readLastShippedAt());
    setSnap(snapshot11_5());
  }
  useEffect(() => {
    void loadDebugFlag().then((on) => setEnabled(on));
    refreshCounts();
    const i = setInterval(refreshCounts, 3_000);
    return () => clearInterval(i);
  }, []);

  async function toggle() {
    setBusyToggle(true);
    try {
      await setDebugEnabled(!enabled);
      setEnabled(!enabled);
    } finally {
      setBusyToggle(false);
    }
  }

  async function ship() {
    setShipState('shipping');
    setShipDetail(null);
    const out = await flushNow();
    setShipDetail(out);
    setShipState(out.errored ? 'err' : 'ok');
    refreshCounts();
  }

  async function copyLogs() {
    const text = exportLogsAsText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('ok');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      // best-effort
    }
  }

  function downloadLogs() {
    // Sprint 11.9 — Tauri's WebView2 silently swallows blob URL
    // downloads (no Save dialog ever appears). Workaround: open the
    // text in a new top-level window so the operator can right-click
    // → Save Page As, or copy from the visible textarea. The new
    // window is sandboxed (about:blank + document.write) so it
    // doesn't disturb the running engine in the parent webview.
    const text = exportLogsAsText();
    if (!text) return;
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) {
      // Popup blocked / Tauri refused — fall back to clipboard so
      // the operator still has a path forward.
      void navigator.clipboard.writeText(text).then(() => {
        alert(
          'Browser-ul a blocat fereastra de export. Logurile au fost copiate în clipboard — deschide Notepad și apasă Ctrl+V.',
        );
      });
      return;
    }
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    win.document.open();
    win.document.write(
      `<!doctype html><html><head><title>POS desktop logs — ${new Date().toLocaleString('ro-RO')}</title><style>body{margin:0;background:#0f172a;color:#f1f5f9;font-family:Consolas,Monaco,monospace;font-size:11px;padding:8px}textarea{width:100%;height:calc(100vh - 16px);background:#0f172a;color:#f1f5f9;border:0;outline:0;resize:none;font-family:inherit;font-size:inherit}</style></head><body><textarea readonly>${escaped}</textarea><script>document.querySelector('textarea').select();</script></body></html>`,
    );
    win.document.close();
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-100 mb-1 inline-flex items-center gap-2">
        <SettingsIcon className="h-5 w-5 text-violet-300" /> Diagnostic
      </h2>
      <p className="text-sm text-slate-400 mb-6">
        Activează loguri detaliate când ai o problemă, repetă acțiunea, apoi trimite-le la suport.
      </p>

      <Section title="Loguri detaliate">
        <div className="rounded-xl border border-white/10 bg-slate-900/40 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-200">
              <div className="font-semibold inline-flex items-center gap-2">
                <Wifi className="h-4 w-4 text-violet-300" /> Logare verbose
              </div>
              <div className="text-xs text-slate-400 mt-1">
                Înregistrează fiecare acțiune (Trimite, Adaugă, Plată), fiecare push/pull și fiecare eroare.
                Fără impact asupra vitezei când e oprit.
              </div>
            </div>
            <button
              type="button"
              onClick={toggle}
              disabled={busyToggle}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                enabled ? 'bg-emerald-500/80' : 'bg-slate-700'
              } disabled:opacity-50`}
              aria-pressed={enabled}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                  enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
          <div className="text-xs">
            Stare:{' '}
            <span className={enabled ? 'text-emerald-300' : 'text-slate-400'}>
              {enabled ? 'PORNIT — toate acțiunile sunt înregistrate' : 'OPRIT'}
            </span>
          </div>
        </div>
      </Section>

      <Section title="Trimitere la suport (manual)">
        <div className="rounded-xl border border-white/10 bg-slate-900/40 p-4 space-y-3">
          <Field label="Linii în memorie" value={pendingCount} />
          <Field label="Mod logging" value="memory (RAM, fără SQLite)" />
          <Field label="Ultimul lot trimis" value={lastShipped ? new Date(lastShipped).toLocaleString('ro-RO') : '—'} />
          <div className="pt-1 flex items-center flex-wrap gap-2">
            <button
              type="button"
              onClick={copyLogs}
              disabled={pendingCount === 0}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60 disabled:opacity-40"
            >
              {copyState === 'ok' ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <ClipboardCopy className="h-4 w-4" />}
              {copyState === 'ok' ? 'Copiat' : 'Copy logs'}
            </button>
            <button
              type="button"
              onClick={downloadLogs}
              disabled={pendingCount === 0}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60 disabled:opacity-40"
            >
              <Download className="h-4 w-4" />
              Export logs
            </button>
            <button
              type="button"
              onClick={ship}
              disabled={shipState === 'shipping' || pendingCount === 0}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
            >
              {shipState === 'shipping' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send diagnostics
            </button>
            {shipState === 'ok' && shipDetail && (
              <span className="inline-flex items-center gap-1 text-sm text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> {shipDetail.shipped} livrate
              </span>
            )}
            {shipState === 'err' && shipDetail && (
              <span className="inline-flex items-center gap-1 text-sm text-rose-300">
                <AlertTriangle className="h-4 w-4" /> {shipDetail.errorMessage ?? 'eșuat'}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500">
            Logging-ul nu mai scrie în SQLite și nu se trimite automat — apasă butonul când vrei să trimiți. Tokenuri / parole nu sunt incluse.
          </p>
        </div>
      </Section>

      <Section title="Log live (ultimele 50)">
        <VerboseToggle />
        <LiveLogTail />
      </Section>

      <Section title="Stare outbox + sync (live)">
        <Field label="Outbox queue depth" value={snap.queueDepth} />
        <Field label="DB queue depth (mutex)" value={snap.dbQueueDepth} />
        <Field label="Last tick" value={snap.outboxLastTickAt ? new Date(snap.outboxLastTickAt).toLocaleTimeString('ro-RO') : '—'} />
        <Field label="Last due count" value={snap.outboxLastDueCount} />
        <Field label="Last push attempt" value={snap.outboxLastPushAttemptAt ? new Date(snap.outboxLastPushAttemptAt).toLocaleTimeString('ro-RO') : '—'} />
        <Field label="Last push result" value={snap.outboxLastPushResult ?? '—'} />
        <Field label="Last push duration" value={snap.lastPushDurationMs != null ? `${snap.lastPushDurationMs}ms` : '—'} />
        <Field label="Last pull duration" value={snap.lastPullDurationMs != null ? `${snap.lastPullDurationMs}ms` : '—'} />
        <Field label="Last persistBatch error" value={snap.lastPersistBatchError ?? '—'} />
        <Field label="Last worker error" value={snap.outboxLastError ?? '—'} />
      </Section>

      <Section title="Locație fișiere locale">
        <Field label="Bază de date SQLite" value={'%APPDATA%\\com.x360booking.pos\\pos-desktop.db'} mono />
        <Field label="Config" value={'%APPDATA%\\com.x360booking.pos\\config.json'} mono />
      </Section>

      <ResetSection />
    </div>
  );
}

function VerboseToggle() {
  const [on, setOn] = useState(() => isVerboseLogging());
  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/40 p-3 mb-2 flex items-center justify-between">
      <div>
        <div className="text-xs font-semibold text-slate-200">Mod verbose (dev)</div>
        <div className="text-[11px] text-slate-400">
          Activează pentru a vedea log-urile <code>debug</code> pe categoriile pos.* (order, sync, fiscal, menu, tables). Oprit by default — info/warn/error sunt mereu logate.
        </div>
      </div>
      <button
        type="button"
        onClick={() => { const next = !on; setVerboseLogging(next); setOn(next); }}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${on ? 'bg-violet-500/80' : 'bg-slate-700'}`}
        aria-pressed={on}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}

function LiveLogTail() {
  const [, force] = useState(0);
  const [filter, setFilter] = useState<'all' | 'fiscal' | 'sync' | 'errors'>('all');

  useEffect(() => {
    const unsub = subscribeLogs(() => force((n) => n + 1));
    return unsub;
  }, []);

  const all = getRecentLogEntries(200);
  const filtered = all.filter((e) => {
    if (filter === 'all') return true;
    if (filter === 'errors') return e.level === 'warn' || e.level === 'error';
    if (filter === 'fiscal') return e.source.includes('fiscal') || e.source === 'adapters';
    if (filter === 'sync') return e.source === 'sync' || e.source === 'app' || e.source === 'db';
    return true;
  }).slice(-50);

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 p-3 text-xs">
      <div className="flex items-center justify-between mb-2">
        <div className="inline-flex gap-1">
          {(['all', 'fiscal', 'sync', 'errors'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`px-2 py-0.5 rounded text-[11px] ${filter === f ? 'bg-violet-500/20 text-violet-200 border border-violet-400/30' : 'bg-slate-700/30 text-slate-300 border border-white/10'}`}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => { clearLogEntries(); }}
          className="px-2 py-0.5 rounded text-[11px] bg-slate-700/30 text-slate-300 border border-white/10 hover:bg-slate-700/60"
        >
          clear
        </button>
      </div>
      <div className="bg-black/40 border border-white/10 rounded p-2 max-h-72 overflow-auto font-mono text-[11px] leading-snug space-y-0.5">
        {filtered.length === 0 && <div className="text-slate-500">— niciun log încă —</div>}
        {filtered.map((e, i) => {
          const cls = e.level === 'error' ? 'text-rose-300'
            : e.level === 'warn' ? 'text-amber-300'
            : e.level === 'info' ? 'text-emerald-200'
            : 'text-slate-400';
          const time = new Date(e.ts).toLocaleTimeString('ro-RO', { hour12: false });
          const ctxStr = e.ctx ? ' ' + (typeof e.ctx === 'string' ? e.ctx : JSON.stringify(e.ctx)) : '';
          return (
            <div key={i} className={cls}>
              <span className="text-slate-500">{time}</span> [{e.level}] {e.source}: {e.message}{ctxStr}
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-slate-500 mt-1">
        Ultimele 200 entries în RAM, filtrate la 50. Se actualizează live când apare ceva nou.
      </p>
    </div>
  );
}

function ResetSection() {
  const auth = useAuthStore();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'idle' | 'ok' | 'err'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function reset() {
    setBusy(true);
    setErrorMsg(null);
    try {
      // 1. Best-effort logout call (server invalidates the refresh token).
      try {
        await logoutCall(auth.refreshToken);
      } catch {
        // ignore — we're tearing down anyway
      }
      // 2. Stop the engine — closes schedulers, detaches debug logger.
      stopSyncEngine();
      // 3. Drop and recreate every table the app owns. The next launch
      //    re-runs the migrations from scratch in tauri-plugin-sql.
      const db = await initDb();
      const tables = [
        'remote_kitchen_tickets',
        'remote_order_items',
        'remote_orders',
        'card_recoveries',
        'fiscal_attempts',
        'payment_attempts',
        'station_pairings',
        'tables',
        'products',
        'categories',
        'sync_outbox',
        'events',
        'sync_cursor',
        'device_logs',
        'settings',
      ];
      for (const t of tables) {
        try {
          await db.execute(`DELETE FROM ${t}`);
        } catch {
          // table might not exist on older schemas — keep going
        }
      }
      // 4. Clear in-memory auth state. The user will land back on Login.
      await auth.clear();
      setResult('ok');
    } catch (err) {
      setErrorMsg((err as Error)?.message ?? String(err));
      setResult('err');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <Section title="Resetare aplicație">
      <div className="rounded-xl border border-rose-400/30 bg-rose-500/5 p-4 space-y-3">
        <div className="text-sm text-slate-200">
          <div className="font-semibold inline-flex items-center gap-2 text-rose-200">
            <Eraser className="h-4 w-4" /> Șterge toate datele locale
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Curăță cache-ul SQLite (catalog, comenzi locale, outbox, loguri),
            deconectează contul și revine la ecranul de login. Util când ai
            comenzi blocate în coadă sau vrei să pornești de la zero fără
            reinstalare.
          </div>
        </div>
        {!confirming && result === 'idle' && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold bg-rose-500/15 text-rose-200 border border-rose-400/30 hover:bg-rose-500/25"
          >
            <Eraser className="h-4 w-4" /> Resetare aplicație...
          </button>
        )}
        {confirming && (
          <div className="space-y-2">
            <p className="text-sm text-rose-200 font-semibold">
              Ești sigur? Toate datele locale (comenzi nesincronizate, cache,
              loguri) vor fi șterse. Acțiune ireversibilă.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={reset}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold bg-rose-500/30 text-rose-100 border border-rose-400/50 hover:bg-rose-500/50 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eraser className="h-4 w-4" />}
                Da, șterge tot
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold bg-slate-700/50 text-slate-200 border border-white/10 hover:bg-slate-700"
              >
                Anulează
              </button>
            </div>
          </div>
        )}
        {result === 'ok' && (
          <div className="text-sm text-emerald-300 inline-flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" /> Resetat. Vei fi redirecționat la login.
          </div>
        )}
        {result === 'err' && (
          <div className="text-sm text-rose-300 inline-flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> Eșuat: {errorMsg ?? 'eroare necunoscută'}
          </div>
        )}
      </div>
    </Section>
  );
}

function ComingSoonTab({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center max-w-md mx-auto py-16">
      <div className="rounded-full bg-amber-500/10 border border-amber-400/30 p-4 mb-4">
        <SettingsIcon className="h-8 w-8 text-amber-300" />
      </div>
      <h2 className="text-lg font-semibold text-slate-100 mb-2">{title}</h2>
      <p className="text-sm text-slate-400">{hint}</p>
    </div>
  );
}
