/*
 * App shell: boots the database, renders the sidebar, routes #/hash URLs to views and
 * re-renders the current view whenever data changes.
 */
(function (DMB) {
  'use strict';
  const ui = DMB.ui, db = DMB.db;

  const NAV = [
    { route: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { route: 'employees', label: 'Employees', icon: 'users' },
    { route: 'training', label: 'Training', icon: 'train' },
    { route: 'payments', label: 'Payments', icon: 'cash' },
    { route: 'finances', label: 'Finances', icon: 'chart' },
    { route: 'reports', label: 'Reports', icon: 'report' },
    { route: 'settings', label: 'Settings', icon: 'settings' },
  ];

  const main = () => document.getElementById('main');

  function parseHash() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const route = DMB.views[parts[0]] ? parts[0] : 'dashboard';
    return { route, params: { id: parts[1] || null } };
  }

  function renderNav() {
    const { route } = parseHash();
    const s = db.settings();
    document.getElementById('brand-name').textContent = s.companyName;
    document.getElementById('topbar-name').textContent = s.companyName;
    document.getElementById('storage-note').innerHTML = db.mode === 'server'
      ? 'Data is stored on the Pi.<br>Backed up every night.'
      : 'Data is stored on this PC only.<br>Back up from Settings.';
    document.getElementById('nav').innerHTML = NAV.map((n) => `
      <a href="#/${n.route}" class="nav-link ${route === n.route ? 'active' : ''}" ${route === n.route ? 'aria-current="page"' : ''}>
        ${ui.icon(n.icon)}<span>${n.label}</span>
      </a>`).join('');
  }

  let lastRoute = null;

  function render() {
    const { route, params } = parseHash();
    const view = DMB.views[route];
    const el = main();
    const key = route + '/' + (params.id || '');
    // Keep scroll position when re-rendering the same page after a save.
    const scroll = key === lastRoute ? window.scrollY : 0;
    try {
      view.render(el, params);
    } catch (err) {
      console.error(err);
      el.innerHTML = `<div class="empty"><h3>Something went wrong showing this page</h3><p>${DMB.util.escapeHtml(err.message)}</p><p class="muted small">Your data is safe. Try another page, or export a backup from Settings.</p></div>`;
    }
    document.title = `${view.title} · ${db.settings().companyName} Manager`;
    renderNav();
    window.scrollTo(0, scroll);
    if (key !== lastRoute) {
      document.body.classList.remove('nav-open');
      el.focus({ preventScroll: true });
    }
    lastRoute = key;
  }

  function applyTheme() {
    document.documentElement.dataset.theme = db.settings().theme === 'light' ? 'light' : 'dark';
  }

  // Re-render at most once per frame even if several writes land together.
  let pending = false;
  function scheduleRender() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; applyTheme(); render(); });
  }

  /*
   * Turns new Torn "sent you $" events into payments. On the Pi the server collects events
   * every 15 minutes; when opened by double-click, this page fetches them itself while open.
   */
  const TORN_EVENTS_POLL_MS = 15 * 60 * 1000;
  function watchTornPayments() {
    let queued = false;
    const process = () => {
      if (queued || !db.all('tornEvents').some((e) => e.status === 'new')) return;
      queued = true;
      setTimeout(async () => {
        queued = false;
        const added = await DMB.services.processTornEvents().catch((e) => { console.warn(e); return 0; });
        if (added) ui.toast(`${added} payment${added === 1 ? '' : 's'} from Torn added`);
      }, 300);
    };
    db.onChange(process);
    process();

    if (db.mode === 'local') {
      const pull = async () => {
        const key = db.settings().tornApiKey;
        if (!key) return;
        try { await DMB.services.addTornEvents(await DMB.torn.fetchEvents(key)); } catch (e) { console.warn('Torn events:', e.message); }
      };
      pull();
      setInterval(pull, TORN_EVENTS_POLL_MS);
    }
  }

  async function boot() {
    document.getElementById('menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
    document.getElementById('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
    try {
      await db.init();
    } catch (err) {
      console.error(err);
      main().innerHTML = `<div class="empty"><h3>Could not open the database</h3><p>${DMB.util.escapeHtml(err.message || String(err))}</p>
        <p class="muted small">This app stores data with IndexedDB. Use an up-to-date Chrome, Edge or Firefox, and make sure you are not in a private/incognito window.</p></div>`;
      return;
    }
    applyTheme();
    db.onChange(scheduleRender);
    watchTornPayments();
    window.addEventListener('hashchange', render);
    if (!location.hash) history.replaceState(null, '', '#/dashboard');
    render();
    document.body.classList.remove('booting');
  }

  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    ui.toast(`Unexpected error: ${(e.reason && e.reason.message) || e.reason}`, 'error');
  });

  DMB.app = { applyTheme, render };
  document.addEventListener('DOMContentLoaded', boot);
})(window.DMB = window.DMB || {});
