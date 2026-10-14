/**
 * 2026-10-14: inside the desktop app `getFiscal()` is the Rust adapter — the
 * JS simulator (which answered "printed" without any register) is only for
 * the browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('getFiscal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('is the Rust adapter inside Tauri', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const { getFiscal } = await import('@/adapters');
    const { RustFiscalAdapter } = await import('@/adapters/fiscal/rust');
    expect(getFiscal()).toBeInstanceOf(RustFiscalAdapter);
  });

  it('enableRustFiscalIfAllowed never falls back to the simulator inside Tauri', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const mod = await import('@/adapters');
    expect(await mod.enableRustFiscalIfAllowed()).toBe(true);
    const { RustFiscalAdapter } = await import('@/adapters/fiscal/rust');
    expect(mod.getFiscal()).toBeInstanceOf(RustFiscalAdapter);
  });

  it('stays the JS simulator in a plain browser', async () => {
    const { getFiscal } = await import('@/adapters');
    const { SimulatorFiscalAdapter } = await import('@/adapters/fiscal/simulator');
    expect(getFiscal()).toBeInstanceOf(SimulatorFiscalAdapter);
  });
});
