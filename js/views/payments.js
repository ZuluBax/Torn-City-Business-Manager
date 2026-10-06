(function (DMB) {
  'use strict';
  const U = DMB.util, C = DMB.calc, db = DMB.db, ui = DMB.ui, F = DMB.forms, S = DMB.services;
  const esc = U.escapeHtml;

  const filters = { q: '', preset: 'all', from: '', to: '', paymentType: '' };

  // Torn "sent you $" messages the app couldn't match safely; a human decides.
  function renderReview(el) {
    const items = db.all('tornEvents').filter((e) => e.status === 'review').sort((a, b) => (a.at < b.at ? 1 : -1));
    const auto = db.all('tornEvents').filter((e) => e.status === 'applied').length;
    const target = el.querySelector('[data-review]');
    if (!items.length) {
      target.innerHTML = auto ? `<p class="small muted torn-auto-note">${ui.icon('check')} ${auto} payment${auto === 1 ? '' : 's'} added automatically from Torn messages so far.</p>` : '';
      return;
    }
    target.innerHTML = ui.panel(`Payments to check (${items.length})`, `
      <p class="small muted">These came in as Torn "sent you money" messages, but something didn't add up, so they weren't added automatically.</p>
      ${ui.table({
        rows: items,
        columns: [
          { label: 'Received', render: (e) => esc(U.formatDateTime(e.at)) },
          { label: 'From', render: (e) => (e.employeeId ? ui.employeeLink(e.employeeId) : esc((DMB.torn.parseMoneyEvent(e.html) || {}).senderName || '—')) },
          { label: 'Amount', align: 'right', render: (e) => (e.amount ? ui.money(e.amount) : '—') },
          { label: 'Message', cls: 'notes', render: (e) => esc(e.message || DMB.torn.stripTags(e.html)) },
          { label: 'Why it needs checking', cls: 'notes', render: (e) => `<span class="text-amber">${esc(e.reason)}</span>` },
          { label: '', cls: 'actions', render: (e) => `
            ${e.employeeId && e.amount ? `<button type="button" class="btn btn-sm btn-primary" data-review-train="${esc(e.id)}">Training + payment</button>` : ''}
            <button type="button" class="btn btn-sm btn-ghost" data-review-pay="${esc(e.id)}">Payment only</button>
            <button type="button" class="btn btn-sm btn-ghost" data-review-dismiss="${esc(e.id)}">Dismiss</button>` },
        ],
      })}`, { cls: 'panel-review' });

    target.querySelectorAll('[data-review-pay]').forEach((b) => b.addEventListener('click', () => {
      const e = db.get('tornEvents', b.dataset.reviewPay);
      F.paymentForm(null, {
        employeeId: e.employeeId || '', amount: e.amount, date: U.toISODate(new Date(e.at)),
        notes: `From Torn: "${e.message || ''}"`,
        onSaved: () => S.resolveTornEvent(e.id, 'Recorded manually'),
      });
    }));
    // Pre-fills a paid training record: trains from the message, price = amount ÷ trains
    // when that divides evenly (so a different agreed price is respected), else today's price.
    target.querySelectorAll('[data-review-train]').forEach((b) => b.addEventListener('click', () => {
      const e = db.get('tornEvents', b.dataset.reviewTrain);
      const count = DMB.torn.trainCountFrom(e.message) || 1;
      const each = e.amount / count;
      F.trainingForm(null, {
        employeeId: e.employeeId, date: U.toISODate(new Date(e.at)), trainCount: count,
        pricePerTrain: Number.isInteger(each) ? each : db.settings().trainPrice, paidInFull: true,
        notes: `From Torn: "${e.message || ''}"`,
        onSaved: () => S.resolveTornEvent(e.id, 'Recorded manually (training + payment)'),
      });
    }));
    target.querySelectorAll('[data-review-dismiss]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await ui.confirmDialog({ title: 'Dismiss this message?', message: 'It will be removed from this list without recording a payment.', confirmText: 'Dismiss' });
      if (ok) ui.runAction(() => S.resolveTornEvent(b.dataset.reviewDismiss, 'Dismissed'), 'Dismissed');
    }));
  }

  function renderBody(el) {
    renderReview(el);
    const data = db.snapshot();
    const range = ui.rangeOf(filters);
    const q = filters.q.trim().toLowerCase();
    const rows = data.payments.filter((p) => {
      if (!U.inRange(p.date, range)) return false;
      if (filters.paymentType && p.paymentType !== filters.paymentType) return false;
      if (q) {
        const e = db.get('employees', p.employeeId);
        if (!e || !(e.name.toLowerCase().includes(q) || e.tornId.includes(q))) return false;
      }
      return true;
    }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)));

    const inRange = data.payments.filter((p) => U.inRange(p.date, range));
    const received = U.sum(inRange.filter((p) => p.paymentType === 'train'), (p) => p.amount);
    const refunds = U.sum(inRange.filter((p) => p.paymentType === 'refund'), (p) => p.amount);
    const other = U.sum(inRange.filter((p) => p.paymentType === 'other'), (p) => p.amount);
    const ledgers = C.allLedgers(data);
    const owing = [...ledgers.byEmployee.values()].filter((l) => l.outstanding > 0);
    const outstanding = U.sum(owing, (l) => l.outstanding);

    el.querySelector('[data-summary]').innerHTML = `
      ${ui.statCard({ label: 'Train payments received', value: ui.money(received), iconName: 'cash', tone: 'gold', sub: ui.rangeLabel(range) })}
      ${ui.statCard({ label: 'Refunds given', value: ui.money(refunds), iconName: 'back', sub: `Net ${ui.money(received - refunds)}` })}
      ${ui.statCard({ label: 'Other payments', value: ui.money(other), iconName: 'wallet', sub: 'Counted as other income' })}
      ${ui.statCard({ label: 'Outstanding now', value: ui.money(outstanding), iconName: 'alert', tone: outstanding ? 'red' : 'green', sub: `${owing.length} employee${owing.length === 1 ? '' : 's'} owe money` })}`;

    const target = el.querySelector('[data-table]');
    if (!data.payments.length) {
      target.innerHTML = ui.emptyState('No payments recorded yet', 'Payments employees make for training show up here.',
        data.employees.length ? `<button type="button" class="btn btn-primary" data-add-empty>${ui.icon('plus')} Record payment</button>` : '');
      const b = target.querySelector('[data-add-empty]');
      if (b) b.addEventListener('click', () => F.paymentForm());
      return;
    }
    const net = U.sum(rows, (p) => (p.paymentType === 'refund' ? -p.amount : p.amount));
    target.innerHTML = `<p class="result-count">${rows.length} of ${data.payments.length} payments</p>` + ui.table({
      rows,
      empty: 'No payments match these filters.',
      columns: [
        { label: 'Date', render: (p) => U.formatDate(p.date) },
        { label: 'Employee', render: (p) => ui.employeeLink(p.employeeId) },
        { label: 'Type', render: (p) => ui.paymentTypeBadge(p.paymentType) },
        { label: 'Amount', align: 'right', render: (p) => (p.paymentType === 'refund' ? `<span class="text-red">−${ui.money(p.amount)}</span>` : ui.money(p.amount)) },
        { label: 'For training', render: (p) => { const t = p.trainingId && db.get('training', p.trainingId); return t ? `${U.formatDate(t.date)} · ${t.trainCount} train(s)` : `<span class="muted">${p.paymentType === 'other' ? '—' : 'Oldest balance'}</span>`; } },
        { label: 'Notes', cls: 'notes', render: (p) => esc(p.notes) },
        { label: '', cls: 'actions', render: (p) => `
          <button type="button" class="icon-btn" data-edit="${esc(p.id)}" title="Edit" aria-label="Edit">${ui.icon('edit')}</button>
          <button type="button" class="icon-btn icon-danger" data-del="${esc(p.id)}" title="Delete" aria-label="Delete">${ui.icon('trash')}</button>` },
      ],
      footer: ['Net total', '', '', ui.money(net), '', '', ''],
    });
    target.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => F.paymentForm(b.dataset.edit)));
    target.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => F.confirmDeletePayment(b.dataset.del)));
  }

  function render(el) {
    el.innerHTML = `
      ${ui.pageHeader('Payments', 'Money received from employees. Balances update automatically.',
        `<button type="button" class="btn btn-primary" data-add>${ui.icon('plus')} Record payment</button>`)}
      <div data-review></div>
      <div class="stat-grid" data-summary></div>
      <div class="toolbar">
        <label class="search"><span class="sr-only">Search employee</span>${ui.icon('search')}<input type="search" data-filter="q" placeholder="Search employee…" value="${esc(filters.q)}"></label>
        ${ui.dateRangeControls(filters, 'pay')}
        <select data-filter="paymentType" aria-label="Payment type">${ui.mapOptions(C.PAYMENT_TYPES, filters.paymentType, { placeholder: 'All payment types' })}</select>
      </div>
      <div data-table></div>`;
    el.querySelector('[data-add]').addEventListener('click', () => F.paymentForm());
    ui.bindFilters(el, filters, () => renderBody(el));
    renderBody(el);
  }

  DMB.views = DMB.views || {};
  DMB.views.payments = { title: 'Payments', render };
})(window.DMB = window.DMB || {});
