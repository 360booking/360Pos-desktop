import { describe, expect, it, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
const dbExecuteMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@/lib/db', () => ({
  getDb: async () => ({ execute: (...args: unknown[]) => dbExecuteMock(...args) }),
}));

import {
  getFiscalRuntimeConfig,
  setFiscalRuntimeConfig,
  listSerialPorts,
  type FiscalRuntimeConfig,
} from '../runtime-config';

beforeEach(() => {
  invokeMock.mockReset();
  dbExecuteMock.mockReset();
});

const ROW: FiscalRuntimeConfig = {
  provider: 'datecs_dp25',
  serial_port: 'COM3',
  baud: 9600,
  protocol_variant: 'fp55',
  operator: '1',
  operator_password: '0001',
  printer_model: 'Datecs DP-25',
  use_rust: true,
  enable_raw_logs: false,
  vat_map_json: null,
  cmd_codes_json: null,
};

describe('runtime-config facade', () => {
  it('forwards getFiscalRuntimeConfig to fiscal_get_runtime_config', async () => {
    invokeMock.mockResolvedValueOnce(ROW);
    const got = await getFiscalRuntimeConfig();
    expect(invokeMock).toHaveBeenCalledWith('fiscal_get_runtime_config');
    expect(got).toEqual(ROW);
  });

  it('setFiscalRuntimeConfig writes through the shared sqlx pool, then re-reads via the Rust command', async () => {
    invokeMock.mockResolvedValueOnce(ROW);
    const back = await setFiscalRuntimeConfig(ROW);

    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    const [sql, params] = dbExecuteMock.mock.calls[0];
    expect(String(sql)).toMatch(/INSERT INTO fiscal_runtime_config/);
    expect(String(sql)).toMatch(/ON CONFLICT\(id\) DO UPDATE SET/);
    expect(params).toEqual([
      'datecs_dp25',
      'COM3',
      9600,
      'fp55',
      '1',
      '0001',
      'Datecs DP-25',
      1,
      0,
      null,
      null,
    ]);

    expect(invokeMock).toHaveBeenCalledWith('fiscal_get_runtime_config');
    expect(back).toEqual(ROW);
  });

  it('booleans serialize to 1/0 (true/false) and stay null when null', async () => {
    invokeMock.mockResolvedValueOnce({ ...ROW, use_rust: false, enable_raw_logs: null });
    await setFiscalRuntimeConfig({ ...ROW, use_rust: false, enable_raw_logs: null });
    const [, params] = dbExecuteMock.mock.calls[0];
    expect(params[7]).toBe(0);    // use_rust = false
    expect(params[8]).toBe(null); // enable_raw_logs = null
  });

  it('listSerialPorts forwards to fiscal_list_ports', async () => {
    invokeMock.mockResolvedValueOnce(['COM1', 'COM3', 'COM7']);
    const ports = await listSerialPorts();
    expect(invokeMock).toHaveBeenCalledWith('fiscal_list_ports');
    expect(ports).toEqual(['COM1', 'COM3', 'COM7']);
  });
});
