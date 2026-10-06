(function (DMB) {
  'use strict';
  const U = DMB.util, C = DMB.calc, db = DMB.db, ui = DMB.ui;
  const esc = U.escapeHtml;

  const filters = { report: 'training', preset: 'last30', from: '', to: '', employeeId: '', category: '' };

  const nameOf = (id) => (db.get('employees', id) || { name: 'Unknown' }).name;
  const empFilter = (id) => !filters.employeeId || id === filters.employeeId;

  // Each column has `html` for the screen and `csv` for export so both always match.
  const col = (label, html, csv, align) => ({ label, align, render: html, csv: csv || html });

  const REPORTS = {
    training: {
      title: 'Training revenue',
      build(data, range) {
        const ledgers = C.allLedgers(data);
        const rows = data.training.filter((t) => U.inRange(t.date, range) && empFilter(t.employeeId))
          .sort((a, b) => (a.date < b.date ? 1 : -1)).map((t) => ({ t, r: ledgers.rows.get(t.id) }));
        const tot = (fn) => U.sum(rows, fn);
        const byType = Object.entries(C.TRAIN_TYPES).map(([k, label]) => ({ label, value: U.sum(rows.filter((x) => x.t.trainType === k), (x) => x.r.charge), tone: 'gold' }));
        return {
          intro: ui.barList(byType),
          columns: [
            col('Date', (x) => U.formatDate(x.t.date), (x) => x.t.date),
            col('Employee', (x) => esc(nameOf(x.t.employeeId)), (x) => nameOf(x.t.employeeId)),
            col('Trains', (x) => x.t.trainCount, null, 'right'),
            col('Type', (x) => C.TRAIN_TYPES[x.t.trainType]),
            col('Price/train', (x) => ui.money(x.t.pricePerTrain), (x) => x.t.pricePerTrain, 'right'),
            col('Total', (x) => ui.money(x.r.charge), (x) => x.r.charge, 'right'),
            col('Paid', (x) => ui.money(x.r.paid), (x) => x.r.paid, 'right'),
            col('Outstanding', (x) => ui.money(x.r.outstanding), (x) => x.r.outstanding, 'right'),
            col('Status', (x) => ui.payStatusBadge(x.r.status), (x) => C.PAY_STATUS[x.r.status]),
          ],
          rows,
          footer: ['Total', '', tot((x) => x.t.trainCount), '', '', tot((x) => x.r.charge), tot((x) => x.r.paid), tot((x) => x.r.outstanding), ''],
          moneyCols: [5, 6, 7],
        };
      },
    },

    salary: {
      title: 'Employee salary',
      build(data, range) {
        const today = U.todayISO();
        const rows = data.employees.filter((e) => empFilter(e.id))
          .map((e) => {
            let from = e.startDate, to = C.employmentEnd(e, today);
            if (range.from && range.from > from) from = range.from;
            if (range.to && range.to < to) to = range.to;
            return { e, days: from > to ? 0 : U.daysInclusive(from, to), cost: C.salaryCost(e, range, today) };
          })
          .filter((x) => x.days > 0)
          .sort((a, b) => b.cost - a.cost);
        return {
          columns: [
            col('Employee', (x) => esc(x.e.name), (x) => x.e.name),
            col('Torn ID', (x) => esc(x.e.tornId), (x) => x.e.tornId),
            col('Position', (x) => esc(x.e.position), (x) => x.e.position),
            col('Current salary/day', (x) => ui.money(C.currentSalary(x.e, today)), (x) => C.currentSalary(x.e, today), 'right'),
            col('Days employed in period', (x) => x.days, null, 'right'),
            col('Estimated salary cost', (x) => ui.money(x.cost), (x) => x.cost, 'right'),
            col('Status', (x) => ui.statusBadge(x.e.status), (x) => C.STATUSES[x.e.status]),
          ],
          rows,
          footer: ['Total', '', '', '', U.sum(rows, (x) => x.days), U.sum(rows, (x) => x.cost), ''],
          moneyCols: [5],
          note: 'Salary is an estimate: salary per day × days employed, using the rate in force each day.',
        };
      },
    },

    outstanding: {
      title: 'Outstanding payments',
      build(data, range) {
        // Balances as they stood at the end of the period (anything dated after is ignored).
        const asOf = range.to || U.todayISO();
        const cut = { ...data, training: data.training.filter((t) => t.date <= asOf), payments: data.payments.filter((p) => p.date <= asOf) };
        const rows = data.employees.filter((e) => empFilter(e.id))
          .map((e) => ({ e, L: C.ledgerForEmployee(cut, e.id) }))
          .filter((x) => x.L.outstanding > 0)
          .sort((a, b) => b.L.outstanding - a.L.outstanding);
        return {
          intro: `<p class="muted small">Balances as of <strong>${U.formatDate(asOf)}</strong>.</p>`,
          columns: [
            col('Employee', (x) => esc(x.e.name), (x) => x.e.name),
            col('Torn ID', (x) => esc(x.e.tornId), (x) => x.e.tornId),
            col('Status', (x) => ui.statusBadge(x.e.status), (x) => C.STATUSES[x.e.status]),
            col('Amount due', (x) => ui.money(x.L.charged), (x) => x.L.charged, 'right'),
            col('Amount paid', (x) => ui.money(x.L.paid), (x) => x.L.paid, 'right'),
            col('Outstanding', (x) => `<strong class="text-red">${ui.money(x.L.outstanding)}</strong>`, (x) => x.L.outstanding, 'right'),
            col('Last payment', (x) => (x.L.lastPaymentDate ? U.formatDate(x.L.lastPaymentDate) : 'Never'), (x) => x.L.lastPaymentDate || ''),
          ],
          rows,
          footer: ['Total', '', '', U.sum(rows, (x) => x.L.charged), U.sum(rows, (x) => x.L.paid), U.sum(rows, (x) => x.L.outstanding), ''],
          moneyCols: [3, 4, 5],
        };
      },
    },

    profit: {
      title: 'Profit',
      usesCategory: true,
      build(data, range) {
        const d = filters.category
          ? { ...data, income: data.income.filter((i) => i.category === filters.category), expenses: data.expenses.filter((x) => x.category === filters.category) }
          : data;
        const r = range.from ? range : { from: earliestDate(data), to: range.to };
        const rows = C.monthlyFinance(d, r, U.todayISO(), 12).reverse();
        const total = C.financeSummary(d, range, U.todayISO());
        return {
          intro: filters.category ? `<p class="muted small">Other income / expenses limited to category <strong>${esc(filters.category)}</strong>.</p>` : '',
          columns: [
            col('Month', (m) => U.formatMonth(m.month), (m) => m.month),
            col('Training revenue', (m) => ui.money(m.trainRevenue), (m) => m.trainRevenue, 'right'),
            col('Other income', (m) => ui.money(m.otherIncome + m.otherEmployeePayments), (m) => m.otherIncome + m.otherEmployeePayments, 'right'),
            col('Salaries (est.)', (m) => ui.money(m.salaries), (m) => m.salaries, 'right'),
            col('Other expenses', (m) => ui.money(m.otherExpenses), (m) => m.otherExpenses, 'right'),
            col('Net profit', (m) => `<span class="${m.netProfit < 0 ? 'text-red' : 'text-green'}">${ui.money(m.netProfit)}</span>`, (m) => m.netProfit, 'right'),
          ],
          rows,
          footer: ['Total', total.trainRevenue, total.otherIncome + total.otherEmployeePayments, total.salaries, total.otherExpenses, total.netProfit],
          moneyCols: [1, 2, 3, 4, 5],
        };
      },
    },

    employeeTraining: {
      title: 'Employee training',
      build(data, range) {
        const ledgers = C.allLedgers(data);
        const rows = data.employees.filter((e) => empFilter(e.id)).map((e) => {
          const ts = data.training.filter((t) => t.employeeId === e.id && U.inRange(t.date, range));
          const rs = ts.map((t) => ledgers.rows.get(t.id));
          return {
            e,
            trains: U.sum(ts, (t) => t.trainCount),
            paidTrains: U.sum(ts.filter((t, i) => rs[i].status === 'paid'), (t) => t.trainCount),
            freeTrains: U.sum(ts.filter((t, i) => rs[i].status === 'free'), (t) => t.trainCount),
            charged: U.sum(rs, (r) => r.charge),
            paid: U.sum(rs, (r) => r.paid),
            outstanding: U.sum(rs, (r) => r.outstanding),
            last: ts.reduce((m, t) => (t.date > m ? t.date : m), ''),
          };
        }).filter((x) => x.trains > 0).sort((a, b) => b.trains - a.trains);
        return {
          columns: [
            col('Employee', (x) => esc(x.e.name), (x) => x.e.name),
            col('Trains', (x) => x.trains, null, 'right'),
            col('Paid trains', (x) => x.paidTrains, null, 'right'),
            col('Free trains', (x) => x.freeTrains, null, 'right'),
            col('Total spent', (x) => ui.money(x.charged), (x) => x.charged, 'right'),
            col('Paid', (x) => ui.money(x.paid), (x) => x.paid, 'right'),
            col('Outstanding', (x) => ui.money(x.outstanding), (x) => x.outstanding, 'right'),
            col('Last train', (x) => U.formatDate(x.last), (x) => x.last),
          ],
          rows,
          footer: ['Total', U.sum(rows, (x) => x.trains), U.sum(rows, (x) => x.paidTrains), U.sum(rows, (x) => x.freeTrains), U.sum(rows, (x) => x.charged), U.sum(rows, (x) => x.paid), U.sum(rows, (x) => x.outstanding), ''],
          moneyCols: [4, 5, 6],
        };
      },
    },
  };

  function earliestDate(data) {
    const dates = [...data.training, ...data.payments, ...data.income, ...data.expenses].map((x) => x.date)
      .concat(data.employees.map((e) => e.startDate)).filter(Boolean).sort();
    return dates[0] || U.todayISO();
  }

  let lastBuilt = null;

  function renderBody(el) {
    const data = db.snapshot();
    const range = ui.rangeOf(filters);
    const def = REPORTS[filters.report];
    const rep = def.build(data, range);
    lastBuilt = { def, rep, range };

    el.querySelector('[data-category]').hidden = !def.usesCategory;
    const footerHtml = rep.footer.map((v, i) => (rep.moneyCols.includes(i) && typeof v === 'number' ? ui.money(v) : (typeof v === 'number' ? U.formatNumber(v) : esc(v))));
    el.querySelector('[data-report]').innerHTML = `
      <header class="report-head">
        <div><h2>${esc(def.title)} report</h2><p class="muted small">${esc(db.settings().companyName)} · ${ui.rangeLabel(range)}${filters.employeeId ? ` · ${esc(nameOf(filters.employeeId))}` : ''}</p></div>
      </header>
      ${rep.intro || ''}
      ${ui.table({ columns: rep.columns, rows: rep.rows, footer: rep.rows.length ? footerHtml : null, empty: 'No data for this period.' })}
      ${rep.note ? `<p class="small muted">${esc(rep.note)}</p>` : ''}`;
  }

  function exportCsv() {
    if (!lastBuilt) return;
    const { def, rep, range } = lastBuilt;
    const header = rep.columns.map((c) => c.label);
    const rows = rep.rows.map((r) => rep.columns.map((c) => { const v = c.csv(r); return typeof v === 'string' ? v.replace(/<[^>]+>/g, '') : v; }));
    if (rep.rows.length) rows.push(rep.footer);
    const span = `${range.from || 'start'}_to_${range.to || U.todayISO()}`;
    ui.downloadFile(`${U.slugify(db.settings().companyName)}-${filters.report}-report_${span}.csv`, ui.toCsv(header, rows), 'text/csv;charset=utf-8');
    ui.toast(`${def.title} report exported`);
  }

  function render(el) {
    const s = db.settings();
    const cats = [...new Set([...s.incomeCategories, ...s.expenseCategories])];
    el.innerHTML = `
      ${ui.pageHeader('Reports', 'Pick a report and a date range. Export to CSV or print.', `
        <button type="button" class="btn btn-ghost" data-print>${ui.icon('printer')} Print</button>
        <button type="button" class="btn btn-primary" data-csv>${ui.icon('download')} Export CSV</button>`)}
      <div class="tabs report-tabs" role="tablist">${Object.entries(REPORTS).map(([k, r]) => `<button type="button" role="tab" class="tab ${filters.report === k ? 'active' : ''}" aria-selected="${filters.report === k}" data-report-tab="${k}">${esc(r.title)}</button>`).join('')}</div>
      <div class="toolbar">
        ${ui.dateRangeControls(filters, 'rep')}
        <select data-filter="employeeId" aria-label="Employee">${ui.employeeOptions(filters.employeeId, { placeholder: 'All employees' })}</select>
        <span data-category><select data-filter="category" aria-label="Category">${ui.options(cats, filters.category, { placeholder: 'All categories' })}</select></span>
      </div>
      <section class="panel report"><div class="panel-body" data-report></div></section>`;
    el.querySelectorAll('[data-report-tab]').forEach((b) => b.addEventListener('click', () => {
      filters.report = b.dataset.reportTab;
      el.querySelectorAll('[data-report-tab]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); });
      renderBody(el);
    }));
    el.querySelector('[data-csv]').addEventListener('click', exportCsv);
    el.querySelector('[data-print]').addEventListener('click', () => window.print());
    ui.bindFilters(el, filters, () => renderBody(el));
    renderBody(el);
  }

  DMB.views = DMB.views || {};
  DMB.views.reports = { title: 'Reports', render };
})(window.DMB = window.DMB || {});
