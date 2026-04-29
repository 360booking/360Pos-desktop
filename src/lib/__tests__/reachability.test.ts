/**
 * Tests for the reachability detector.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AxiosError } from 'axios';

import {
  _resetReachabilityForTests,
  getReachability,
  isReachable,
  recordFailure,
  recordSuccess,
} from '../reachability';

beforeEach(() => {
  _resetReachabilityForTests();
});

afterEach(() => {
  _resetReachabilityForTests();
});

function networkErr(): AxiosError {
  return new AxiosError('Network Error', 'ERR_NETWORK', undefined, {});
}

function http500(): AxiosError {
  const err = new AxiosError('Server Error', '500');
  // Cast the response onto the axios error in the same shape axios uses.
  (err as unknown as { response: { status: number } }).response = { status: 500 };
  return err;
}

function http400(): AxiosError {
  const err = new AxiosError('Bad Request', '400');
  (err as unknown as { response: { status: number } }).response = { status: 400 };
  return err;
}

describe('reachability', () => {
  it('starts online by default', () => {
    expect(isReachable()).toBe(true);
  });

  it('flips offline after 2 consecutive connectivity failures', () => {
    recordFailure(networkErr());
    expect(isReachable()).toBe(true); // 1/2 — still online
    recordFailure(networkErr());
    expect(isReachable()).toBe(false); // 2/2 — offline
  });

  it('any successful round-trip flips back online + resets the counter', () => {
    recordFailure(networkErr());
    recordFailure(networkErr());
    expect(isReachable()).toBe(false);
    recordSuccess();
    expect(isReachable()).toBe(true);
    expect(getReachability().consecutiveFailures).toBe(0);
  });

  it('5xx is treated as a connectivity failure', () => {
    recordFailure(http500());
    recordFailure(http500());
    expect(isReachable()).toBe(false);
  });

  it('4xx is NOT a connectivity failure — business errors do not flip us offline', () => {
    recordFailure(http400());
    recordFailure(http400());
    recordFailure(http400());
    expect(isReachable()).toBe(true);
    expect(getReachability().consecutiveFailures).toBe(0);
  });
});
