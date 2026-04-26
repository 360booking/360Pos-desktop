/**
 * LoginScreen — Sprint 10.
 *
 * Initial window when the user has no valid refresh token. Premium dark
 * theme, touchscreen-friendly tap targets (≥44px). Romanian copy
 * matching the rest of the POS shell.
 */
import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2, Lock, MailIcon, RefreshCw, ShieldCheck, Wifi, WifiOff } from 'lucide-react';

import { health, type HealthResponse } from '@/lib/api/client';
import { LoginError, login as loginApi } from '@/lib/api/auth';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { authDeviceId, useAuthStore } from '@/store/auth';

const APP_VERSION = '0.1.0';

export function LoginScreen() {
  const setLogin = useAuthStore((s) => s.setLogin);
  const setError = useAuthStore((s) => s.setError);
  const lastError = useAuthStore((s) => s.lastError);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [stayLoggedIn, setStayLoggedIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [healthState, setHealthState] = useState<HealthResponse | null>(null);
  const [healthChecking, setHealthChecking] = useState(false);

  useEffect(() => {
    void checkHealth();
    return () => setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkHealth() {
    setHealthChecking(true);
    try {
      setHealthState(await health());
    } finally {
      setHealthChecking(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const deviceId = await authDeviceId();
      const resp = await loginApi({
        email: email.trim().toLowerCase(),
        password,
        deviceId,
        deviceName: navigator.platform || 'Windows POS',
        appVersion: APP_VERSION,
        hostname: typeof window !== 'undefined' ? window.location.hostname || 'desktop' : 'desktop',
        os: navigator.userAgent.includes('Windows') ? 'Windows' : navigator.platform,
      });
      setLogin(resp, stayLoggedIn);
      logger.info('auth', 'login ok', { user: resp.user.email, restaurants: resp.restaurants.length });
    } catch (err) {
      const msg =
        err instanceof LoginError
          ? err.detail
          : 'Eroare neașteptată la login.';
      setError(msg);
      logger.warn('auth', 'login failed', { msg });
    } finally {
      setBusy(false);
    }
  }

  const backendUrl = getConfig().backendUrl;

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-white">
      <div className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-6 py-10">
        <div className="grid w-full grid-cols-1 gap-10 lg:grid-cols-2">
          {/* Branding pane */}
          <aside className="hidden flex-col justify-between rounded-3xl border border-white/10 bg-slate-950/40 p-10 backdrop-blur-md lg:flex">
            <div>
              <div className="flex items-center gap-3 text-violet-300">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-2xl font-bold">
                  POS
                </div>
                <div>
                  <p className="text-lg font-semibold tracking-tight">360booking POS</p>
                  <p className="text-xs uppercase tracking-[0.18em] text-violet-300/70">desktop</p>
                </div>
              </div>
              <h1 className="mt-12 text-3xl font-semibold leading-tight">
                Bine ai venit.
              </h1>
              <p className="mt-3 max-w-sm text-sm text-slate-300">
                Loghează-te cu contul tău <span className="text-white">360booking</span>.
                După autentificare, POS-ul descarcă automat mesele,
                produsele și permisiunile pentru restaurantul tău.
              </p>
              <ul className="mt-8 space-y-3 text-sm text-slate-300/80">
                <Bullet>Sincronizare live cu backend-ul.</Bullet>
                <Bullet>Funcționează offline — comenzile se trimit la reconectare.</Bullet>
                <Bullet>Hardware real (Datecs, BT POS, KDS) configurat la nivel de tenant.</Bullet>
              </ul>
            </div>
            <BackendStatus
              checking={healthChecking}
              health={healthState}
              backendUrl={backendUrl}
              onRetry={checkHealth}
            />
          </aside>

          {/* Form pane */}
          <main className="flex flex-col rounded-3xl border border-white/10 bg-slate-950/60 p-8 shadow-2xl backdrop-blur-md sm:p-10">
            <h2 className="text-2xl font-semibold tracking-tight">Login POS</h2>
            <p className="mt-2 text-sm text-slate-400">
              Folosește email-ul și parola din 360booking.
            </p>

            <form className="mt-8 space-y-5" onSubmit={onSubmit}>
              <Field
                label="Email"
                icon={<MailIcon className="h-4 w-4 text-slate-400" />}
              >
                <input
                  type="email"
                  required
                  autoFocus
                  autoComplete="username"
                  placeholder="nume@restaurant.ro"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-transparent py-3 text-base outline-none placeholder:text-slate-600"
                  disabled={busy}
                />
              </Field>

              <Field
                label="Parolă"
                icon={<Lock className="h-4 w-4 text-slate-400" />}
                suffix={
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="rounded-md p-1 text-slate-400 hover:text-slate-100"
                    aria-label={showPassword ? 'Ascunde parola' : 'Arată parola'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                }
              >
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-transparent py-3 text-base outline-none placeholder:text-slate-600"
                  disabled={busy}
                />
              </Field>

              <label className="flex select-none items-center gap-3 text-sm text-slate-300">
                <input
                  type="checkbox"
                  className="h-5 w-5 rounded border-white/20 bg-white/5 accent-violet-500"
                  checked={stayLoggedIn}
                  onChange={(e) => setStayLoggedIn(e.target.checked)}
                />
                Ține-mă logat pe acest dispozitiv
              </label>

              {lastError ? (
                <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                  {lastError}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={busy || !email || !password}
                className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 text-base font-semibold text-white shadow-lg shadow-violet-900/40 transition hover:from-violet-500 hover:to-indigo-500 disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ShieldCheck className="h-5 w-5" />}
                {busy ? 'Verificăm...' : 'Login'}
              </button>
            </form>

            <div className="mt-8 flex items-center justify-between text-xs text-slate-500 lg:hidden">
              <BackendStatus
                checking={healthChecking}
                health={healthState}
                backendUrl={backendUrl}
                onRetry={checkHealth}
                compact
              />
            </div>

            <footer className="mt-10 flex items-center justify-between text-[11px] text-slate-500">
              <span>v{APP_VERSION} · build demo</span>
              <span className="truncate">{backendUrl}</span>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-violet-400" />
      <span>{children}</span>
    </li>
  );
}

function Field({
  label,
  icon,
  suffix,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  suffix?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">{label}</span>
      <div className="mt-2 flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-1 focus-within:border-violet-400/60 focus-within:bg-white/[0.07]">
        {icon}
        <div className="flex-1">{children}</div>
        {suffix}
      </div>
    </label>
  );
}

function BackendStatus({
  checking,
  health,
  backendUrl,
  onRetry,
  compact,
}: {
  checking: boolean;
  health: HealthResponse | null;
  backendUrl: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  const ok = health?.ok === true;
  return (
    <div className={compact ? 'flex w-full items-center justify-between gap-3' : 'rounded-2xl border border-white/10 bg-slate-950/60 p-4'}>
      <div className="flex items-center gap-3">
        {checking ? (
          <Loader2 className="h-4 w-4 animate-spin text-slate-300" />
        ) : ok ? (
          <Wifi className="h-4 w-4 text-emerald-400" />
        ) : (
          <WifiOff className="h-4 w-4 text-rose-400" />
        )}
        <div>
          <p className={compact ? 'text-[11px] uppercase tracking-[0.14em] text-slate-400' : 'text-xs uppercase tracking-[0.14em] text-slate-400'}>
            Backend
          </p>
          <p className={compact ? 'text-xs text-slate-300' : 'text-sm text-slate-200'}>
            {checking
              ? 'verific...'
              : ok
              ? `online · ${health?.latencyMs ?? '?'}ms`
              : 'offline'}
          </p>
          {!compact ? <p className="mt-1 truncate text-[11px] text-slate-500">{backendUrl}</p> : null}
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg p-2 text-slate-300 transition hover:bg-white/10"
        aria-label="Reîncearcă verificarea"
      >
        <RefreshCw className={checking ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
      </button>
    </div>
  );
}
