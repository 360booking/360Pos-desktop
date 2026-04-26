/**
 * RestaurantPicker — Sprint 10.
 *
 * Shown only when the logged-in user has access to more than one
 * restaurant. The current data model is 1 tenant → 1 restaurant, so for
 * the foreseeable future this screen is auto-skipped by the App gate.
 * Kept here so that when multi-restaurant lands the wiring is already
 * in place.
 */
import { useState } from 'react';
import { Building2, Check, Loader2, LogOut } from 'lucide-react';

import type { AuthRestaurant } from '@/lib/api/auth';
import { useAuthStore } from '@/store/auth';
import { logout as logoutApi } from '@/lib/api/auth';

export function RestaurantPicker() {
  const restaurants = useAuthStore((s) => s.restaurants);
  const select = useAuthStore((s) => s.selectRestaurant);
  const clear = useAuthStore((s) => s.clear);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const tenantName = useAuthStore((s) => s.tenant?.name ?? '');
  const userEmail = useAuthStore((s) => s.user?.email ?? '');

  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pick(r: AuthRestaurant) {
    setPending(r.id);
    select(r.id);
  }

  async function onLogout() {
    if (busy) return;
    setBusy(true);
    try {
      await logoutApi(refreshToken);
    } finally {
      await clear();
    }
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-white">
      <div className="mx-auto flex min-h-screen max-w-4xl flex-col px-6 py-12">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-violet-300/70">{tenantName}</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">
              Alege restaurantul
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Logat ca <span className="text-slate-200">{userEmail}</span>.
            </p>
          </div>
          <button
            onClick={onLogout}
            disabled={busy}
            className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 hover:bg-white/10 disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" /> Logout
          </button>
        </header>

        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {restaurants.map((r) => {
            const isPending = pending === r.id;
            return (
              <button
                key={r.id}
                onClick={() => pick(r)}
                className="group relative flex h-32 flex-col justify-between rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-left transition hover:border-violet-400/60 hover:bg-white/[0.07]"
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600">
                    <Building2 className="h-5 w-5 text-white" />
                  </div>
                  <div>
                    <p className="text-base font-semibold">{r.name}</p>
                    {r.isDefault ? (
                      <p className="text-[11px] uppercase tracking-[0.14em] text-violet-300/80">
                        implicit
                      </p>
                    ) : null}
                  </div>
                </div>
                <p className="text-xs text-slate-400">
                  {isPending ? 'Se încarcă restaurantul...' : 'Selectează pentru a continua'}
                </p>
                {isPending ? (
                  <Loader2 className="absolute right-4 top-4 h-4 w-4 animate-spin text-violet-300" />
                ) : (
                  <Check className="absolute right-4 top-4 h-4 w-4 text-transparent transition group-hover:text-violet-300" />
                )}
              </button>
            );
          })}
        </div>

        {restaurants.length === 0 ? (
          <p className="mt-12 rounded-2xl border border-amber-400/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-200">
            Contul tău nu are niciun restaurant configurat. Cere unui
            tenant_admin să te asocieze unui restaurant și apoi loghează-te
            din nou.
          </p>
        ) : null}
      </div>
    </div>
  );
}
