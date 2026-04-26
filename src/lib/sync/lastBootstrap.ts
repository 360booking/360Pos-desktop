/**
 * Module-level cache of the most recent bootstrap result so the
 * Diagnostics snapshot and the TablesPane empty-state can show what
 * the backend actually returned (not just what the local catalog has).
 *
 * Updated by every successful + failed runBootstrap.
 */
import type { RunBootstrapResult } from './runBootstrap';

let _last: RunBootstrapResult | null = null;
let _restaurantIdUsed: string | null = null;

export function rememberBootstrap(r: RunBootstrapResult, restaurantId: string | null): void {
  _last = r;
  _restaurantIdUsed = restaurantId;
}

export function readLastBootstrap(): RunBootstrapResult | null {
  return _last;
}

export function readLastBootstrapRestaurantId(): string | null {
  return _restaurantIdUsed;
}
