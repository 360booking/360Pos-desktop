/**
 * Tiny module-level cache of the most recent health() result so the
 * DiagnosticsModal snapshot can include it without coupling the
 * snapshot code to React state. Updated by every call to health().
 */
import type { HealthResponse } from './client';

let _last: HealthResponse | null = null;

export function rememberHealth(r: HealthResponse): void {
  _last = r;
}

export function readLastHealth(): HealthResponse | null {
  return _last;
}
