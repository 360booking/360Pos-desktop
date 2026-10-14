// 360booking POS desktop — bridge injected into every page of the main window
// (Etapa 5). The web POS feature-detects `window.desktopBridge`; ordinary
// browsers never have it, so the web app behaves exactly as before there.
//
// Everything goes through the `desktop` plugin commands, which are the ONLY
// native commands a remote page may call (see capabilities/remote-pos.json
// and the runtime capability added for custom tenant domains).
//
// `fiscal.link(code)` (2026-10-14): the admin page Setări → Casa de marcat
// hands a fresh enrolment code to the app. Allowed only on the configured
// tenant origin (runtime capability + origin check in the command); it
// accepts a code, never a token.
(function () {
  'use strict';
  if (window.__POS_DESKTOP_BRIDGE__) return;
  window.__POS_DESKTOP_BRIDGE__ = true;

  function internals() {
    return window.__TAURI_INTERNALS__;
  }
  function call(cmd, args) {
    var t = internals();
    if (!t || typeof t.invoke !== 'function') {
      return Promise.reject(new Error('desktop bridge indisponibil'));
    }
    return t.invoke('plugin:desktop|' + cmd, args || {});
  }

  var fiscal = Object.freeze({
    /** Opens the window „Casa de marcat” (find the register, test receipt). */
    open: function () { return call('open_fiscal_settings'); },
    /** Links the app to the restaurant with a fresh enrolment code. */
    link: function (code) { return call('fiscal_link', { code: String(code || '') }); },
  });

  var bridge = {
    version: 2,
    kind: 'pos_desktop_tauri',
    info: function () { return call('bridge_info'); },
    cacheOrders: function (payload) { return call('offline_cache_orders', { payload: payload }); },
    pendingSync: function () { return call('offline_pending_sync'); },
    markSynced: function (id, result) { return call('offline_mark_synced', { id: id, result: result }); },
    journal: function (limit) { return call('offline_journal', { limit: limit || 100 }); },
    openOfflineTill: function () { return call('open_offline_till'); },
    openFiscalSettings: function () { return call('open_fiscal_settings'); },
    openPos: function () { return call('open_pos'); },
    toggleKiosk: function () { return call('toggle_kiosk'); },
    fiscal: fiscal,
  };
  try {
    Object.defineProperty(window, 'desktopBridge', { value: Object.freeze(bridge), configurable: false });
  } catch (e) {
    window.desktopBridge = bridge;
  }

  // Only the remote web POS needs the overlay; the local pages have their
  // own UI.
  var isRemote = /^https?:$/.test(location.protocol) && !/(^|\.)tauri\.localhost$/.test(location.hostname);

  // ---------------------------------------------------------------------
  // Keyboard shortcuts (work on every page of the main window).
  //   Ctrl+Shift+F  fiscal settings window
  //   Ctrl+Shift+O  offline till
  //   Ctrl+Shift+K  kiosk (full screen) on/off
  //   F11           the same — the key everyone knows from browsers
  window.addEventListener('keydown', function (ev) {
    if (ev.key === 'F11' && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) {
      ev.preventDefault();
      if (!ev.repeat) bridge.toggleKiosk().catch(function (e) { console.warn('[desktop]', e); });
      return;
    }
    if (!ev.ctrlKey || !ev.shiftKey || ev.altKey) return;
    var k = (ev.key || '').toLowerCase();
    var run = null;
    if (k === 'f') run = bridge.openFiscalSettings;
    else if (k === 'o') run = bridge.openOfflineTill;
    else if (k === 'k') run = bridge.toggleKiosk;
    if (!run) return;
    ev.preventDefault();
    run().catch(function (e) { console.warn('[desktop]', e); });
  }, true);

  if (!isRemote) return;

  // ---------------------------------------------------------------------
  // Status pill: offline → button to the offline till; un-synced or
  // to-review offline receipts → reminder. Shadow DOM so the web app's CSS
  // can't touch it (and vice versa).
  var host = null, root = null, pill = null, lastHtml = '';
  var offlineTicks = 0;

  function ensureHost() {
    if (host || !document.body) return !!host;
    host = document.createElement('div');
    host.setAttribute('data-pos-desktop', 'status');
    host.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483646;pointer-events:none;';
    root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var style = document.createElement('style');
    style.textContent =
      '.p{pointer-events:auto;display:flex;gap:8px;align-items:center;font:600 13px/1.2 system-ui,Segoe UI,sans-serif;' +
      'border-radius:999px;padding:8px 10px 8px 14px;box-shadow:0 6px 24px rgba(0,0,0,.35);color:#fff}' +
      '.off{background:#b42318}.warn{background:#b54708}.ok{background:#1d2939}' +
      'button{font:inherit;border:0;border-radius:999px;padding:6px 12px;cursor:pointer;background:#fff;color:#111}' +
      '.hide{display:none}';
    root.appendChild(style);
    pill = document.createElement('div');
    pill.className = 'p hide';
    root.appendChild(pill);
    document.body.appendChild(host);
    pill.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-a');
      if (a === 'till') bridge.openOfflineTill().catch(function () {});
      if (a === 'fiscal') bridge.openFiscalSettings().catch(function () {});
    });
    return true;
  }

  function render(info) {
    if (!ensureHost()) return;
    var j = (info && info.journal) || {};
    var html = '', cls = 'p hide';
    if (info && info.online === false) {
      offlineTicks += 1;
    } else {
      offlineTicks = 0;
    }
    if (offlineTicks >= 2) {
      cls = 'p off';
      html = '<span>Fără internet</span><button data-a="till">Casa offline</button>';
    } else if (j.unknownPrints > 0 || j.needsReview > 0) {
      cls = 'p warn';
      html = '<span>' + (j.unknownPrints + j.needsReview) + ' bon(uri) offline de verificat</span>' +
        '<button data-a="till">Jurnal</button>';
    } else if (j.pendingSync > 0) {
      cls = 'p ok';
      html = '<span>Se sincronizează ' + j.pendingSync + ' bon(uri) offline…</span>';
    } else if (info && info.fiscal && info.fiscal.monitored && info.fiscal.online === false) {
      cls = 'p warn';
      html = '<span>Casa de marcat nu răspunde</span><button data-a="fiscal">Setări</button>';
    }
    if (html !== lastHtml) {
      pill.innerHTML = html;
      lastHtml = html;
    }
    pill.className = cls;
  }

  function tick() {
    if (document.visibilityState === 'hidden') return;
    bridge.info().then(render).catch(function () { /* not allowed on this origin */ });
  }
  setInterval(tick, 5000);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick, { once: true });
  } else {
    setTimeout(tick, 500);
  }
})();
