import { useEffect } from 'react';
import { useDeviceStatus } from '@/store/deviceStatus';
import { health } from '@/lib/api/client';
import { fiscalBridgeStatus } from '@/lib/sidecar';
import { getDb } from '@/lib/db';
import { getFiscal, getPayment, getPrinter, configureAdapters } from '@/adapters';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';

const HEALTH_INTERVAL_MS = 15_000;
const STATUS_INTERVAL_MS = 20_000;

/**
 * Polls backend + adapter status into the device-status store. The status
 * bar reads from that store; this hook is the only producer.
 */
export function useDeviceStatusBootstrap(): void {
  const setBackend = useDeviceStatus((s) => s.setBackend);
  const setDb = useDeviceStatus((s) => s.setDb);
  const setFiscal = useDeviceStatus((s) => s.setFiscal);
  const setPayment = useDeviceStatus((s) => s.setPayment);
  const setPrinter = useDeviceStatus((s) => s.setPrinter);
  const setOnline = useDeviceStatus((s) => s.setOnline);

  useEffect(() => {
    configureAdapters(getConfig());
  }, []);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [setOnline]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const r = await health();
      if (cancelled) return;
      setBackend(r.ok ? 'ok' : 'error', r.latencyMs);
    };
    tick();
    const id = setInterval(tick, HEALTH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [setBackend]);

  useEffect(() => {
    let cancelled = false;
    getDb()
      .then(() => !cancelled && setDb('ok'))
      .catch((err) => {
        if (cancelled) return;
        setDb('error');
        logger.warn('db', 'open failed', { err: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [setDb]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [f, p, pr, sb] = await Promise.all([
          getFiscal().status(),
          getPayment().status(),
          getPrinter().status(),
          fiscalBridgeStatus().catch(() => ({ present: false, path: null })),
        ]);
        if (cancelled) return;
        setFiscal(f.ready && f.online && f.paperOk ? 'ok' : 'warn');
        setPayment(p.ready && p.online ? 'ok' : 'warn');
        setPrinter(pr.online && pr.paperOk && pr.coverClosed ? 'ok' : 'warn');
        if (!sb.present) {
          // sidecar absent is just info in Sprint 0 (sim mode is fine)
          logger.debug('sidecar', 'fiscal-bridge sidecar not installed');
        }
      } catch (err) {
        if (cancelled) return;
        setFiscal('error');
        setPayment('error');
        setPrinter('error');
        logger.warn('adapters', 'status poll failed', { err: String(err) });
      }
    };
    tick();
    const id = setInterval(tick, STATUS_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [setFiscal, setPayment, setPrinter]);
}
