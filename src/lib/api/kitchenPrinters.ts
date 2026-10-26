/**
 * Client for /api/restaurant/printers/* — same shape as the web admin UI.
 *
 * Used by the desktop Settings → Imprimante tab to read/write the
 * tenant-wide printer config and to surface failed jobs in the alert
 * banner. All calls reuse the bearer-auth axios instance, so a desktop
 * pos_device token works after the auth alias fix lands on backend.
 */
import type { AxiosError } from 'axios';

import { getApiClient } from './client';

export interface KitchenPrinter {
  id?: string;
  name: string;
  station: string;
  host: string;
  port: number;
  paper_width_chars: number;
  enabled: boolean;
}

export interface KitchenPrinterJob {
  id: string;
  orderId: string | null;
  ticketId: string | null;
  station: string | null;
  printerHost: string | null;
  status: 'ok' | 'failed' | 'no_printer' | 'pending' | 'printing' | 'skipped';
  error: string | null;
  attempts: number;
  createdAt: string | null;
  acknowledgedAt: string | null;
}

/** Postul de bucătărie (backend: services/posturi_bucatarie.py). */
export interface KitchenStation {
  key: string;
  name: string;
  mode?: 'kds' | 'imprimanta' | 'ambele';
}

/** Postul unei imprimante: valorile vechi (kitchen / pizza) se citesc ca
 *  Bucătărie / Pizzerie — ca pe server (`kitchen_printer.post_imprimanta`). */
export function printerStationKey(v: string | null | undefined): string {
  const k = String(v || '').trim().toLowerCase();
  if (k === '' || k === 'kitchen') return 'bucatarie';
  if (k === 'pizza') return 'pizzerie';
  return k;
}

export type KitchenStationMode = NonNullable<KitchenStation['mode']>;

/** Alegerea simplă „Cum ajung comenzile la bucătărie” (2026-10-26): modul
 *  comun al tuturor posturilor sau „diferit” când posturile au moduri
 *  diferite. Lipsa modului = „kds”, ca pe server. */
export function modulBucatariei(
  stations: readonly Pick<KitchenStation, 'mode'>[],
): KitchenStationMode | 'diferit' {
  const moduri = stations.map((s) => s.mode || 'kds');
  if (moduri.length === 0) return 'kds';
  return moduri.every((m) => m === moduri[0]) ? moduri[0] : 'diferit';
}

/** Etichetele și explicațiile — aceleași ca în admin. */
export const MODURI_BUCATARIE: Array<{ v: KitchenStationMode; label: string; explicatie: string }> = [
  { v: 'kds', label: 'Doar KDS', explicatie: 'Comanda apare pe ecranul bucătăriei.' },
  { v: 'imprimanta', label: 'Doar imprimantă', explicatie: 'Se tipărește bonul la imprimanta postului.' },
  { v: 'ambele', label: 'KDS și imprimantă', explicatie: 'Pe ecran și pe hârtie.' },
];

export interface JobsResponse {
  jobs: KitchenPrinterJob[];
  failedUnacknowledged: number;
}

function wrap(err: unknown): Error {
  const ax = err as AxiosError<{ detail?: unknown }>;
  const data = ax.response?.data ?? null;
  const detail =
    data && typeof data === 'object' && 'detail' in data
      ? (data as { detail?: unknown }).detail
      : data;
  const msg = typeof detail === 'string' ? detail : ax.message;
  return new Error(msg);
}

export const kitchenPrintersApi = {
  list: async (): Promise<KitchenPrinter[]> => {
    try {
      const res = await getApiClient().get<{ printers: KitchenPrinter[] }>(
        '/api/restaurant/printers',
      );
      return res.data?.printers ?? [];
    } catch (err) {
      throw wrap(err);
    }
  },

  /** Posturile restaurantului — stația imprimantei se alege din ele.
   *  Atenție: ruta cere token de personal; cu tokenul aplicației (pos_device)
   *  serverul răspunde 401, deci apelantul trebuie să aibă o variantă de
   *  rezervă. Modul posturilor se schimbă doar din admin. */
  stations: async (): Promise<KitchenStation[]> => {
    try {
      const res = await getApiClient().get<{ stations: KitchenStation[] }>(
        '/api/restaurant/kitchen-stations',
      );
      return res.data?.stations ?? [];
    } catch (err) {
      throw wrap(err);
    }
  },

  replace: async (printers: KitchenPrinter[]): Promise<KitchenPrinter[]> => {
    try {
      const res = await getApiClient().put<{ printers: KitchenPrinter[] }>(
        '/api/restaurant/printers',
        { printers },
      );
      return res.data?.printers ?? [];
    } catch (err) {
      throw wrap(err);
    }
  },

  /** Server-side test print (backend opens the TCP socket). Useful when
   *  the printer is on the server's LAN, not the desktop's. */
  testServerSide: async (
    host: string,
    port: number,
    paperWidth: number,
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await getApiClient().post<{ ok: boolean; error?: string }>(
        '/api/restaurant/printers/test',
        { host, port, paper_width_chars: paperWidth },
      );
      return res.data;
    } catch (err) {
      throw wrap(err);
    }
  },

  jobs: async (params?: { status?: string; limit?: number }): Promise<JobsResponse> => {
    try {
      const qs = new URLSearchParams();
      if (params?.status) qs.set('status', params.status);
      if (params?.limit) qs.set('limit', String(params.limit));
      const res = await getApiClient().get<JobsResponse>(
        `/api/restaurant/printers/jobs${qs.toString() ? `?${qs}` : ''}`,
      );
      return res.data;
    } catch (err) {
      throw wrap(err);
    }
  },

  retryJob: async (jobId: string): Promise<void> => {
    try {
      await getApiClient().post(`/api/restaurant/printers/jobs/${jobId}/retry`);
    } catch (err) {
      throw wrap(err);
    }
  },

  ackAll: async (): Promise<void> => {
    try {
      await getApiClient().post('/api/restaurant/printers/jobs/ack-all');
    } catch (err) {
      throw wrap(err);
    }
  },
};
