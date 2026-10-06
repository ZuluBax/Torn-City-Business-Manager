/*
 * IndexedDB persistence with an in-memory mirror.
 *
 * All records are loaded into memory once at startup (a music store's data is small), so
 * views and calculations read synchronously. Every write goes to IndexedDB first and the
 * memory copy is only updated once the transaction has committed — if a write fails, the
 * screen never shows data that wasn't actually saved.
 */
(function (DMB) {
  'use strict';

  const DB_NAME = 'dukes-music-box';
  const DB_VERSION = 2; // v2: added tornEvents
  const RECORD_STORES = ['employees', 'training', 'payments', 'expenses', 'income', 'activity', 'tornEvents'];
  const ALL_STORES = [...RECORD_STORES, 'settings'];
  const SETTINGS_KEY = 'app';
  const ACTIVITY_LIMIT = 300;

  const DEFAULT_SETTINGS = {
    key: SETTINGS_KEY,
    companyName: 'My Company',
    currency: '$',
    trainPrice: 420000,
    positions: ['Sales Apprentice', 'Sales Assistant', 'Cleaner', 'Musician', 'Supervisor', 'Bookkeeper', 'Trainer'],
    expenseCategories: ['Stock', 'Advertising', 'Company upgrades', 'Staff bonus', 'Other'],
    incomeCategories: ['Other sales', 'Investment', 'Other'],
    theme: 'dark',
    banner: '',              // optional dashboard banner, as a data: URL
    dashboardLayout: null,   // saved box order/widths; null = default (see js/layout.js)
    tornApiKey: '',
    tornCompany: null,       // last company snapshot from the Torn API (funds, trains available…)
    tornLastSync: null,
    tornSetupImported: false, // the one-off "setup spend" expense has been imported
  };

  let db = null;
  const state = { settings: { ...DEFAULT_SETTINGS } };
  RECORD_STORES.forEach((s) => { state[s] = []; });
  const listeners = new Set();

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  function open() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('This browser does not support IndexedDB.')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        // Future schema changes: bump DB_VERSION and branch on event.oldVersion here.
        for (const name of RECORD_STORES) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database is blocked — close other tabs running this app and reload.'));
    });
  }

  // ---------- Server mode (app opened from the Pi) ----------
  // Same in-memory mirror; writes go to the Pi's /api instead of IndexedDB. `serverVersion`
  // is sent with every commit so the Pi can reject a save based on stale data (HTTP 409).

  let mode = 'local';
  let serverVersion = 0;
  const POLL_MS = 15000;

  async function api(path, body) {
    let res;
    try {
      res = await fetch(path, body === undefined ? { cache: 'no-store' } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('Could not reach the Pi. Check it is switched on and you are on the home network. Nothing was saved.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      await loadServer();
      emit();
      throw new Error('This data was just changed on another device, so the page has been refreshed. Please check and try again.');
    }
    if (!res.ok) throw new Error(data.error || `The Pi returned an error (HTTP ${res.status}). Nothing was saved.`);
    return data;
  }

  async function detectServer() {
    if (!/^https?:$/.test(location.protocol)) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch('api/health', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      return res.ok && (await res.json()).ok === true;
    } catch (e) { return false; }
  }

  async function loadServer() {
    const data = await api('api/state');
    RECORD_STORES.forEach((s) => { state[s] = data[s] || []; });
    state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    delete state.settings.tornApiKey;
    state.activity.sort((a, b) => (a.at < b.at ? 1 : -1));
    serverVersion = data.version;
  }

  // Picks up changes made on other devices (phone, other PC) without a manual reload.
  function startPolling() {
    const check = async () => {
      try {
        const { version } = await api('api/version');
        if (version !== serverVersion) { await loadServer(); emit(); }
      } catch (e) { /* Pi briefly unreachable — try again next tick */ }
    };
    setInterval(check, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }

  async function loadAll() {
    if (mode === 'server') return loadServer();
    const tx = db.transaction(ALL_STORES, 'readonly');
    const results = await Promise.all(ALL_STORES.map((s) => promisify(tx.objectStore(s).getAll())));
    ALL_STORES.forEach((s, i) => {
      if (s === 'settings') {
        const saved = results[i].find((r) => r.key === SETTINGS_KEY);
        state.settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
      } else {
        state[s] = results[i];
      }
    });
    state.activity.sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  async function init() {
    if (await detectServer()) {
      mode = 'server';
      await loadServer();
      startPolling();
      return;
    }
    db = await open();
    // Another tab upgrading the schema would otherwise hang behind our open connection.
    db.onversionchange = () => { db.close(); location.reload(); };
    await loadAll();
    if (navigator.storage && navigator.storage.persist) {
      // Ask the browser not to evict our data under storage pressure. Best-effort only.
      navigator.storage.persist().catch(() => {});
    }
  }

  function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function makeActivity(type, message) {
    return { id: DMB.util.uid(), at: new Date().toISOString(), type, message };
  }

  /*
   * Applies a list of operations in ONE transaction: either all are saved or none are.
   *   { store, put: record }   or   { store, del: id }
   * `activity` (optional) is appended to the activity log in the same transaction.
   */
  async function commit(ops, activity) {
    const all = ops.slice();
    let act = null;
    if (activity) {
      act = makeActivity(activity.type, activity.message);
      all.push({ store: 'activity', put: act });
    }
    // Trim old activity entries in the same transaction so the log can't grow forever.
    const overflow = act ? state.activity.slice(ACTIVITY_LIMIT - 1) : [];
    overflow.forEach((a) => all.push({ store: 'activity', del: a.id }));

    if (mode === 'server') {
      const res = await api('api/commit', { baseVersion: serverVersion, ops: all });
      // A jump of more than one means another device saved in between: take the full state.
      if (res.version !== serverVersion + 1) { await loadServer(); emit(); return; }
      serverVersion = res.version;
    } else {
      const stores = [...new Set(all.map((o) => o.store))];
      const tx = db.transaction(stores, 'readwrite');
      for (const op of all) {
        const os = tx.objectStore(op.store);
        if (op.put) os.put(op.put); else os.delete(op.del);
      }
      await txDone(tx);
    }

    for (const op of all) {
      if (op.store === 'settings') {
        state.settings = { ...op.put };
        if (mode === 'server') {
          // The Pi keeps the key; the browser only knows whether one is set.
          if ('tornApiKey' in op.put) state.settings.tornApiKeySet = !!op.put.tornApiKey;
          delete state.settings.tornApiKey;
        }
        continue;
      }
      const list = state[op.store];
      const idx = list.findIndex((r) => r.id === (op.put ? op.put.id : op.del));
      if (op.put) { if (idx >= 0) list[idx] = op.put; else list.push(op.put); }
      else if (idx >= 0) list.splice(idx, 1);
    }
    state.activity.sort((a, b) => (a.at < b.at ? 1 : -1));
    emit();
  }

  // Wipes every store and writes `data` in one transaction (used by import, reset and demo).
  async function replaceAll(data, activity, { clearSecrets = false } = {}) {
    if (mode === 'server') {
      const act = activity ? makeActivity(activity.type, activity.message) : null;
      await api('api/replace', { data, activity: act, clearSecrets });
      await loadServer();
      emit();
      return;
    }
    const tx = db.transaction(ALL_STORES, 'readwrite');
    for (const s of ALL_STORES) tx.objectStore(s).clear();
    for (const s of RECORD_STORES) for (const rec of data[s] || []) tx.objectStore(s).put(rec);
    const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}), key: SETTINGS_KEY };
    tx.objectStore('settings').put(settings);
    const act = activity ? makeActivity(activity.type, activity.message) : null;
    if (act) tx.objectStore('activity').put(act);
    await txDone(tx);
    await loadAll();
    emit();
  }

  function all(store) { return state[store]; }
  function get(store, id) { return state[store].find((r) => r.id === id) || null; }
  function settings() { return state.settings; }

  // Plain snapshot used by calc.js; arrays are shared, so callers must treat it as read-only.
  function snapshot() {
    return {
      employees: state.employees, training: state.training, payments: state.payments,
      expenses: state.expenses, income: state.income, settings: state.settings,
    };
  }

  function exportState() {
    const out = { settings: { ...state.settings } };
    // Backups get copied around; the API key must never leave this browser.
    delete out.settings.tornApiKey;
    delete out.settings.tornApiKeySet;
    RECORD_STORES.forEach((s) => { out[s] = state[s].map((r) => ({ ...r })); });
    return out;
  }

  function hasTornKey() { return !!(state.settings.tornApiKey || state.settings.tornApiKeySet); }

  DMB.db = {
    init, onChange, commit, replaceAll, all, get, settings, snapshot, exportState, hasTornKey,
    get mode() { return mode; },
    RECORD_STORES, DEFAULT_SETTINGS, DB_VERSION,
  };
})(window.DMB = window.DMB || {});
