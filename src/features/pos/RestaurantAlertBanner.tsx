/**
 * Banner unificat pentru alerte POS desktop — comenzi noi din QR/online
 * și cereri de chelner. Mirror al componentei web cu plus-uri specifice
 * desktop-ului:
 *   - Tauri requestUserAttention (flash în taskbar) când fereastra nu
 *     e în focus, ca cineva care trece pe lângă POS să observe imediat.
 *   - Mute toggle persistent în localStorage la fel ca web.
 *   - Pollează la 8s independent de /sync/pull pentru ca staff-ul să
 *     vadă semnalul fără ca rest-ul cache-ului să fi ajuns încă.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellRing, Check, Volume2, VolumeX, X, XCircle } from 'lucide-react';

import {
  restaurantAlertsApi,
  type PendingApprovalOrder,
  type WaiterCall,
} from '@/lib/api/restaurantAlerts';
import { logger } from '@/lib/logger';

const POLL_INTERVAL_MS = 8_000;
const SOUND_INTERVAL_MS = 8_000;
const MUTE_STORAGE_KEY = 'pos_desktop_alerts_muted_v1';

const REASON_LABEL: Record<string, string> = {
  assistance: 'asistență',
  bill: 'nota',
  water: 'apă',
  order: 'comandă',
  other: 'altceva',
};

type Alert =
  | { kind: 'order'; key: string; order: PendingApprovalOrder }
  | { kind: 'waiter'; key: string; call: WaiterCall };

function loadMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted(muted: boolean) {
  try {
    if (muted) window.localStorage.setItem(MUTE_STORAGE_KEY, '1');
    else window.localStorage.removeItem(MUTE_STORAGE_KEY);
  } catch {
    // localStorage unavailable; non-fatal.
  }
}

function makeBeeper() {
  let ctx: AudioContext | null = null;
  const ensureContext = () => {
    if (ctx) return ctx;
    const W = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = W.AudioContext || W.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  };
  return (variant: 'order' | 'waiter') => {
    const c = ensureContext();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => undefined);
    const now = c.currentTime;
    const notes = variant === 'order' ? [784, 1047] : [880];
    const dur = variant === 'order' ? 0.18 : 0.4;
    notes.forEach((freq, i) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = variant === 'order' ? 'sine' : 'square';
      osc.frequency.value = freq;
      const start = now + i * (dur + 0.05);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    });
  };
}

/** Cere atenția OS-ului pe taskbar (flash icon) când banner-ul are
 *  alerte necitite și fereastra POS nu e în focus. Best-effort: dacă
 *  nu suntem în Tauri sau permisiunea lipsește, ignorăm tăcut.
 *  Fallback graceful — nu blocăm banner-ul vizual dacă acest call eșuează. */
async function flashTaskbar() {
  try {
    const mod = await import('@tauri-apps/api/window');
    const current = mod.getCurrentWindow();
    const focused = await current.isFocused();
    if (focused) return;
    // UserAttentionType.Critical = icon-ul taskbar-ului flash-uiește
    // până când utilizatorul focusează fereastra. Exact comportament
    // ce vrem pentru o comandă necitită.
    await current.requestUserAttention(mod.UserAttentionType.Critical);
  } catch (err) {
    logger.warn('alerts', 'taskbar flash failed', { err: String(err) });
  }
}

export default function RestaurantAlertBanner() {
  const [pendingOrders, setPendingOrders] = useState<PendingApprovalOrder[]>([]);
  const [waiterCalls, setWaiterCalls] = useState<WaiterCall[]>([]);
  const [muted, setMuted] = useState<boolean>(() => loadMuted());
  const [openAlertKey, setOpenAlertKey] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const beeperRef = useRef<ReturnType<typeof makeBeeper> | null>(null);
  const seenKeysRef = useRef<Set<string>>(new Set());
  const lastBeepRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    try {
      const [orders, calls] = await Promise.all([
        restaurantAlertsApi.listPendingApproval(),
        restaurantAlertsApi.listWaiterCalls(false),
      ]);
      setPendingOrders(orders);
      setWaiterCalls(calls.filter((c) => c.status !== 'closed'));
    } catch (err) {
      logger.warn('alerts', 'poll failed', { err: String(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const alerts = useMemo<Alert[]>(() => {
    const list: Alert[] = [];
    pendingOrders.forEach((o) =>
      list.push({ kind: 'order', key: `order:${o.orderId}`, order: o }),
    );
    waiterCalls.forEach((c) => list.push({ kind: 'waiter', key: `waiter:${c.id}`, call: c }));
    return list;
  }, [pendingOrders, waiterCalls]);

  const unhandled = useMemo(() => {
    return alerts.filter((a) => {
      if (a.kind === 'order') return a.order.posApprovalStatus === 'pending';
      return a.call.status === 'open';
    });
  }, [alerts]);

  useEffect(() => {
    if (!beeperRef.current) beeperRef.current = makeBeeper();
  }, []);

  // Sound + taskbar flash loop — same logic as web banner. Trigger e o
  // tranziție „a apărut ceva nou, fereastra nu e în focus".
  useEffect(() => {
    if (muted || unhandled.length === 0) {
      lastBeepRef.current = 0;
      return;
    }
    const newKeys = unhandled.filter((a) => !seenKeysRef.current.has(a.key));
    const isFirst = newKeys.length > 0;
    const now = Date.now();
    const sinceLast = now - lastBeepRef.current;
    if (isFirst || sinceLast >= SOUND_INTERVAL_MS) {
      const variant = unhandled.some((a) => a.kind === 'waiter') ? 'waiter' : 'order';
      beeperRef.current?.(variant);
      lastBeepRef.current = now;
      newKeys.forEach((a) => seenKeysRef.current.add(a.key));
      if (isFirst) void flashTaskbar();
    }
    const tid = window.setTimeout(() => {
      setMuted((m) => m); // re-trigger effect
    }, SOUND_INTERVAL_MS);
    return () => window.clearTimeout(tid);
  }, [muted, unhandled]);

  // ---------------- Actions ----------------

  const onApprove = useCallback(
    async (order: PendingApprovalOrder) => {
      setBusyAction('approve:' + order.orderId);
      setErrorMsg(null);
      try {
        await restaurantAlertsApi.approveOrder(order.orderId);
        setOpenAlertKey(null);
        await refresh();
      } catch (e: unknown) {
        const msg =
          (e as { response?: { data?: { detail?: string | { message?: string } } } })?.response
            ?.data?.detail;
        setErrorMsg(typeof msg === 'string' ? msg : msg?.message || 'Aprobarea a eșuat.');
      } finally {
        setBusyAction(null);
      }
    },
    [refresh],
  );

  const onReject = useCallback(
    async (order: PendingApprovalOrder) => {
      const reason = window.prompt('Motiv respingere (opțional):');
      if (reason === null) return;
      setBusyAction('reject:' + order.orderId);
      setErrorMsg(null);
      try {
        await restaurantAlertsApi.rejectOrder(order.orderId, reason || undefined);
        setOpenAlertKey(null);
        await refresh();
      } catch (e: unknown) {
        const msg =
          (e as { response?: { data?: { detail?: string | { message?: string } } } })?.response
            ?.data?.detail;
        setErrorMsg(typeof msg === 'string' ? msg : msg?.message || 'Respingerea a eșuat.');
      } finally {
        setBusyAction(null);
      }
    },
    [refresh],
  );

  const onAck = useCallback(
    async (call: WaiterCall) => {
      setBusyAction('ack:' + call.id);
      setErrorMsg(null);
      try {
        await restaurantAlertsApi.ackWaiterCall(call.id);
        setOpenAlertKey(null);
        await refresh();
      } catch {
        setErrorMsg('Confirmarea a eșuat.');
      } finally {
        setBusyAction(null);
      }
    },
    [refresh],
  );

  const onClose = useCallback(
    async (call: WaiterCall) => {
      setBusyAction('close:' + call.id);
      setErrorMsg(null);
      try {
        await restaurantAlertsApi.closeWaiterCall(call.id);
        setOpenAlertKey(null);
        await refresh();
      } catch {
        setErrorMsg('Închiderea a eșuat.');
      } finally {
        setBusyAction(null);
      }
    },
    [refresh],
  );

  if (alerts.length === 0) return null;

  const top = alerts[0];
  const opened = openAlertKey ? alerts.find((a) => a.key === openAlertKey) : null;

  return (
    <>
      <div
        className="relative z-30"
        aria-live="assertive"
        role="alert"
      >
        <div
          className={`flex items-center gap-3 px-5 py-3 shadow-xl border-b-4 ${
            unhandled.length > 0
              ? 'bg-rose-600 border-rose-800 text-white'
              : 'bg-amber-500 border-amber-700 text-white'
          }`}
          style={{
            animation:
              unhandled.length > 0 ? 'banner-breathe 1.4s ease-in-out infinite' : undefined,
          }}
        >
          <BellRing className="h-7 w-7 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs uppercase tracking-wide opacity-90">
              {unhandled.length > 0
                ? `${unhandled.length} ${unhandled.length === 1 ? 'alertă necitită' : 'alerte necitite'}`
                : `${alerts.length} ${alerts.length === 1 ? 'alertă' : 'alerte'} în coadă`}
            </div>
            <div className="text-lg font-bold truncate">
              {top.kind === 'order'
                ? `Masa ${top.order.tableName || '—'} • Comandă nouă ${top.order.total.toFixed(2)} ${top.order.currency}`
                : `Masa ${top.call.tableNumber || '—'} • Cere ${REASON_LABEL[top.call.reason] || top.call.reason}`}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpenAlertKey(top.key)}
            className="px-4 py-2 rounded-md bg-white/95 text-gray-900 font-semibold text-sm hover:bg-white shadow"
          >
            Vezi
          </button>
          {alerts.length > 1 && (
            <button
              type="button"
              onClick={() => setOpenAlertKey('__all__')}
              className="px-3 py-2 rounded-md bg-white/20 text-white font-semibold text-sm hover:bg-white/30"
            >
              +{alerts.length - 1}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              const next = !muted;
              setMuted(next);
              saveMuted(next);
            }}
            className="p-2 rounded-md bg-white/20 hover:bg-white/30"
            title={muted ? 'Sunet oprit' : 'Sunet pornit'}
          >
            {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {opened && (
        <div
          className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4"
          onClick={() => setOpenAlertKey(null)}
        >
          <div
            className="bg-white text-gray-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <Bell className="h-5 w-5 text-rose-600" />
                {openAlertKey === '__all__'
                  ? `Alerte (${alerts.length})`
                  : opened.kind === 'order'
                    ? 'Comandă în așteptare'
                    : 'Cerere chelner'}
              </h2>
              <button
                type="button"
                onClick={() => setOpenAlertKey(null)}
                className="p-1.5 rounded hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {errorMsg && (
              <div className="mx-5 mt-4 px-3 py-2 bg-rose-50 border border-rose-200 rounded text-sm text-rose-700">
                {errorMsg}
              </div>
            )}

            <div className="p-5 space-y-4">
              {(openAlertKey === '__all__' ? alerts : [opened]).map((a) => (
                <AlertRow
                  key={a.key}
                  alert={a}
                  busyAction={busyAction}
                  onApprove={onApprove}
                  onReject={onReject}
                  onAck={onAck}
                  onClose={onClose}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes banner-breathe {
          0%, 100% { box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.6); }
          50% { box-shadow: 0 0 28px 6px rgba(244, 63, 94, 0.45); }
        }
      `}</style>
    </>
  );
}

function AlertRow({
  alert: a,
  busyAction,
  onApprove,
  onReject,
  onAck,
  onClose,
}: {
  alert: Alert;
  busyAction: string | null;
  onApprove: (o: PendingApprovalOrder) => void;
  onReject: (o: PendingApprovalOrder) => void;
  onAck: (c: WaiterCall) => void;
  onClose: (c: WaiterCall) => void;
}) {
  if (a.kind === 'order') {
    const o = a.order;
    const busyApprove = busyAction === 'approve:' + o.orderId;
    const busyReject = busyAction === 'reject:' + o.orderId;
    return (
      <div className="border rounded-lg p-4 bg-gray-50">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">
              {o.source.toUpperCase()}
            </div>
            <div className="text-base font-bold">
              Masa {o.tableName || '—'} • {o.total.toFixed(2)} {o.currency}
            </div>
            {o.customerName && (
              <div className="text-sm text-gray-700">
                {o.customerName}
                {o.customerPhone ? ` • ${o.customerPhone}` : ''}
              </div>
            )}
          </div>
          <div className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-800 font-semibold">
            {o.paymentStatus}
          </div>
        </div>
        <ul className="text-sm divide-y border rounded bg-white mb-3">
          {o.items.map((it) => (
            <li key={it.id} className="px-3 py-1.5 flex items-center justify-between">
              <span>
                {it.quantity} × {it.name}
                {it.variantLabel ? ` (${it.variantLabel})` : ''}
                {it.kitchenNotes ? <em className="ml-2 text-gray-500">— {it.kitchenNotes}</em> : null}
              </span>
              <span className="text-gray-700 tabular-nums">{it.lineTotal.toFixed(2)}</span>
            </li>
          ))}
        </ul>
        {o.notes && (
          <div className="text-sm text-gray-700 mb-3">
            <span className="font-semibold">Notă: </span>
            {o.notes}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busyApprove || busyReject}
            onClick={() => onApprove(o)}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-60"
          >
            <Check className="h-4 w-4" />
            {busyApprove ? 'Se aprobă…' : 'Aprobă & trimite la bucătărie'}
          </button>
          <button
            type="button"
            disabled={busyApprove || busyReject}
            onClick={() => onReject(o)}
            className="px-4 py-2.5 rounded-md bg-rose-600 text-white font-semibold hover:bg-rose-700 disabled:opacity-60 inline-flex items-center gap-2"
          >
            <XCircle className="h-4 w-4" />
            Respinge
          </button>
        </div>
      </div>
    );
  }

  const c = a.call;
  const busyAck = busyAction === 'ack:' + c.id;
  const busyClose = busyAction === 'close:' + c.id;
  return (
    <div className="border rounded-lg p-4 bg-gray-50">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wide">CHELNER</div>
          <div className="text-base font-bold">
            Masa {c.tableNumber || '—'} cere {REASON_LABEL[c.reason] || c.reason}
          </div>
          {c.note && <div className="text-sm text-gray-700 mt-1">{c.note}</div>}
        </div>
        <div
          className={`text-xs px-2 py-1 rounded font-semibold ${
            c.status === 'open' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'
          }`}
        >
          {c.status === 'open' ? 'NECITIT' : 'VĂZUT'}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {c.status === 'open' && (
          <button
            type="button"
            disabled={busyAck || busyClose}
            onClick={() => onAck(c)}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60"
          >
            <Check className="h-4 w-4" />
            {busyAck ? 'Se confirmă…' : 'Am văzut (notifică clientul)'}
          </button>
        )}
        <button
          type="button"
          disabled={busyAck || busyClose}
          onClick={() => onClose(c)}
          className="px-4 py-2.5 rounded-md bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-60 inline-flex items-center gap-2"
        >
          <Check className="h-4 w-4" />
          Rezolvat
        </button>
      </div>
    </div>
  );
}
