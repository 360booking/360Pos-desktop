import { describe, expect, it, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  getFiscalRuntimeConfig,
  setFiscalRuntimeConfig,
  listSerialPorts,
  type FiscalRuntimeConfig,
} from '../runtime-config';

beforeEach(() => {
  invokeMock.mockReset();
});

describe('runtime-config facade', () => {
  it('forwards getFiscalRuntimeConfig to fiscal_get_runtime_config', async () => {
    const remote: FiscalRuntimeConfig = {
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
    invokeMock.mockResolvedValueOnce(remote);
    const got = await getFiscalRuntimeConfig();
    expect(invokeMock).toHaveBeenCalledWith('fiscal_get_runtime_config');
    expect(got).toEqual(remote);
  });

  it('passes the config payload via { config } to fiscal_set_runtime_config', async () => {
    const cfg: FiscalRuntimeConfig = {
      provider: 'simulator',
      serial_port: null,
      baud: 9600,
      protocol_variant: 'fp55',
      operator: '1',
      operator_password: '0000',
      printer_model: null,
      use_rust: false,
      enable_raw_logs: false,
      vat_map_json: null,
      cmd_codes_json: null,
    };
    invokeMock.mockResolvedValueOnce(cfg);
    const back = await setFiscalRuntimeConfig(cfg);
    expect(invokeMock).toHaveBeenCalledWith('fiscal_set_runtime_config', { config: cfg });
    expect(back).toEqual(cfg);
  });

  it('listSerialPorts forwards to fiscal_list_ports and returns the array', async () => {
    invokeMock.mockResolvedValueOnce(['COM1', 'COM3', 'COM7']);
    const ports = await listSerialPorts();
    expect(invokeMock).toHaveBeenCalledWith('fiscal_list_ports');
    expect(ports).toEqual(['COM1', 'COM3', 'COM7']);
  });
});
