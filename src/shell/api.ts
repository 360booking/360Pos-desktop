/**
 * Etapa 5 — typed wrappers over the desktop shell's native commands, used
 * by the local pages (station setup, offline till, fiscal window).
 *
 * App commands (`shell_*`, `fiscal_*`) are reachable only from bundled
 * pages; the `desktop` plugin commands are shared with the remote web POS
 * (which reaches them through `window.desktopBridge`, see
 * src-tauri/src/shell/bridge.js).
 */
import { invoke } from '@tauri-apps/api/core';

export interface ShellConfig {
  mode: 'web' | 'legacy';
  tenantUrl: string;
  posPath: string;
  kiosk: boolean;
  /** Set by the shell once the kiosk mode was chosen on this station. */
  kioskChosen?: boolean;
  autostart: boolean;
  /** Always 'auto': the integrated fiscal agent is the only one. */
  fiscalAgent: 'auto';
  offlineDefaultVat: number;
  offlineAllowSimulator: boolean;
}

export interface ShellState {
  config: ShellConfig;
  posUrl: string | null;
  online: boolean;
  kiosk: boolean;
  version: string;
  dataDir: string | null;
}

export interface FiscalHealth {
  monitored: boolean;
  provider: string;
  port: string | null;
  portPresent: boolean | null;
  online: boolean | null;
  paperOk: boolean | null;
  lastOkAt: number | null;
  lastCheckAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface AgentSummary {
  hasSavedCredentials: boolean;
  running: boolean;
  connected: boolean;
  bridgeId: string | null;
  lastError: string | null;
}

export interface JournalCounts {
  pendingSync: number;
  needsReview: number;
  unknownPrints: number;
  cachedOrders: number;
  lastCachedAt: string | null;
}

export interface BridgeInfo {
  version: string;
  mode: string;
  tenantUrl: string | null;
  posUrl: string | null;
  online: boolean;
  onlineChangedAt: number;
  kiosk: boolean;
  defaultVat: number;
  journal: JournalCounts;
  fiscal: FiscalHealth;
  agent: AgentSummary;
}

export interface CachedItem {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  vatRate?: number | null;
}

export interface CachedOrder {
  id: string;
  tableLabel: string | null;
  waiterName: string | null;
  status: string | null;
  paymentStatus: string | null;
  currency: string;
  subtotal: number;
  discountTotal: number;
  tipTotal: number;
  total: number;
  paidTotal: number;
  itemsSignature: string | null;
  updatedAt: string | null;
  items: CachedItem[];
  cachedAt: string | null;
  offlineBlockReason: string | null;
}

export type FiscalStatus = 'printing' | 'printed' | 'failed' | 'unknown';
export type SyncStatus = 'not_ready' | 'pending' | 'synced' | 'conflict';

export interface JournalEntry {
  id: string;
  mutationId: string;
  orderId: string;
  tableLabel: string | null;
  method: string;
  amount: number;
  currency: string;
  orderTotal: number;
  items: CachedItem[] | null;
  customerCif: string | null;
  provider: string | null;
  fiscalStatus: FiscalStatus;
  fiscalNumber: string | null;
  fiscalDate: string | null;
  fiscalError: string | null;
  syncStatus: SyncStatus;
  syncAttempts: number;
  lastSyncError: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
}

const plugin = <T>(cmd: string, args?: Record<string, unknown>) =>
  invoke<T>(`plugin:desktop|${cmd}`, args);

export const shellApi = {
  getConfig: () => invoke<ShellState>('shell_get_config'),
  setConfig: (config: ShellConfig) => invoke<ShellState>('shell_set_config', { config }),
  testTenant: (tenantUrl: string) => invoke<string>('shell_test_tenant', { tenantUrl }),
  openPos: () => invoke<void>('shell_open_pos'),
  openOffline: () => invoke<void>('shell_open_offline'),
  openFiscalSettings: () => invoke<void>('shell_open_fiscal_settings'),
  setKiosk: (on: boolean) => invoke<boolean>('shell_set_kiosk', { on }),
  quit: () => invoke<void>('shell_quit'),
  fiscalHealth: () => invoke<{ printer: FiscalHealth; agent: AgentSummary }>('shell_fiscal_health'),
  fiscalReconnect: () => invoke<{ printer: FiscalHealth; agent: AgentSummary }>('shell_fiscal_reconnect'),
  printXReport: () =>
    invoke<{ status: string; fiscal_number: string | null; error_message: string | null }>('fiscal_print_x_report'),
};

export const offlineApi = {
  info: () => plugin<BridgeInfo>('bridge_info'),
  listOrders: () => plugin<CachedOrder[]>('offline_list_orders'),
  closeOrder: (request: { orderId: string; mutationId: string; method: 'cash' | 'card'; customerCif?: string | null }) =>
    plugin<JournalEntry>('offline_close_order', { request }),
  journal: (limit = 200) => plugin<JournalEntry[]>('offline_journal', { limit }),
  markReviewed: (id: string) => plugin<JournalEntry>('offline_mark_reviewed', { id }),
  requeue: (id: string) => plugin<JournalEntry>('offline_requeue', { id }),
  resolveUnknown: (id: string, printed: boolean, fiscalNumber?: string | null) =>
    plugin<JournalEntry>('offline_resolve_unknown', { id, printed, fiscalNumber: fiscalNumber ?? null }),
};

export function newMutationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function lei(n: number, currency = 'RON'): string {
  try {
    return new Intl.NumberFormat('ro-RO', { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export function errText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}
