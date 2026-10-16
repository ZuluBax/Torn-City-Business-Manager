(function (DMB) {
  'use strict';
  const U = DMB.util, C = DMB.calc, db = DMB.db, ui = DMB.ui, F = DMB.forms, L = DMB.layout;
  const esc = U.escapeHtml;

  const ACTIVITY_ICONS = {
    employee_added: 'users', employee_updated: 'edit', employee_left: 'userOff', employee_removed: 'trash',
    salary_changed: 'wallet', training_recorded: 'train', training_updated: 'train', training_given: 'check', training_deleted: 'trash',
    payment_recorded: 'cash', payment_updated: 'cash', payment_deleted: 'trash', settings_changed: 'settings',
  };

  // Survives re-renders (e.g. a save or another device syncing) while arranging.
  let arranging = false;

  function render(el) {
    const data = db.snapshot();
    const s = data.settings;
    const today = U.todayISO();
    const ledgers = C.allLedgers(data);
    const fin = C.financeSummary(data, null, today);
    const tr = C.trainingSummary(data, null, ledgers);
    const active = data.employees.filter((e) => e.status === 'active');
    const current = data.employees.filter((e) => C.isCurrentStaff(e, today));
    const daily = C.dailySalaryBill(data.employees, today);

    const owing = data.employees
      .map((e) => ({ e, L: ledgers.byEmployee.get(e.id) }))
      .filter((r) => r.L && r.L.outstanding > 0)
      .map((r) => ({ ...r, trains: U.sum(data.training.filter((t) => t.employeeId === r.e.id && r.L.rows.get(t.id).outstanding > 0), (t) => t.trainCount) }))
      .sort((a, b) => b.L.outstanding - a.L.outstanding);
    const totalOutstanding = U.sum(owing, (r) => r.L.outstanding);

    const overview = current
      .map((e) => ({ e, st: C.employeeStats(data, e, today, ledgers) }))
      .sort((a, b) => a.e.name.localeCompare(b.e.name));

    const quick = `
      <button type="button" class="btn btn-ghost" data-q="emp">${ui.icon('users')} Add employee</button>
      <button type="button" class="btn btn-primary" data-q="train">${ui.icon('train')} Record train</button>
      <button type="button" class="btn btn-primary" data-q="pay">${ui.icon('cash')} Record payment</button>`;

    const firstRun = !data.employees.length ? `
      <section class="welcome">
        <h2>Welcome to ${esc(s.companyName)} Manager</h2>
        <p>Start by adding your employees, or load some demo data from Settings to explore first.</p>
        <div class="button-row">
          <button type="button" class="btn btn-primary" data-q="emp">${ui.icon('plus')} Add your first employee</button>
          <a class="btn btn-ghost" href="#/settings">Load demo data</a>
        </div>
      </section>` : '';

    const owed = C.trainsOwed(data);

    const reviewCount =db.all('tornEvents').filter((e) => e.status === 'review').length;
    const reviewAlert = reviewCount
      ? `<div class="review-alert" role="status">${ui.icon('alert')}<span>${reviewCount} Torn payment${reviewCount === 1 ? '' : 's'} need${reviewCount === 1 ? 's' : ''} checking</span><a href="#/payments" class="link-sm">Check now →</a></div>`
      : '';

    // ---- Movable pieces: each has a stable id used by the saved layout ----

    const cards = {
      active: { label: 'Active employees', html: ui.statCard({ label: 'Active employees', value: U.formatNumber(active.length), iconName: 'users', sub: `${current.length - active.length} inactive · ${data.employees.length - current.length} left` }) },
      dailySalary: { label: 'Daily salary cost', html: ui.statCard({ label: 'Daily salary cost', value: ui.money(daily), iconName: 'clock', sub: `≈ ${ui.money(daily * 30)} / 30 days` }) },
      trainsSold: { label: 'Trains sold', html: ui.statCard({ label: 'Trains sold', value: U.formatNumber(tr.soldTrains), iconName: 'train', sub: `${U.formatNumber(tr.freeTrains)} given free` }) },
      trainRevenue: { label: 'Train revenue', html: ui.statCard({ label: 'Train revenue', value: ui.money(tr.revenue), iconName: 'trend', tone: 'gold', sub: `${ui.money(tr.collected)} collected` }) },
      outstanding: { label: 'Outstanding payments', html: ui.statCard({ label: 'Outstanding payments', value: ui.money(totalOutstanding), iconName: 'alert', tone: totalOutstanding ? 'red' : 'green', sub: `${owing.length} employee${owing.length === 1 ? '' : 's'} owe money` }) },
      totalSalary: { label: 'Total salary cost', html: ui.statCard({ label: 'Total salary cost', value: ui.money(fin.salaries), iconName: 'wallet', sub: 'All time, estimated' }) },
      netProfit: { label: 'Net profit', html: ui.statCard({ label: 'Net profit', value: ui.money(fin.netProfit), iconName: 'chart', tone: fin.netProfit < 0 ? 'red' : 'green', sub: 'All time' }) },
      trainsOwed: { label: 'Trains to give', html: ui.statCard({ label: 'Trains to give', value: U.formatNumber(owed.trains), iconName: 'train', tone: owed.trains ? 'amber' : 'green', sub: owed.trains ? `<a href="#/training">${owed.employees} employee${owed.employees === 1 ? '' : 's'} waiting</a>` : 'Everyone has their trains' }) },
      trainPrice: { label: 'Current train price', html: ui.statCard({ label: 'Current train price', value: ui.money(s.trainPrice), iconName: 'tag', sub: '<a href="#/settings">Change in Settings</a>' }) },
    };

    const blocks = {};
    if (s.tornCompany) {
      blocks.torn = { label: 'On Torn', html: ui.panel('On Torn', `
        <dl class="kv-grid kv-grid-4">
          <div><dt>Company funds</dt><dd>${ui.money(s.tornCompany.funds)}</dd></div>
          <div><dt>Trains available</dt><dd>${U.formatNumber(s.tornCompany.trainsAvailable)}</dd></div>
          <div><dt>Staff</dt><dd>${s.tornCompany.employeesHired}/${s.tornCompany.employeesCapacity}</dd></div>
          <div><dt>Daily income</dt><dd>${ui.money(s.tornCompany.dailyIncome)}</dd></div>
        </dl>
        <p class="small muted">As of ${esc(U.formatDateTime(s.tornCompany.fetchedAt))}.${db.mode === 'server' ? ' The Pi refreshes these every 15 minutes.' : ''}</p>`,
      { actions: `<button type="button" class="btn btn-sm btn-ghost" data-q="torn">${ui.icon('download')} Refresh from Torn</button>` }) };
    }
    blocks.financial = { label: 'Financial summary', html: ui.panel('Financial summary', ui.barList([
      { label: 'Train revenue', value: fin.trainRevenue, tone: 'gold' },
      { label: 'Other income', value: fin.otherIncome + fin.otherEmployeePayments, tone: 'gold' },
      { label: 'Salary expenditure', value: fin.salaries, tone: 'red' },
      { label: 'Other expenses', value: fin.otherExpenses, tone: 'red' },
    ]) + `<div class="net-line"><span>Net profit</span><strong class="${fin.netProfit < 0 ? 'text-red' : 'text-green'}">${ui.money(fin.netProfit)}</strong></div>`,
    { actions: '<a href="#/finances" class="link-sm">Finances →</a>' }) };
    blocks.training = { label: 'Training summary', html: ui.panel('Training summary', `
      <dl class="kv-grid">
        <div><dt>Total trains recorded</dt><dd>${U.formatNumber(tr.trains)}</dd></div>
        <div><dt>Trains sold</dt><dd>${U.formatNumber(tr.soldTrains)}</dd></div>
        <div><dt>Trains given free</dt><dd>${U.formatNumber(tr.freeTrains)}</dd></div>
        <div><dt>Fully paid</dt><dd class="text-green">${U.formatNumber(tr.paidTrains)}</dd></div>
        <div><dt>Unpaid / part-paid</dt><dd class="${tr.unpaidTrains + tr.partialTrains ? 'text-red' : ''}">${U.formatNumber(tr.unpaidTrains + tr.partialTrains)}</dd></div>
        <div><dt>Train revenue</dt><dd>${ui.money(tr.revenue)}</dd></div>
      </dl>`, { actions: '<a href="#/training" class="link-sm">Training →</a>' }) };
    blocks.owing = { label: 'Outstanding payments', html: ui.panel('Outstanding payments', ui.table({
      rows: owing,
      empty: 'Nobody owes anything. 🎵',
      columns: [
        { label: 'Employee', render: (r) => ui.employeeLink(r.e.id) },
        { label: 'Trains owing', align: 'right', render: (r) => r.trains },
        { label: 'Amount due', align: 'right', render: (r) => ui.money(r.L.charged) },
        { label: 'Amount paid', align: 'right', render: (r) => ui.money(r.L.paid) },
        { label: 'Outstanding', align: 'right', render: (r) => `<strong class="text-red">${ui.money(r.L.outstanding)}</strong>` },
        { label: 'Last payment', render: (r) => (r.L.lastPaymentDate ? U.formatDate(r.L.lastPaymentDate) : '<span class="muted">Never</span>') },
        { label: 'Status', render: (r) => ui.payStatusBadge(r.L.paid > 0 ? 'partial' : 'unpaid') },
        { label: '', cls: 'actions', render: (r) => `<button type="button" class="btn btn-sm btn-ghost" data-pay="${esc(r.e.id)}">${ui.icon('cash')} Pay</button>` },
      ],
    }), { actions: '<a href="#/payments" class="link-sm">Payments →</a>' }) };
    blocks.overview = { label: 'Employee overview', html: ui.panel('Employee overview', ui.table({
      rows: overview,
      empty: 'No current employees.',
      columns: [
        { label: 'Employee', render: (r) => ui.employeeLink(r.e.id) },
        { label: 'Position', render: (r) => esc(r.e.position) },
        { label: 'Salary/day', align: 'right', render: (r) => ui.money(C.currentSalary(r.e, today)) },
        { label: 'Start date', render: (r) => U.formatDate(r.e.startDate) },
        { label: 'Status', render: (r) => ui.statusBadge(r.e.status) },
        { label: 'Trains', align: 'right', render: (r) => r.st.trainsReceived },
        { label: 'Spent on trains', align: 'right', render: (r) => ui.money(r.st.charged) },
      ],
    }), { actions: '<a href="#/employees" class="link-sm">All employees →</a>' }) };
    blocks.activity = { label: 'Recent activity', html: ui.panel('Recent activity', db.all('activity').length
      ? `<ol class="activity">${db.all('activity').slice(0, 12).map((a) => `
        <li><span class="activity-icon">${ui.icon(ACTIVITY_ICONS[a.type] || 'clock')}</span>
          <div><p>${esc(a.message)}</p><time>${U.formatDateTime(a.at)}</time></div></li>`).join('')}</ol>`
      : '<p class="muted">Nothing yet — actions you take will appear here.</p>') };

    const parts = { ...cards, ...blocks };
    const kinds = {};
    Object.keys(cards).forEach((k) => { kinds[k] = 'card'; });
    Object.keys(blocks).forEach((k) => { kinds[k] = 'block'; });
    const layout = L.resolve(s.dashboardLayout, kinds);

    const arrangeBtn = `<button type="button" class="btn btn-ghost" data-arrange aria-pressed="${arranging}">${ui.icon('dashboard')} ${arranging ? 'Done' : 'Arrange'}</button>`;

    el.innerHTML = `
      <header class="page-header dash-header">
        <div class="dash-title">
          <div>
            <h1>${esc(s.companyName)}</h1>
            <p class="page-sub">Dashboard · ${U.formatDate(today)}</p>
          </div>
          ${s.banner ? `<img src="${esc(s.banner)}" alt="" class="banner-img">` : ''}
        </div>
        <div class="page-actions">${arrangeBtn}${data.employees.length ? quick : ''}</div>
      </header>
      ${arranging ? `<div class="arrange-bar" role="status">
          <span>${ui.icon('dashboard')} Drag any box to move it — drop it anywhere, including empty space. Arrows nudge it; the size button changes its width. Changes save straight away.</span>
          <button type="button" class="btn btn-sm btn-ghost" data-reset-layout>Reset layout</button>
          <button type="button" class="btn btn-sm btn-primary" data-arrange-done>Done</button>
        </div>` : ''}
      ${firstRun}
      ${reviewAlert}
      <div class="dash-grid ${arranging ? 'arranging' : ''}" data-sortable>
        ${layout.map((it) => `<div class="dash-item span-${it.span} is-${kinds[it.id]}${it.col ? ' has-col' : ''}" data-item="${it.id}"${it.col ? ` style="--col:${it.col}"` : ''}><div class="dash-inner">${arranging ? L.editBar(parts[it.id].label, it.span) : ''}${parts[it.id].html}</div></div>`).join('')}
      </div>`;
    L.pack(el.querySelector('[data-sortable]'));

    el.querySelectorAll('[data-q=emp]').forEach((b) => b.addEventListener('click', () => F.employeeForm()));
    el.querySelectorAll('[data-q=train]').forEach((b) => b.addEventListener('click', () => F.trainingForm()));
    el.querySelectorAll('[data-q=pay]').forEach((b) => b.addEventListener('click', () => F.paymentForm()));
    el.querySelectorAll('[data-q=torn]').forEach((b) => b.addEventListener('click', () => F.tornImport()));
    el.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => F.paymentForm(null, { employeeId: b.dataset.pay })));

    const toggle = () => { arranging = !arranging; render(el); };
    el.querySelector('[data-arrange]').addEventListener('click', toggle);
    if (!arranging) return;
    el.querySelector('[data-arrange-done]').addEventListener('click', toggle);
    el.querySelector('[data-reset-layout]').addEventListener('click', () => save(null, 'Layout reset'));
    bindArrange(el, layout, kinds);
  }

  function save(next, message) {
    return DMB.ui.runAction(() => DMB.services.saveSettings({ dashboardLayout: next }), message);
  }

  function bindArrange(el, layout, kinds) {
    const grid = el.querySelector('[data-sortable]');
    const byId = (id) => layout.find((x) => x.id === id);
    const fitCol = (col, span) => (col ? Math.max(1, Math.min(5 - span, col)) : undefined);
    const withCol = (it, col) => { const c = fitCol(col, it.span); return c ? { id: it.id, span: it.span, col: c } : { id: it.id, span: it.span }; };

    // Drop: pin the box to the column it was dropped in and place it in the order.
    L.makeDraggable(grid, (id) => byId(id).span, (id, drop) => {
      const moving = withCol(byId(id), drop.col);
      const rest = layout.filter((x) => x.id !== id);
      let i = drop.refId ? rest.findIndex((x) => x.id === drop.refId) : rest.length - 1;
      if (i < 0) i = rest.length - 1;
      rest.splice(drop.where === 'before' ? i : i + 1, 0, moving);
      save({ items: rest });
    });

    el.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
      const item = b.closest('[data-item]');
      const id = item.dataset.item;
      const dir = b.dataset.move;
      if (dir === 'left' || dir === 'right') {
        const it = byId(id);
        const col = L.currentCol(grid, item) + (dir === 'right' ? 1 : -1);
        if (col < 1 || col + it.span - 1 > L.gridMetrics(grid).cols) return; // already at the edge
        save({ items: layout.map((x) => (x.id === id ? withCol(x, col) : x)) });
        return;
      }
      const t = L.moveTarget(grid, item, dir);
      if (!t) return;
      if (t.where === 'before') t.ref.before(item); else t.ref.after(item);
      save({ items: L.ids(grid).map((x) => byId(x)) });
    }));
    el.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
      const id = b.closest('[data-item]').dataset.item;
      save({ items: layout.map((x) => {
        if (x.id !== id) return x;
        const span = L.nextSpan(x.span, kinds[id]);
        return x.col ? { ...x, span, col: fitCol(x.col, span) } : { ...x, span };
      }) });
    }));
  }

  DMB.views = DMB.views || {};
  DMB.views.dashboard = { title: 'Dashboard', render };
})(window.DMB = window.DMB || {});
