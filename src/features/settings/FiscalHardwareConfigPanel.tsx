/**
 * Hardware config — replaces FISCAL_* env vars with a Settings form.
 *
 * The form writes a single row in `fiscal_runtime_config` (SQLite migration
 * 0007). Rust commands consult that row first via
 * `runtime_config::effective_*`, falling back to env vars only when a value is
 * NULL. Saving always re-reads the row so the UI displays exactly what the
 * Rust side will see on the next print.
 *
 * "Test now" chains save → fiscal_test_connection → fiscal_get_status so the
 * operator can validate the COM port + baud + operator credentials in a
 * single click. Real fiscal print stays gated behind the diagnostic button
 * below — this panel only proves the wire is open.
 */
import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Save,
  Settings as SettingsIcon,
  Plug,
} from 'lucide-react';
import {
  getFiscalRuntimeConfig,
  setFiscalRuntimeConfig,
  listSerialPorts,
  type FiscalRuntimeConfig,
} from '@/adapters/fiscal/runtime-config';
import { enableRustFiscalIfAllowed } from '@/adapters';
import type { FiscalStatus } from '@/adapters/fiscal/types';
import { logger } from '@/lib/logger';

// Never log the operator password — every safe-to-log key only.
function loggableConfig(c: FiscalRuntimeConfig) {
  return {
    provider: c.provider,
    serial_port: c.serial_port,
    baud: c.baud,
    protocol_variant: c.protocol_variant,
    operator: c.operator,
    printer_model: c.printer_model,
    use_rust: c.use_rust,
    enable_raw_logs: c.enable_raw_logs,
    has_password: Boolean(c.operator_password),
  };
}

type AsyncState<T> =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'ok'; value: T }
  | { state: 'err'; error: string };

const PROVIDERS: { value: string; label: string }[] = [
  { value: 'simulator', label: 'Simulator (fără casă fizică)' },
  { value: 'datecs_dp25', label: 'Datecs DP-25 (FP-55)' },
  { value: 'datecs_fp', label: 'Datecs FP-700 / DP-150' },
];

const BAUD_OPTIONS = [9600, 19200, 38400, 57600, 115200];

const PROTOCOL_VARIANTS = [
  { value: 'fp55', label: 'FP-55 (default DP-25)' },
  { value: 'fp700', label: 'FP-700 (XOR BCC)' },
];

function emptyConfig(): FiscalRuntimeConfig {
  return {
    provider: 'simulator',
    serial_port: null,
    baud: 9600,
    protocol_variant: 'fp55',
    operator: '1',
    operator_password: '0000',
    printer_model: null,
    use_rust: false,
    enable_raw_logs: false,
    vat_map_json: null,
    cmd_codes_json: null,
  };
}

export function FiscalHardwareConfigPanel() {
  const [cfg, setCfg] = useState<FiscalRuntimeConfig>(emptyConfig());
  const [loaded, setLoaded] = useState(false);
  const [ports, setPorts] = useState<string[]>([]);
  const [portsBusy, setPortsBusy] = useState(false);
  const [save, setSave] = useState<AsyncState<FiscalRuntimeConfig>>({ state: 'idle' });
  const [test, setTest] = useState<AsyncState<{ ok: boolean; detail: string; status?: FiscalStatus }>>({
    state: 'idle',
  });

  useEffect(() => {
    void (async () => {
      try {
        const remote = await getFiscalRuntimeConfig();
        // Backfill defaults for any NULL field so the form has sensible
        // initial values even on a fresh install.
        setCfg({ ...emptyConfig(), ...stripNulls(remote) });
        logger.info('fiscal-config', 'loaded runtime config', loggableConfig(remote));
      } catch (err) {
        // Tauri command may not be wired yet (browser dev) — keep defaults.
        logger.warn('fiscal-config', 'fiscal_get_runtime_config failed', { err: String(err) });
      }
      setLoaded(true);
      void refreshPorts();
    })();
  }, []);

  async function refreshPorts() {
    setPortsBusy(true);
    try {
      const list = await listSerialPorts();
      setPorts(list);
      logger.debug('fiscal-config', 'serial ports listed', { count: list.length, ports: list });
    } catch (err) {
      logger.warn('fiscal-config', 'fiscal_list_ports failed', { err: String(err) });
    } finally {
      setPortsBusy(false);
    }
  }

  async function handleSave() {
    setSave({ state: 'busy' });
    logger.info('fiscal-config', 'save requested', loggableConfig(cfg));
    try {
      const written = await setFiscalRuntimeConfig(cfg);
      setCfg({ ...emptyConfig(), ...stripNulls(written) });
      setSave({ state: 'ok', value: written });
      // Adapter promotion is gated on the same flag — re-evaluate after save.
      const promoted = await enableRustFiscalIfAllowed();
      logger.info('fiscal-config', 'save ok', {
        ...loggableConfig(written),
        rust_adapter_promoted: promoted,
      });
    } catch (err) {
      setSave({ state: 'err', error: String(err) });
      logger.error('fiscal-config', 'save failed', { err: String(err) });
    }
  }

  async function handleTestNow() {
    setTest({ state: 'busy' });
    logger.info('fiscal-config', 'test now requested', loggableConfig(cfg));
    try {
      // Save first so the test exercises the same config the operator sees.
      await setFiscalRuntimeConfig(cfg);
      await enableRustFiscalIfAllowed();
      const conn = await invoke<{ ok: boolean; detail: string }>('fiscal_test_connection');
      let status: FiscalStatus | undefined;
      let statusErr: string | undefined;
      try {
        status = await invoke<FiscalStatus>('fiscal_get_status');
      } catch (e) {
        // get_status can fail without test_connection necessarily failing
        // (e.g. simulator returns ok but status is a no-op). Surface the
        // connection result regardless.
        statusErr = String(e);
      }
      setTest({ state: 'ok', value: { ok: conn.ok, detail: conn.detail, status } });
      logger.info('fiscal-config', 'test now result', {
        connection_ok: conn.ok,
        connection_detail: conn.detail,
        status,
        status_error: statusErr,
      });
    } catch (err) {
      setTest({ state: 'err', error: String(err) });
      logger.error('fiscal-config', 'test now failed', { err: String(err) });
    }
  }

  const requiresPort = useMemo(
    () => cfg.provider === 'datecs_dp25' || cfg.provider === 'datecs_fp',
    [cfg.provider],
  );

  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-100 mb-1 inline-flex items-center gap-2">
        <SettingsIcon className="h-5 w-5 text-emerald-300" /> Casă de marcat — configurare hardware
      </h2>
      <p className="text-sm text-slate-400 mb-6">
        Setările se salvează local pe stație (SQLite). Înlocuiesc complet variabilele de mediu
        FISCAL_* — nu mai e nevoie de reconfigurare Windows pentru COM port, baud sau operator.
      </p>

      <div className="rounded-xl border border-white/10 bg-slate-900/40 p-4 space-y-4 text-sm">
        <Row label="Provider">
          <select
            value={cfg.provider ?? 'simulator'}
            onChange={(e) => setCfg({ ...cfg, provider: e.target.value })}
            disabled={!loaded}
            className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm w-full"
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Port serial">
          <div className="flex gap-2 items-center w-full">
            <select
              value={cfg.serial_port ?? ''}
              onChange={(e) =>
                setCfg({ ...cfg, serial_port: e.target.value === '' ? null : e.target.value })
              }
              disabled={!loaded}
              className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm flex-1"
            >
              <option value="">— alege —</option>
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
              {cfg.serial_port && !ports.includes(cfg.serial_port) ? (
                <option value={cfg.serial_port}>{cfg.serial_port} (salvat)</option>
              ) : null}
            </select>
            <button
              type="button"
              onClick={() => void refreshPorts()}
              disabled={portsBusy}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60"
            >
              {portsBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </button>
            <input
              type="text"
              placeholder="manual: COM7"
              value={ports.includes(cfg.serial_port ?? '') ? '' : (cfg.serial_port ?? '')}
              onChange={(e) =>
                setCfg({ ...cfg, serial_port: e.target.value.trim() === '' ? null : e.target.value.trim() })
              }
              className="bg-slate-800/80 border border-white/10 rounded-lg px-2.5 py-1.5 text-slate-100 text-xs w-32"
            />
          </div>
        </Row>

        <Row label="Baud rate">
          <select
            value={cfg.baud ?? 9600}
            onChange={(e) => setCfg({ ...cfg, baud: parseInt(e.target.value, 10) })}
            disabled={!loaded}
            className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm w-full"
          >
            {BAUD_OPTIONS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Variantă protocol">
          <select
            value={cfg.protocol_variant ?? 'fp55'}
            onChange={(e) => setCfg({ ...cfg, protocol_variant: e.target.value })}
            disabled={!loaded}
            className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm w-full"
          >
            {PROTOCOL_VARIANTS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Operator">
          <input
            type="text"
            value={cfg.operator ?? ''}
            onChange={(e) => setCfg({ ...cfg, operator: e.target.value === '' ? null : e.target.value })}
            placeholder="1"
            className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm w-full"
          />
        </Row>

        <Row label="Parolă operator">
          <input
            type="password"
            value={cfg.operator_password ?? ''}
            onChange={(e) =>
              setCfg({ ...cfg, operator_password: e.target.value === '' ? null : e.target.value })
            }
            placeholder="0000"
            className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm w-full"
          />
        </Row>

        <Row label="Etichetă printer (opțional)">
          <input
            type="text"
            value={cfg.printer_model ?? ''}
            onChange={(e) =>
              setCfg({ ...cfg, printer_model: e.target.value === '' ? null : e.target.value })
            }
            placeholder="ex. Datecs DP-25 — sediul central"
            className="bg-slate-800/80 border border-white/10 rounded-lg px-3 py-1.5 text-slate-100 text-sm w-full"
          />
        </Row>

        <div className="border-t border-white/10 pt-4 space-y-3">
          <label className="flex items-center gap-3 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={cfg.use_rust ?? false}
              onChange={(e) => setCfg({ ...cfg, use_rust: e.target.checked })}
              className="h-4 w-4"
            />
            <span>
              Activează adapterul Rust (FISCAL_USE_RUST). Necesar pentru Datecs real prin Tauri.
            </span>
          </label>

          <label className="flex items-center gap-3 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={cfg.enable_raw_logs ?? false}
              onChange={(e) => setCfg({ ...cfg, enable_raw_logs: e.target.checked })}
              className="h-4 w-4"
            />
            <span>
              Salvează raw request/response în fiscal_attempts (debugging — crește dimensiunea DB).
            </span>
          </label>
        </div>

        {requiresPort && !cfg.serial_port ? (
          <div className="text-xs text-amber-300 inline-flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" /> Portul serial e obligatoriu pentru providerul Datecs.
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap gap-2 items-center">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={save.state === 'busy' || !loaded}
          className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold bg-emerald-500/15 text-emerald-200 border border-emerald-400/30 hover:bg-emerald-500/25 disabled:opacity-50"
        >
          {save.state === 'busy' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Salvează
        </button>
        <button
          type="button"
          onClick={() => void handleTestNow()}
          disabled={test.state === 'busy' || !loaded || (requiresPort && !cfg.serial_port)}
          className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold bg-violet-500/15 text-violet-200 border border-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
        >
          {test.state === 'busy' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          Salvează + Test now
        </button>
        {save.state === 'ok' && (
          <span className="inline-flex items-center gap-1.5 text-emerald-300 text-xs">
            <CheckCircle2 className="h-3.5 w-3.5" /> Salvat — adapterul e re-evaluat la următoarea operațiune.
          </span>
        )}
        {save.state === 'err' && (
          <span className="inline-flex items-center gap-1.5 text-rose-300 text-xs">
            <AlertTriangle className="h-3.5 w-3.5" /> {save.error}
          </span>
        )}
      </div>

      {test.state !== 'idle' && (
        <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/40 p-4 text-sm">
          {test.state === 'busy' && (
            <span className="inline-flex items-center gap-2 text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin" /> Testez conexiunea…
            </span>
          )}
          {test.state === 'ok' && (
            <div className="space-y-2">
              <div
                className={`inline-flex items-center gap-2 text-sm font-semibold ${
                  test.value.ok ? 'text-emerald-300' : 'text-rose-300'
                }`}
              >
                {test.value.ok ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <AlertTriangle className="h-4 w-4" />
                )}
                {test.value.ok ? 'Conectat' : 'Nu răspunde'}
              </div>
              <div className="text-xs text-slate-400">{test.value.detail}</div>
              {test.value.status && (
                <pre className="mt-2 text-xs text-emerald-200 font-mono whitespace-pre-wrap">
                  {JSON.stringify(test.value.status, null, 2)}
                </pre>
              )}
            </div>
          )}
          {test.state === 'err' && (
            <pre className="text-xs text-rose-300 font-mono whitespace-pre-wrap">{test.error}</pre>
          )}
        </div>
      )}

      <p className="text-[11px] text-slate-500 mt-6 leading-relaxed">
        Notă siguranță: parola operator e stocată în clar în SQLite local (Sprint 1). Mutare în
        OS keychain (Stronghold) e ticket Sprint 11+ împreună cu refresh token-ul de auth.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
      <label className="text-xs uppercase tracking-wider text-slate-400 font-semibold">
        {label}
      </label>
      <div>{children}</div>
    </div>
  );
}

function stripNulls(c: FiscalRuntimeConfig): Partial<FiscalRuntimeConfig> {
  const out: Partial<FiscalRuntimeConfig> = {};
  (Object.keys(c) as (keyof FiscalRuntimeConfig)[]).forEach((k) => {
    const v = c[k];
    if (v !== null && v !== undefined) {
      // @ts-expect-error — narrowing through Partial keys
      out[k] = v;
    }
  });
  return out;
}
