(function (DMB) {
  'use strict';
  const U = DMB.util, C = DMB.calc, db = DMB.db, ui = DMB.ui, F = DMB.forms;
  const esc = U.escapeHtml;

  const filters = { preset: 'thisMonth', from: '', to: '', tab: 'salary' };
  const TABS = { salary: 'Salaries', income: 'Other income', expenses: 'Other expenses' };

  function daysInRange(emp, range) {
    if (!emp.startDate) return 0;
    let from = emp.startDate, to = C.employmentEnd(emp);
    if (range.from && range.from > from) from = range.from;
    if (range.to && range.to < to) to = range.to;
    return from > to ? 0 : U.daysInclusive(from, to);
  }

  function salaryTab(data, range) {
    const today = U.todayISO();
    const daily = C.dailySalaryBill(data.employees, today);
    const allTime = U.sum(data.employees, (e) => C.salaryCost(e, null, today));
    const rows = data.employees
      .map((e) => ({ e, days: daysInRange(e, range), cost: C.salaryCost(e, range, today) }))
      .filter((r) => r.days > 0 || C.isCurrentStaff(r.e, today))
      .sort((a, b) => b.cost - a.cost);
    return `
      <div class="stat-grid stat-grid-compact">
        ${ui.statCard({ label: 'Daily salary bill', value: ui.money(daily), sub: 'All current staff' })}
        ${ui.statCard({ label: 'Weekly estimate', value: ui.money(daily * 7), sub: '7 × daily' })}
        ${ui.statCard({ label: 'Monthly estimate', value: ui.money(daily * 30), sub: '30 × daily' })}
        ${ui.statCard({ label: 'Historical salary cost', value: ui.money(allTime), sub: 'All time, estimated' })}
      </div>
      ${ui.table({
        rows,
        empty: 'No employees were employed in this period.',
        columns: [
          { label: 'Employee', render: (r) => ui.employeeLink(r.e.id) },
          { label: 'Position', render: (r) => esc(r.e.position) },
          { label: 'Salary/day', align: 'right', render: (r) => ui.money(C.currentSalary(r.e)) },
          { label: 'Days in period', align: 'right', render: (r) => U.formatNumber(r.days) },
          { label: 'Estimated cost', align: 'right', render: (r) => ui.money(r.cost) },
          { label: 'Status', render: (r) => ui.statusBadge(r.e.status) },
        ],
        footer: ['Total', '', '', '', ui.money(U.sum(rows, (r) => r.cost)), ''],
      })}
      <p class="small muted">Estimate = salary per day × days employed (start and end days included), using the rate that applied on each day. It does not reproduce Torn's exact payout rules.</p>`;
  }

  function entriesTab(kind, data, range) {
    const store = kind === 'expense' ? 'expenses' : 'income';
    const rows = data[store].filter((r) => U.inRange(r.date, range)).sort((a, b) => (a.date < b.date ? 1 : -1));
    return `
      <div class="tab-actions"><button type="button" class="btn btn-primary btn-sm" data-add-entry="${kind}">${ui.icon('plus')} Add ${kind === 'expense' ? 'expense' : 'income'}</button></div>
      ${ui.table({
        rows,
        empty: `No ${kind === 'expense' ? 'expenses' : 'other income'} in this period.`,
        columns: [
          { label: 'Date', render: (r) => U.formatDate(r.date) },
          { label: 'Description', render: (r) => esc(r.description) },
          { label: 'Category', render: (r) => ui.badge('muted', r.category) },
          { label: 'Amount', align: 'right', render: (r) => ui.money(r.amount) },
          { label: 'Notes', cls: 'notes', render: (r) => esc(r.notes) },
          { label: '', cls: 'actions', render: (r) => `
            <button type="button" class="icon-btn" data-edit-entry="${kind}:${esc(r.id)}" title="Edit" aria-label="Edit">${ui.icon('edit')}</button>
            <button type="button" class="icon-btn icon-danger" data-del-entry="${kind}:${esc(r.id)}" title="Delete" aria-label="Delete">${ui.icon('trash')}</button>` },
        ],
        footer: ['Total', '', '', ui.money(U.sum(rows, (r) => r.amount)), '', ''],
      })}`;
  }

  function monthlyChart(data, range) {
    // Use the chosen range when it spans 2–12 months; otherwise show recent months ending at
    // the range end so short periods still get context and "All time" stays readable.
    const today = U.todayISO();
    const to = range.to || today;
    const span = range.from ? U.daysInclusive(range.from, to) : Infinity;
    const r = span > 62 && span <= 366 ? { from: range.from, to } : { to };
    const months = C.monthlyFinance(data, r, today, span === Infinity ? 12 : 6);
    const max = Math.max(1, ...months.map((m) => Math.max(m.totalIncome, m.totalExpenses)));
    return ui.panel('Month by month', `
      <div class="col-chart" role="img" aria-label="Income and expenses by month">
        ${months.map((m) => `
          <div class="col-group" title="${U.formatMonth(m.month)}: income ${ui.money(m.totalIncome)}, expenses ${ui.money(m.totalExpenses)}, profit ${ui.money(m.netProfit)}">
            <div class="col-bars">
              <span class="col col-income" style="height:${(m.totalIncome / max * 100).toFixed(1)}%"></span>
              <span class="col col-expense" style="height:${(m.totalExpenses / max * 100).toFixed(1)}%"></span>
            </div>
            <span class="col-label">${U.formatMonth(m.month).slice(0, 3)}</span>
            <span class="col-profit ${m.netProfit < 0 ? 'text-red' : 'text-green'}">${ui.money(m.netProfit)}</span>
          </div>`).join('')}
      </div>
      <div class="legend"><span><i class="dot dot-income"></i>Income</span><span><i class="dot dot-expense"></i>Expenses</span><span class="muted">Figure under each month = profit</span></div>`);
  }

  function renderBody(el) {
    const data = db.snapshot();
    const range = ui.rangeOf(filters);
    const f = C.financeSummary(data, range, U.todayISO());

    el.querySelector('[data-summary]').innerHTML = `
      ${ui.statCard({ label: 'Total income', value: ui.money(f.totalIncome), iconName: 'trend', tone: 'gold', sub: ui.rangeLabel(range) })}
      ${ui.statCard({ label: 'Total expenses', value: ui.money(f.totalExpenses), iconName: 'wallet', sub: `${ui.money(f.salaries)} salaries (est.)` })}
      ${ui.statCard({ label: 'Net profit', value: ui.money(f.netProfit), iconName: 'chart', tone: f.netProfit < 0 ? 'red' : 'green', sub: 'Income − expenses' })}
      ${ui.statCard({ label: 'Training cash collected', value: ui.money(f.trainCash), iconName: 'cash', sub: `of ${ui.money(f.trainRevenue)} charged` })}`;

    el.querySelector('[data-breakdown]').innerHTML = `
      <div class="grid-2">
        ${ui.panel('Income', ui.barList([
          { label: 'Training sales', value: f.trainRevenue, tone: 'gold' },
          { label: 'Other income', value: f.otherIncome, tone: 'gold' },
          { label: 'Other employee payments', value: f.otherEmployeePayments, tone: 'gold' },
        ]) + `<p class="small muted">Training sales count when training is recorded, paid or not. Unpaid amounts appear under Payments → Outstanding.</p>`)}
        ${ui.panel('Expenses', ui.barList([
          { label: 'Employee salaries (est.)', value: f.salaries, tone: 'red' },
          { label: 'Other expenses', value: f.otherExpenses, tone: 'red' },
        ]))}
      </div>
      ${monthlyChart(data, range)}`;

    const tabs = el.querySelector('[data-tabs]');
    tabs.innerHTML = `
      <div class="tabs" role="tablist">${Object.entries(TABS).map(([k, label]) => `<button type="button" role="tab" class="tab ${filters.tab === k ? 'active' : ''}" aria-selected="${filters.tab === k}" data-tab="${k}">${label}</button>`).join('')}</div>
      <div class="tab-panel">${filters.tab === 'salary' ? salaryTab(data, range) : entriesTab(filters.tab === 'income' ? 'income' : 'expense', data, range)}</div>`;
    tabs.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { filters.tab = b.dataset.tab; renderBody(el); }));
    tabs.querySelectorAll('[data-add-entry]').forEach((b) => b.addEventListener('click', () => F.entryForm(b.dataset.addEntry)));
    tabs.querySelectorAll('[data-edit-entry]').forEach((b) => b.addEventListener('click', () => { const [k, id] = b.dataset.editEntry.split(':'); F.entryForm(k, id); }));
    tabs.querySelectorAll('[data-del-entry]').forEach((b) => b.addEventListener('click', () => { const [k, id] = b.dataset.delEntry.split(':'); F.confirmDeleteEntry(k, id); }));
  }

  function render(el) {
    el.innerHTML = `
      ${ui.pageHeader('Finances', 'Income, costs and profit for the period you choose.', `
        <button type="button" class="btn btn-ghost" data-add-income>${ui.icon('plus')} Other income</button>
        <button type="button" class="btn btn-primary" data-add-expense>${ui.icon('plus')} Expense</button>`)}
      <div class="toolbar">${ui.dateRangeControls(filters, 'fin')}</div>
      <div class="stat-grid" data-summary></div>
      <div data-breakdown></div>
      <section class="panel"><div class="panel-body" data-tabs></div></section>`;
    el.querySelector('[data-add-income]').addEventListener('click', () => F.entryForm('income'));
    el.querySelector('[data-add-expense]').addEventListener('click', () => F.entryForm('expense'));
    ui.bindFilters(el, filters, () => renderBody(el));
    renderBody(el);
  }

  DMB.views = DMB.views || {};
  DMB.views.finances = { title: 'Finances', render };
})(window.DMB = window.DMB || {});
