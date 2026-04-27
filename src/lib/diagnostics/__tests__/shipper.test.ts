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

beforeEach(() => {
  vi.resetModules();
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
    await debugLog.setDebugEnabled(true);
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
    await debugLog.setDebugEnabled(true);
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
    await debugLog.setDebugEnabled(true);
    debugLog.dbg('runAction', 'newOrder', { tableId: 't-1' });
    debugLog.dbgError('persist', 'boom');
    const { exportLogsAsText } = await import('../shipper');
    const text = exportLogsAsText();
    expect(text).toContain('runAction: newOrder');
    expect(text).toContain('persist: boom');
    expect(text.split('\n').length).toBe(2);
  });

  it('startShipper / stopShipper are no-ops in 11.5 (no auto-ship)', async () => {
    const { startShipper, stopShipper, isShipperRunning } = await import('../shipper');
    const stop = startShipper(1_000);
    expect(isShipperRunning()).toBe(false);
    stop();
    stopShipper();
  });
});
