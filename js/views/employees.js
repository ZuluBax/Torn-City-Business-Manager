(function (DMB) {
  'use strict';
  const U = DMB.util, C = DMB.calc, db = DMB.db, S = DMB.services, ui = DMB.ui, F = DMB.forms;
  const esc = U.escapeHtml;

  // Kept at module level so filters survive re-renders when data changes.
  const filters = { q: '', status: 'current', position: '', sort: 'name' };

  const SORTS = {
    name: { label: 'Name (A–Z)', fn: (a, b) => a.e.name.localeCompare(b.e.name) },
    salary: { label: 'Salary (high–low)', fn: (a, b) => b.salary - a.salary },
    start: { label: 'Start date (newest)', fn: (a, b) => (a.e.startDate < b.e.startDate ? 1 : -1) },
    outstanding: { label: 'Outstanding (high–low)', fn: (a, b) => b.stats.outstanding - a.stats.outstanding },
    // Least recently active first; anyone without Torn activity data sinks to the bottom.
    active: { label: 'Last active (longest ago)', fn: (a, b) => (a.activeAt || Number.MAX_SAFE_INTEGER) - (b.activeAt || Number.MAX_SAFE_INTEGER) },
  };
  const STATUS_FILTERS = { current: 'Active + Inactive', '': 'All statuses', active: 'Active', inactive: 'Inactive', left: 'Left' };

  // ---------- List ----------

  function rowsFor(data, ledgers) {
    const q = filters.q.trim().toLowerCase();
    return data.employees
      .filter((e) => {
        if (filters.status === 'current' && e.status === 'left') return false;
        if (filters.status && filters.status !== 'current' && e.status !== filters.status) return false;
        if (filters.position && e.position !== filters.position) return false;
        if (q && !e.name.toLowerCase().includes(q) && !e.tornId.includes(q)) return false;
        return true;
      })
      .map((e) => ({ e, salary: C.currentSalary(e), stats: C.employeeStats(data, e, null, ledgers), activeAt: (ui.lastActiveOf(e.tornId) || {}).at }))
      .sort(SORTS[filters.sort].fn);
  }

  function renderTable(el) {
    const data = db.snapshot();
    const ledgers = C.allLedgers(data);
    const rows = rowsFor(data, ledgers);
    const anyEmployees = data.employees.length > 0;
    const target = el.querySelector('[data-table]');
    if (!anyEmployees) {
      target.innerHTML = ui.emptyState('No employees yet', 'Add your first employee to start tracking salaries and training.',
        `<button type="button" class="btn btn-primary" data-add>${ui.icon('plus')} Add employee</button>`);
      target.querySelector('[data-add]').addEventListener('click', () => F.employeeForm());
      return;
    }
    target.innerHTML = `<p class="result-count">${rows.length} of ${data.employees.length} employees</p>` + ui.table({
      empty: 'No employees match these filters.',
      rows,
      columns: [
        { label: 'Employee', render: (r) => `${ui.employeeLink(r.e.id)}${r.e.isDemo ? ' <span class="badge badge-muted">demo</span>' : ''}` },
        { label: 'Torn ID', render: (r) => `<span class="mono">${esc(r.e.tornId)}</span>` },
        { label: 'Position', render: (r) => esc(r.e.position) },
        { label: 'Salary/day', align: 'right', render: (r) => ui.money(r.salary) },
        { label: 'Start date', render: (r) => U.formatDate(r.e.startDate) },
        { label: 'Status', render: (r) => ui.statusBadge(r.e.status) },
        { label: 'Last active', render: (r) => ui.lastActiveBadge(r.e.tornId) },
        { label: 'Trains', align: 'right', render: (r) => U.formatNumber(r.stats.trainsReceived) },
        { label: 'Outstanding', align: 'right', render: (r) => (r.stats.outstanding ? `<span class="text-red">${ui.money(r.stats.outstanding)}</span>` : '<span class="muted">—</span>') },
        { label: '', cls: 'actions', render: (r) => `
          <a class="icon-btn" href="#/employees/${esc(r.e.id)}" title="View" aria-label="View ${esc(r.e.name)}">${ui.icon('eye')}</a>
          <button type="button" class="icon-btn" data-edit="${esc(r.e.id)}" title="Edit" aria-label="Edit ${esc(r.e.name)}">${ui.icon('edit')}</button>` },
      ],
    });
    target.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => F.employeeForm(b.dataset.edit)));
  }

  function renderList(el) {
    const s = db.settings();
    el.innerHTML = `
      ${ui.pageHeader('Employees', 'Staff records, positions and salaries.', `
        ${db.hasTornKey() ? `<button type="button" class="btn btn-ghost" data-torn>${ui.icon('download')} Import from Torn</button>` : ''}
        <button type="button" class="btn btn-primary" data-add>${ui.icon('plus')} Add employee</button>`)}
      <div class="toolbar">
        <label class="search"><span class="sr-only">Search</span>${ui.icon('search')}<input type="search" data-filter="q" placeholder="Search name or Torn ID…" value="${esc(filters.q)}"></label>
        <select data-filter="status" aria-label="Filter by status">${ui.mapOptions(STATUS_FILTERS, filters.status)}</select>
        <select data-filter="position" aria-label="Filter by position">${ui.options(s.positions, filters.position, { placeholder: 'All positions' })}</select>
        <select data-filter="sort" aria-label="Sort">${ui.options(Object.entries(SORTS).map(([value, o]) => ({ value, label: o.label })), filters.sort)}</select>
      </div>
      <div data-table></div>`;
    el.querySelector('[data-add]').addEventListener('click', () => F.employeeForm());
    const tornBtn = el.querySelector('[data-torn]');
    if (tornBtn) tornBtn.addEventListener('click', () => F.tornImport());
    ui.bindFilters(el, filters, () => renderTable(el));
    renderTable(el);
  }

  // ---------- Profile ----------

  function renderProfile(el, id) {
    const e = db.get('employees', id);
    if (!e) {
      el.innerHTML = `${ui.pageHeader('Employee not found')}${ui.emptyState('This employee does not exist', 'They may have been removed.', '<a class="btn btn-ghost" href="#/employees">Back to employees</a>')}`;
      return;
    }
    const data = db.snapshot();
    const ledger = C.ledgerForEmployee(data, id);
    const st = C.employeeStats(data, e);
    const salary = C.currentSalary(e);
    const trainings = data.training.filter((t) => t.employeeId === id).sort((a, b) => (a.date < b.date ? 1 : -1));
    const payments = data.payments.filter((p) => p.employeeId === id).sort((a, b) => (a.date < b.date ? 1 : -1));
    const canDelete = !S.employeeHasRecords(id);

    const statusAction = e.status === 'left'
      ? `<button type="button" class="btn btn-ghost" data-act="reactivate">${ui.icon('userOn')} Re-activate</button>`
      : `<button type="button" class="btn btn-ghost" data-act="leave">${ui.icon('userOff')} Mark as left</button>`;

    el.innerHTML = `
      <a href="#/employees" class="back-link">${ui.icon('back')} All employees</a>
      <header class="profile-header">
        <div class="avatar" aria-hidden="true">${esc(e.name.replace(/\[DEMO\]\s*/, '').slice(0, 1).toUpperCase())}</div>
        <div class="profile-title">
          <h1>${esc(e.name)}</h1>
          <p class="page-sub">${esc(e.position)} · Torn ID <span class="mono">${esc(e.tornId)}</span> · ${ui.statusBadge(e.status)} · Last active ${ui.lastActiveBadge(e.tornId)}</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-primary" data-act="train">${ui.icon('train')} Record train</button>
          <button type="button" class="btn btn-primary" data-act="pay">${ui.icon('cash')} Record payment</button>
          <button type="button" class="btn btn-ghost" data-act="edit">${ui.icon('edit')} Edit</button>
          ${statusAction}
          ${canDelete ? `<button type="button" class="btn btn-ghost btn-danger-ghost" data-act="delete" title="Only possible while they have no history">${ui.icon('trash')} Delete</button>` : ''}
        </div>
      </header>

      <div class="stat-grid">
        ${ui.statCard({ label: 'Outstanding balance', value: ui.money(st.outstanding), tone: st.outstanding ? 'red' : 'green', iconName: 'alert', sub: st.lastPaymentDate ? `Last payment ${U.formatDate(st.lastPaymentDate)}` : 'No payments yet' })}
        ${ui.statCard({ label: 'Trains received', value: U.formatNumber(st.trainsReceived), iconName: 'train', sub: `${st.paidTrains} paid · ${st.unpaidTrains} unpaid · ${st.freeTrains} free` })}
        ${ui.statCard({ label: 'Spent on trains', value: ui.money(st.charged), iconName: 'tag', sub: `${ui.money(st.paid)} paid so far` })}
        ${ui.statCard({ label: 'Salary paid (est.)', value: ui.money(st.salaryCost), iconName: 'wallet', sub: `${U.formatNumber(st.daysEmployed)} day${st.daysEmployed === 1 ? '' : 's'} at up to ${ui.money(salary)}/day` })}
      </div>

      <div class="grid-2">
        ${ui.panel('Details', `
          <dl class="details">
            <dt>Position</dt><dd>${esc(e.position)}</dd>
            <dt>Salary / day</dt><dd>${ui.money(salary)}</dd>
            <dt>Start date</dt><dd>${U.formatDate(e.startDate)}</dd>
            <dt>End date</dt><dd>${e.endDate ? U.formatDate(e.endDate) : '<span class="muted">—</span>'}</dd>
            ${e.reasonForLeaving ? `<dt>Reason for leaving</dt><dd>${esc(e.reasonForLeaving)}</dd>` : ''}
            <dt>Working stats</dt><dd class="pre">${e.workingStats ? esc(e.workingStats) : '<span class="muted">—</span>'}</dd>
            <dt>Notes</dt><dd class="pre">${e.notes ? esc(e.notes) : '<span class="muted">—</span>'}</dd>
          </dl>`)}
        ${ui.panel('Financial summary', `
          <dl class="details">
            <dt>Training charged</dt><dd>${ui.money(st.charged)}</dd>
            <dt>Training paid</dt><dd>${ui.money(st.paid)}</dd>
            <dt>Outstanding</dt><dd class="${st.outstanding ? 'text-red' : ''}">${ui.money(st.outstanding)}</dd>
            <dt>Estimated salary paid</dt><dd>${ui.money(st.salaryCost)}</dd>
            <dt>Net value to company</dt><dd class="${st.netValue < 0 ? 'text-red' : 'text-green'}">${ui.money(st.netValue)}</dd>
            <dt>Last train</dt><dd>${st.lastTrainDate ? U.formatDate(st.lastTrainDate) : '<span class="muted">—</span>'}</dd>
          </dl>
          <p class="small muted">Net value = training charged + other payments − estimated salary.</p>`)}
      </div>

      ${ui.panel('Training history', ui.table({
        rows: trainings,
        empty: 'No training recorded yet.',
        columns: [
          { label: 'Date', render: (t) => U.formatDate(t.date) },
          { label: 'Trains', align: 'right', render: (t) => t.trainCount },
          { label: 'Type', render: (t) => ui.trainTypeBadge(t.trainType) },
          { label: 'Price/train', align: 'right', render: (t) => ui.money(t.pricePerTrain) },
          { label: 'Total', align: 'right', render: (t) => ui.money(ledger.rows.get(t.id).charge) },
          { label: 'Paid', align: 'right', render: (t) => ui.money(ledger.rows.get(t.id).paid) },
          { label: 'Outstanding', align: 'right', render: (t) => ui.money(ledger.rows.get(t.id).outstanding) },
          { label: 'Status', render: (t) => ui.payStatusBadge(ledger.rows.get(t.id).status) },
          { label: 'Notes', cls: 'notes', render: (t) => esc(t.notes) },
          { label: '', cls: 'actions', render: (t) => `
            ${ledger.rows.get(t.id).outstanding ? `<button type="button" class="icon-btn" data-pay-training="${esc(t.id)}" title="Record payment for this" aria-label="Record payment">${ui.icon('cash')}</button>` : ''}
            <button type="button" class="icon-btn" data-edit-training="${esc(t.id)}" title="Edit" aria-label="Edit">${ui.icon('edit')}</button>` },
        ],
      }))}

      ${ui.panel('Payment history', ui.table({
        rows: payments,
        empty: 'No payments recorded yet.',
        columns: [
          { label: 'Date', render: (p) => U.formatDate(p.date) },
          { label: 'Type', render: (p) => ui.paymentTypeBadge(p.paymentType) },
          { label: 'Amount', align: 'right', render: (p) => (p.paymentType === 'refund' ? `<span class="text-red">−${ui.money(p.amount)}</span>` : ui.money(p.amount)) },
          { label: 'For training', render: (p) => { const t = p.trainingId && db.get('training', p.trainingId); return t ? `${U.formatDate(t.date)} (${t.trainCount})` : '<span class="muted">Oldest balance</span>'; } },
          { label: 'Notes', cls: 'notes', render: (p) => esc(p.notes) },
          { label: '', cls: 'actions', render: (p) => `<button type="button" class="icon-btn" data-edit-payment="${esc(p.id)}" title="Edit" aria-label="Edit">${ui.icon('edit')}</button>` },
        ],
      }))}

      ${ui.panel('Salary history', ui.table({
        rows: C.sortedSalaryHistory(e).reverse(),
        columns: [
          { label: 'Effective from', render: (h) => U.formatDate(h.effectiveFrom) },
          { label: 'Salary/day', align: 'right', render: (h) => ui.money(h.salaryPerDay) },
        ],
      }))}
    `;

    const on = (sel, fn) => { const b = el.querySelector(sel); if (b) b.addEventListener('click', fn); };
    on('[data-act=train]', () => F.trainingForm(null, { employeeId: id }));
    on('[data-act=pay]', () => F.paymentForm(null, { employeeId: id }));
    on('[data-act=edit]', () => F.employeeForm(id));
    on('[data-act=leave]', () => markLeft(e));
    on('[data-act=reactivate]', async () => {
      const ok = await ui.confirmDialog({ title: `Re-activate ${e.name}?`, message: 'Their status will be set to Active and their end date cleared.<br><br><strong>Note:</strong> the salary estimate treats them as employed continuously from their start date, including any time away. If they were gone a while, edit their start date afterwards.', confirmText: 'Re-activate' });
      if (ok) ui.runAction(() => S.setEmployeeStatus(id, 'active'), `${e.name} re-activated`);
    });
    on('[data-act=delete]', async () => {
      const ok = await ui.confirmDialog({ title: `Delete ${e.name}?`, message: 'They have no training or payment history, so this permanently deletes the record. To keep a record of past staff, use <strong>Mark as left</strong> instead.', confirmText: 'Delete', danger: true });
      if (ok && await ui.runAction(() => S.deleteEmployee(id), 'Employee deleted')) location.hash = '#/employees';
    });
    el.querySelectorAll('[data-edit-training]').forEach((b) => b.addEventListener('click', () => F.trainingForm(b.dataset.editTraining)));
    el.querySelectorAll('[data-pay-training]').forEach((b) => b.addEventListener('click', () => F.paymentForm(null, { employeeId: id, trainingId: b.dataset.payTraining })));
    el.querySelectorAll('[data-edit-payment]').forEach((b) => b.addEventListener('click', () => F.paymentForm(b.dataset.editPayment)));
  }

  function markLeft(e) {
    ui.openModal({
      title: `Mark ${e.name} as left`,
      size: 'sm',
      body: `<form id="leave-form" class="form-grid" novalidate><p class="form-error" role="alert" hidden></p>
        <p class="field-full muted small">Their record, training and payments are kept. Salary stops after the end date.</p>
        ${ui.field({ label: 'End date', name: 'endDate', type: 'date', value: U.todayISO(), required: true, full: true })}
        ${ui.field({ label: 'Reason for leaving', name: 'reasonForLeaving', value: e.reasonForLeaving || '', full: true, attrs: 'maxlength="500"' })}
      </form>`,
      footer: `<button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" form="leave-form" class="btn btn-primary">Mark as left</button>`,
      onMount(el, close) {
        ui.bindSubmit(el.querySelector('form'), (d) => S.saveEmployee({ ...e, salaryPerDay: String(C.currentSalary(e)), status: 'left', endDate: d.endDate, reasonForLeaving: d.reasonForLeaving }, e.id), {
          onSuccess() { close(); ui.toast(`${e.name} marked as left`); },
        });
      },
    });
  }

  function render(el, params) {
    if (params && params.id) renderProfile(el, params.id);
    else renderList(el);
  }

  DMB.views = DMB.views || {};
  DMB.views.employees = { title: 'Employees', render };
})(window.DMB = window.DMB || {});
