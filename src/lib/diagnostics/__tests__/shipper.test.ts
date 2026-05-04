import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sprint 11.5 — shipper reads from the in-memory ring buffer ONLY.
// It must never touch device_logs or any SQLite table; the only
// remote side-effect is the manual POST /api/pos/diagnostics/dump.

vi.mock('@/lib/auth/storage', () => ({
  getDeviceId: vi.fn(async () => 'POS-test'),
}));

vi.mock('@/lib/api/diagnostics', () => ({
  postDiagnosticsDump: vi.fn(async (body: { logs: unknown[] }) => ({ accepted: body.logs.length })),
}));

beforeEach(async () => {
  vi.resetModules();
  // Sprint 11.10 — exportLogsAsText / flushNow / readPendingDumpCount
  // now merge the debugLog ring buffer with logger._entries so the user
  // gets the warn/info lines that were previously stranded in the
  // separate logger ring. Reset both buffers between tests.
  const debugLog = await import('@/lib/debugLog');
  debugLog.clearRingBuffer();
  const logger = await import('@/lib/logger');
  logger.clearLogEntries();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shipper (Sprint 11.5 RAM-only)', () => {
  it('flushNow returns 0 attempted when ring is empty', async () => {
    const { flushNow } = await import('../shipper');
    const out = await flushNow();
    expect(out.attempted).toBe(0);
    expect(out.shipped).toBe(0);
    expect(out.errored).toBe(false);
  });

  it('flushNow ships ring buffer entries and clears it', async () => {
    const debugLog = await import('@/lib/debugLog');
    const logger = await import('@/lib/logger');
    await debugLog.setDebugEnabled(true);
    // setDebugEnabled may swallow an initDb failure into logger.warn
    // in the test sandbox; reset the logger ring after setup so we
    // count only the test inputs below.
    logger.clearLogEntries();
    debugLog.dbg('test', 'a');
    debugLog.dbg('test', 'b');
    debugLog.dbg('test', 'c');
    expect(debugLog.readRingBufferCount()).toBe(3);
    const { flushNow } = await import('../shipper');
    const out = await flushNow('1.0.0');
    expect(out.attempted).toBe(3);
    expect(out.shipped).toBe(3);
    expect(out.errored).toBe(false);
    expect(debugLog.readRingBufferCount()).toBe(0);
  });

  it('readPendingDumpCount mirrors ring buffer size', async () => {
    const debugLog = await import('@/lib/debugLog');
    const logger = await import('@/lib/logger');
    await debugLog.setDebugEnabled(true);
    logger.clearLogEntries();
    debugLog.dbg('test', 'x');
    debugLog.dbg('test', 'y');
    const { readPendingDumpCount } = await import('../shipper');
    expect(readPendingDumpCount()).toBe(2);
  });

  it('errored=true on backend failure leaves the ring untouched', async () => {
    const debugLog = await import('@/lib/debugLog');
    await debugLog.setDebugEnabled(true);
    debugLog.dbg('test', 'x');
    const { postDiagnosticsDump } = await import('@/lib/api/diagnostics');
    (postDiagnosticsDump as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('500'));
    const { flushNow } = await import('../shipper');
    const out = await flushNow();
    expect(out.errored).toBe(true);
    expect(out.shipped).toBe(0);
    expect(debugLog.readRingBufferCount()).toBe(1);
  });

  it('exportLogsAsText produces a paste-friendly multiline string', async () => {
    const debugLog = await import('@/lib/debugLog');
    const logger = await import('@/lib/logger');
    await debugLog.setDebugEnabled(true);
    logger.clearLogEntries();
    debugLog.dbg('runAction', 'newOrder', { tableId: 't-1' });
    debugLog.dbgError('persist', 'boom');
    const { exportLogsAsText } = await import('../shipper');
    const text = exportLogsAsText();
    expect(text).toContain('runAction: newOrder');
    expect(text).toContain('persist: boom');
    expect(text.split('\n').length).toBe(2);
  });

  it('exportLogsAsText also includes logger.warn lines (live tail UI)', async () => {
    // The bug we are fixing: warn / info lines emitted via logger.* (the
    // ones the user sees in the in-app live tail and that contain timeout
    // / sqlite-locked diagnostics) used to be invisible to Copy / Export.
    const debugLog = await import('@/lib/debugLog');
    const logger = await import('@/lib/logger');
    await debugLog.setDebugEnabled(true);
    logger.clearLogEntries();
    logger.logger.warn('http', 'health probe failed', { url: '/api/pos/health' });
    debugLog.dbg('runAction', 'addItem');
    const { exportLogsAsText, readPendingDumpCount } = await import('../shipper');
    const text = exportLogsAsText();
    expect(text).toContain('http: health probe failed');
    expect(text).toContain('runAction: addItem');
    expect(readPendingDumpCount()).toBe(2);
  });

  it('startShipper / stopShipper are no-ops in 11.5 (no auto-ship)', async () => {
    const { startShipper, stopShipper, isShipperRunning } = await import('../shipper');
    const stop = startShipper(1_000);
    expect(isShipperRunning()).toBe(false);
    stop();
    stopShipper();
  });
});
