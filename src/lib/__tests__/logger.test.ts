import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLogEntries,
  getRecentLogEntries,
  logger,
  subscribeLogs,
} from '../logger';

beforeEach(() => {
  clearLogEntries();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger ring buffer', () => {
  it('appends entries with the right level + source + message', () => {
    logger.info('fiscal-setup', 'save requested', { provider: 'datecs_dp25' });
    logger.warn('sync', 'something off', { detail: 'x' });
    logger.error('adapters', 'boom');

    const e = getRecentLogEntries();
    expect(e).toHaveLength(3);
    expect(e[0].level).toBe('info');
    expect(e[0].source).toBe('fiscal-setup');
    expect(e[0].message).toBe('save requested');
    expect(e[0].ctx).toEqual({ provider: 'datecs_dp25' });
    expect(e[2].level).toBe('error');
  });

  it('caps at 500 entries (oldest dropped first)', () => {
    for (let i = 0; i < 600; i += 1) {
      logger.debug('test', `msg-${i}`);
    }
    const e = getRecentLogEntries();
    expect(e).toHaveLength(500);
    expect(e[0].message).toBe('msg-100');
    expect(e[e.length - 1].message).toBe('msg-599');
  });

  it('honors the limit argument', () => {
    for (let i = 0; i < 10; i += 1) {
      logger.info('t', `m-${i}`);
    }
    const tail = getRecentLogEntries(3);
    expect(tail).toHaveLength(3);
    expect(tail.map((e) => e.message)).toEqual(['m-7', 'm-8', 'm-9']);
  });

  it('notifies subscribers on each emit', () => {
    const fn = vi.fn();
    const unsub = subscribeLogs(fn);
    logger.info('t', 'a');
    logger.warn('t', 'b');
    expect(fn).toHaveBeenCalledTimes(2);
    unsub();
    logger.info('t', 'c');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clear empties the buffer + notifies subscribers', () => {
    logger.info('t', 'x');
    const fn = vi.fn();
    const unsub = subscribeLogs(fn);
    clearLogEntries();
    expect(getRecentLogEntries()).toHaveLength(0);
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('still writes to console (does not break existing dev workflow)', () => {
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.info('t', 'msg', { k: 1 });
    expect(spyInfo).toHaveBeenCalledWith('[info] t: msg', { k: 1 });
  });

  it('subscriber error does not stop other subscribers from being called', () => {
    const a = vi.fn(() => { throw new Error('a-fail'); });
    const b = vi.fn();
    subscribeLogs(a);
    subscribeLogs(b);
    logger.info('t', 'x');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
