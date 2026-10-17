/**
 * Cât de des întreabă POS-ul desktop serverul, după programul localului (2026-10-17).
 *
 * Serverul (`GET /api/restaurant/sondare`) spune dacă localul e „în program”
 * (programul din Setări ± o oră, servirea în cameră, activitate: notă atinsă în
 * ultimele 2 ore, comandă de aprobat, chelner chemat). În program → intervalul
 * obișnuit; altfel o dată la 5 minute (nu se pierde nimic). O atingere / tastă →
 * ritm normal 10 minute, cu reîmprospătare imediată. Fără program, cu server vechi
 * (404) sau offline → exact ca înainte.
 *
 * Doar bannerul de alerte îl folosește; sincronizarea offline (pull/outbox) are
 * ritmul ei și nu e atinsă.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getApiClient } from './api/client';

export interface PoliticaSondare {
  configurat: boolean;
  inProgram: boolean;
  activ: boolean;
  rapid: boolean;
  motiv: string;
  intervalLentS: number;
  panaLa: string | null;
  secundePanaLa: number | null;
}

export const INTERVAL_LENT_IMPLICIT_MS = 5 * 60_000;
export const INTERACTIUNE_MS = 10 * 60_000;

export function eRapid(p: PoliticaSondare | null, activLocal = false, interactiune = false): boolean {
  return !p || !p.configurat || p.rapid || activLocal || interactiune;
}

export function intervalSondare(normalMs: number, p: PoliticaSondare | null, activLocal = false, interactiune = false): number {
  if (eRapid(p, activLocal, interactiune)) return normalMs;
  return Math.max(normalMs, (p?.intervalLentS ?? 0) * 1000 || INTERVAL_LENT_IMPLICIT_MS);
}

export function urmatoareaPolitica(p: PoliticaSondare | null): number {
  if (!p) return 15 * 60_000;
  const pas = p.configurat && !p.inProgram ? 5 * 60_000 : 15 * 60_000;
  if (p.secundePanaLa != null) return Math.max(5_000, Math.min(pas, p.secundePanaLa * 1000 + 2_000));
  return pas;
}

const stare = { politica: null as PoliticaSondare | null, ultimaInteractiune: 0, abonati: 0, versiune: 0, timer: 0 as unknown as ReturnType<typeof setTimeout> };
const ascultatori = new Set<() => void>();

function anunta() {
  stare.versiune++;
  ascultatori.forEach((f) => f());
}

export function interactiuneRecenta(acum = Date.now()): boolean {
  return acum - stare.ultimaInteractiune < INTERACTIUNE_MS;
}

async function citeste() {
  try {
    const r = await getApiClient().get<PoliticaSondare>('/api/restaurant/sondare');
    stare.politica = r.data && typeof r.data.rapid === 'boolean' ? r.data : null;
  } catch {
    stare.politica = null;
  }
  anunta();
  if (stare.abonati > 0) stare.timer = setTimeout(() => void citeste(), urmatoareaPolitica(stare.politica));
}

function laInteractiune() {
  const era = interactiuneRecenta();
  stare.ultimaInteractiune = Date.now();
  if (!era) anunta();
}

const EVENIMENTE = ['pointerdown', 'keydown'] as const;

function subscribe(f: () => void) {
  ascultatori.add(f);
  stare.abonati++;
  if (stare.abonati === 1) {
    EVENIMENTE.forEach((e) => window.addEventListener(e, laInteractiune, { passive: true }));
    void citeste();
  }
  const t = setInterval(() => { if (!interactiuneRecenta()) f(); }, 60_000);
  return () => {
    clearInterval(t);
    ascultatori.delete(f);
    stare.abonati--;
    if (stare.abonati === 0) {
      EVENIMENTE.forEach((e) => window.removeEventListener(e, laInteractiune));
      clearTimeout(stare.timer);
    }
  };
}

/** Intervalul de acum pentru un ecran care sondează la `normalMs` în timpul serviciului. */
export function useIntervalSondare(normalMs: number, activ = false): number {
  useSyncExternalStore(subscribe, () => stare.versiune + (interactiuneRecenta() ? 0.5 : 0));
  return intervalSondare(normalMs, stare.politica, activ, interactiuneRecenta());
}

/**
 * `setInterval(fn, interval)` care, când intervalul scade (din lent în normal),
 * rulează o dată imediat.
 */
export function useSondareLaInterval(fn: () => void, intervalMs: number): void {
  const anterior = useRef(intervalMs);
  useEffect(() => {
    if (intervalMs < anterior.current) fn();
    anterior.current = intervalMs;
    const id = setInterval(fn, intervalMs);
    return () => clearInterval(id);
  }, [fn, intervalMs]);
}
