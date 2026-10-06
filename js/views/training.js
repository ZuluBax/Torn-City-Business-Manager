(function (DMB) {
  'use strict';
  const U = DMB.util, C = DMB.calc, db = DMB.db, ui = DMB.ui, F = DMB.forms;
  const esc = U.escapeHtml;

  const filters = { q: '', preset: 'all', from: '', to: '', payStatus: '', trainType: '' };
  const PAY_FILTERS = { '': 'Any payment status', owing: 'Unpaid or partial', unpaid: 'Unpaid', partial: 'Partial', paid: 'Paid', free: 'Free' };

  function filtered(data, ledgers) {
    const range = ui.rangeOf(filters);
    const q = filters.q.trim().toLowerCase();
    return data.training.filter((t) => {
      if (!U.inRange(t.date, range)) return false;
      if (filters.trainType && t.trainType !== filters.trainType) return false;
      const row = ledgers.rows.get(t.id);
      if (filters.payStatus === 'owing' && !(row.status === 'unpaid' || row.status === 'partial')) return false;
      if (filters.payStatus && filters.payStatus !== 'owing' && row.status !== filters.payStatus) return false;
      if (q) {
        const e = db.get('employees', t.employeeId);
        if (!e || !(e.name.toLowerCase().includes(q) || e.tornId.includes(q))) return false;
      }
      return true;
    }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)));
  }

  function renderBody(el) {
    const data = db.snapshot();
    const ledgers = C.allLedgers(data);
    const range = ui.rangeOf(filters);
    const sum = C.trainingSummary(data, range, ledgers);
    const rows = filtered(data, ledgers);

    el.querySelector('[data-summary]').innerHTML = `
      ${ui.statCard({ label: 'Trains recorded', value: U.formatNumber(sum.trains), iconName: 'train', sub: `${sum.records} record${sum.records === 1 ? '' : 's'} · ${ui.rangeLabel(range)}` })}
      ${ui.statCard({ label: 'Trains sold', value: U.formatNumber(sum.soldTrains), iconName: 'tag', sub: `${sum.freeTrains} free / director` })}
      ${ui.statCard({ label: 'Paid vs unpaid', value: `${U.formatNumber(sum.paidTrains)} <span class="stat-of">/ ${U.formatNumber(sum.partialTrains + sum.unpaidTrains)}</span>`, iconName: 'check', sub: `${sum.partialTrains} part-paid · ${sum.unpaidTrains} unpaid` })}
      ${ui.statCard({ label: 'Training revenue', value: ui.money(sum.revenue), iconName: 'trend', tone: 'gold', sub: `${ui.money(sum.collected)} collected · <span class="${sum.outstanding ? 'text-red' : ''}">${ui.money(sum.outstanding)} owed</span>` })}`;

    const totals = rows.reduce((acc, t) => {
      const r = ledgers.rows.get(t.id);
      acc.trains += t.trainCount; acc.charge += r.charge; acc.paid += r.paid; acc.out += r.outstanding;
      return acc;
    }, { trains: 0, charge: 0, paid: 0, out: 0 });

    const target = el.querySelector('[data-table]');
    if (!data.training.length) {
      target.innerHTML = ui.emptyState('No training recorded yet', data.employees.length ? 'Record the first train to start tracking who owes what.' : 'Add an employee first, then record their training.',
        data.employees.length ? `<button type="button" class="btn btn-primary" data-add-empty>${ui.icon('plus')} Record training</button>` : '<a class="btn btn-primary" href="#/employees">Go to employees</a>');
      const b = target.querySelector('[data-add-empty]');
      if (b) b.addEventListener('click', () => F.trainingForm());
      return;
    }
    target.innerHTML = `<p class="result-count">${rows.length} of ${data.training.length} records</p>` + ui.table({
      rows,
      empty: 'No training records match these filters.',
      columns: [
        { label: 'Date', render: (t) => U.formatDate(t.date) },
        { label: 'Employee', render: (t) => ui.employeeLink(t.employeeId) },
        { label: 'Trains', align: 'right', render: (t) => t.trainCount },
        { label: 'Type', render: (t) => ui.trainTypeBadge(t.trainType) },
        { label: 'Price/train', align: 'right', render: (t) => ui.money(t.pricePerTrain) },
        { label: 'Total', align: 'right', render: (t) => ui.money(ledgers.rows.get(t.id).charge) },
        { label: 'Paid', align: 'right', render: (t) => ui.money(ledgers.rows.get(t.id).paid) },
        { label: 'Outstanding', align: 'right', render: (t) => { const o = ledgers.rows.get(t.id).outstanding; return o ? `<span class="text-red">${ui.money(o)}</span>` : ui.money(0); } },
        { label: 'Status', render: (t) => ui.payStatusBadge(ledgers.rows.get(t.id).status) },
        { label: 'Notes', cls: 'notes', render: (t) => esc(t.notes) },
        { label: '', cls: 'actions', render: (t) => `
          ${ledgers.rows.get(t.id).outstanding ? `<button type="button" class="icon-btn" data-pay="${esc(t.id)}" title="Record payment" aria-label="Record payment">${ui.icon('cash')}</button>` : ''}
          <button type="button" class="icon-btn" data-edit="${esc(t.id)}" title="Edit" aria-label="Edit">${ui.icon('edit')}</button>
          <button type="button" class="icon-btn icon-danger" data-del="${esc(t.id)}" title="Delete" aria-label="Delete">${ui.icon('trash')}</button>` },
      ],
      footer: ['Totals', '', U.formatNumber(totals.trains), '', '', ui.money(totals.charge), ui.money(totals.paid), ui.money(totals.out), '', '', ''],
    });
    target.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => F.trainingForm(b.dataset.edit)));
    target.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => F.confirmDeleteTraining(b.dataset.del)));
    target.querySelectorAll('[data-pay]').forEach((b) => {
      const t = db.get('training', b.dataset.pay);
      b.addEventListener('click', () => F.paymentForm(null, { employeeId: t.employeeId, trainingId: t.id }));
    });
  }

  function render(el) {
    const tc = db.settings().tornCompany;
    const trainsNote = tc ? ` Trains available on Torn: <strong>${U.formatNumber(tc.trainsAvailable)}</strong> (as of ${esc(U.formatDateTime(tc.fetchedAt))}).` : '';
    el.innerHTML = `
      ${ui.pageHeader('Training', `Who received trains, when, and whether they've paid. Default price ${ui.money(db.settings().trainPrice)}.${trainsNote}`,
        `<button type="button" class="btn btn-primary" data-add>${ui.icon('plus')} Record training</button>`)}
      <div class="stat-grid" data-summary></div>
      <div class="toolbar">
        <label class="search"><span class="sr-only">Search employee</span>${ui.icon('search')}<input type="search" data-filter="q" placeholder="Search employee…" value="${esc(filters.q)}"></label>
        ${ui.dateRangeControls(filters, 'tr')}
        <select data-filter="payStatus" aria-label="Payment status">${ui.mapOptions(PAY_FILTERS, filters.payStatus)}</select>
        <select data-filter="trainType" aria-label="Train type">${ui.mapOptions(C.TRAIN_TYPES, filters.trainType, { placeholder: 'All train types' })}</select>
      </div>
      <div data-table></div>`;
    el.querySelector('[data-add]').addEventListener('click', () => F.trainingForm());
    ui.bindFilters(el, filters, () => renderBody(el));
    renderBody(el);
  }

  DMB.views = DMB.views || {};
  DMB.views.training = { title: 'Training', render };
})(window.DMB = window.DMB || {});
