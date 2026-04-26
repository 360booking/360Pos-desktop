/**
 * Backoff schedule per offline-sync-strategy.md:
 *   1s, 5s, 30s, 2m, 10m, then capped at 1h.
 *
 * Pure helper so it's trivial to test and tune.
 */
const STEPS_MS = [
  1_000,
  5_000,
  30_000,
  120_000,
  600_000,
];
const CAP_MS = 60 * 60 * 1_000;

/** `attempt` is the *next* attempt number (1 after the first failure). */
export function backoffMs(attempt: number): number {
  if (attempt <= 0) return 0;
  if (attempt - 1 < STEPS_MS.length) return STEPS_MS[attempt - 1];
  return CAP_MS;
}

export function nextRetryIso(nowIso: string, attempt: number): string {
  const ms = Date.parse(nowIso) + backoffMs(attempt);
  return new Date(ms).toISOString();
}
