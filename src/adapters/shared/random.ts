/**
 * Shared randomness for the simulators. Centralised so tests can stub it.
 */
export type SimOutcome = 'success' | 'failed' | 'unknown';

export function jitter(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((r) => setTimeout(r, ms));
}

export function pickOutcome(): SimOutcome {
  const r = Math.random();
  if (r < 0.9) return 'success';
  if (r < 0.95) return 'failed';
  return 'unknown';
}
