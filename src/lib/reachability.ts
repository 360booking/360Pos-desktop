/**
 * Reachability detector for the POS desktop.
 *
 * Faza 2 — drives the online-first UI. The desktop is "online" when the
 * backend is reachable; "offline" when 2+ consecutive REST/pull calls
 * fail with a connectivity error (network, timeout, 5xx). Any single
 * successful REST/pull response flips us back online and resets the
 * failure counter.
 *
 * We DO NOT count 4xx responses as connectivity failures — those are
 * business errors (cancelled order, validation, auth). Likewise 401
 * goes through the refresh interceptor; reachability sees the eventual
 * outcome, not the intermediate retry.
 *
 * Consumers:
 *   - `useReachability()` — React hook returning the live boolean.
 *   - `getReachability()` — sync read for non-React code (workers,
 *     schedulers, axios interceptors that need to gate a request).
 *   - `recordSuccess()` / `recordFailure(error)` — wired into the axios
 *     response interceptor so every REST call feeds the detector
 *     transparently. Schedulers (pull, heartbeat) also call into this.
 *
 * The detector mirrors its state into `useDeviceStatus.online` so the
 * existing StatusBar pill and the hundred other UI bits that read that
 * field keep working without changes.
 */

import axios from 'axios';
import { useSyncExternalStore } from 'react';

import { useDeviceStatus } from '@/store/deviceStatus';

const FAILURES_TO_OFFLINE = 2;

interface ReachabilityState {
  online: boolean;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

let _state: ReachabilityState = {
  // Optimistic start: we haven't proven the backend is offline, so don't
  // pessimistically block actions on first frame. The first failed call
  // will flip this within a couple of seconds anyway.
  online: true,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
};

const _subscribers = new Set<() => void>();

function _notify() {
  // Mirror to the device-status store so existing UI (StatusBar, etc.)
  // sees the same boolean.
  useDeviceStatus.getState().setOnline(_state.online);
  for (const cb of _subscribers) {
    try {
      cb();
    } catch {
      /* never let a bad subscriber break the others */
    }
  }
}

export function getReachability(): ReachabilityState {
  return _state;
}

export function isReachable(): boolean {
  return _state.online;
}

export function recordSuccess(): void {
  // Even one successful round-trip is proof of life. Don't churn the
  // store if nothing observable changed.
  const wasOffline = !_state.online;
  if (!wasOffline && _state.consecutiveFailures === 0) {
    _state = { ..._state, lastSuccessAt: new Date().toISOString() };
    return;
  }
  _state = {
    ..._state,
    online: true,
    consecutiveFailures: 0,
    lastSuccessAt: new Date().toISOString(),
    lastError: null,
  };
  _notify();
}

/**
 * Classify an axios error to decide whether it counts as a connectivity
 * failure. We only flip offline on transport-class problems; HTTP 4xx
 * means the server is up and rejecting our request for business reasons.
 */
function isConnectivityError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    // Non-axios errors that bubble up here are programming bugs, not
    // connectivity. Don't pessimistically flip offline on them.
    return false;
  }
  if (err.code === 'ECONNABORTED') return true; // timeout
  if (err.response) {
    // Server responded → connectivity is fine; only 5xx counts (server
    // unhealthy is morally similar to "can't talk to it") but pure 5xx
    // can also be a transient deploy. We treat 5xx as connectivity for
    // the purposes of the offline banner; 4xx never.
    return err.response.status >= 500;
  }
  // No response object → the request never made it (network/CORS).
  return true;
}

export function recordFailure(err?: unknown): void {
  if (err !== undefined && !isConnectivityError(err)) {
    // Not a transport failure — leave reachability alone.
    return;
  }
  const next = _state.consecutiveFailures + 1;
  const detail =
    axios.isAxiosError(err) ? err.message : err !== undefined ? String(err) : null;
  const wasOnline = _state.online;
  _state = {
    ..._state,
    consecutiveFailures: next,
    online: next < FAILURES_TO_OFFLINE ? _state.online : false,
    lastFailureAt: new Date().toISOString(),
    lastError: detail,
  };
  if (wasOnline !== _state.online || next === FAILURES_TO_OFFLINE) {
    _notify();
  }
}

/** Test seam — reset the detector between unit tests. */
export function _resetReachabilityForTests(): void {
  _state = {
    online: true,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };
  _notify();
}

function subscribe(cb: () => void): () => void {
  _subscribers.add(cb);
  return () => {
    _subscribers.delete(cb);
  };
}

/**
 * React hook. Re-renders when the online flag or the failure counter
 * flips. Schedulers and other non-React callers should use
 * `isReachable()` / `getReachability()` instead.
 */
export function useReachability(): {
  online: boolean;
  consecutiveFailures: number;
  lastError: string | null;
} {
  const snap = useSyncExternalStore(
    subscribe,
    () => _state,
    () => _state,
  );
  return {
    online: snap.online,
    consecutiveFailures: snap.consecutiveFailures,
    lastError: snap.lastError,
  };
}
