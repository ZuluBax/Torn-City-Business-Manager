/*
 * Modal forms shared across pages (e.g. "Record Train" opens the same form from the
 * Training page, the Dashboard and an employee profile).
 */
(function (DMB) {
  'use strict';
  const U = DMB.util, C = DMB.calc, db = DMB.db, S = DMB.services, ui = DMB.ui;
  const esc = U.escapeHtml;

  function moneyInputValue(n) { return typeof n === 'number' ? String(n) : ''; }
  const MONEY_HINT = 'Whole dollars. Shorthand like 420k or 1.5m works.';

  function formShell(id, inner) {
    return `<form id="${id}" class="form-grid" novalidate><p class="form-error" role="alert" hidden></p>${inner}</form>`;
  }

  function footer(formId, label) {
    return `<button type="button" class="btn btn-ghost" data-close>Cancel</button>
            <button type="submit" class="btn btn-primary" form="${formId}">${esc(label)}</button>`;
  }

  // ---------- Employee ----------

  function employeeForm(id) {
    const e = id ? db.get('employees', id) : null;
    const s = db.settings();
    const salary = e ? C.currentSalary(e) : null;
    const body = formShell('employee-form', `
      ${ui.field({ label: 'Employee name', name: 'name', value: e ? e.name : '', required: true, attrs: 'maxlength="60" autocomplete="off" autofocus' })}
      ${ui.field({ label: 'Torn ID', name: 'tornId', value: e ? e.tornId : '', required: true, attrs: 'inputmode="numeric" maxlength="10" autocomplete="off"' })}
      ${ui.field({ label: 'Position', name: 'position', type: 'select', required: true, options: ui.options(s.positions, e ? e.position : '', { placeholder: 'Select position…' }) })}
      ${ui.field({ label: `Daily salary (${s.currency})`, name: 'salaryPerDay', value: moneyInputValue(salary), required: true, hint: MONEY_HINT, attrs: 'inputmode="numeric" autocomplete="off"' })}
      ${e ? `<div class="field-full salary-effective" hidden>${ui.field({ label: 'Salary change effective from', name: 'salaryEffectiveFrom', type: 'date', value: U.todayISO(), hint: 'Earlier days keep the old rate in salary reports.' })}</div>` : ''}
      ${ui.field({ label: 'Start date', name: 'startDate', type: 'date', value: e ? e.startDate : U.todayISO(), required: true })}
      ${ui.field({ label: 'Status', name: 'status', type: 'select', required: true, options: ui.mapOptions(C.STATUSES, e ? e.status : 'active') })}
      <div class="leaving-fields field-full form-grid-inner">
        ${ui.field({ label: 'End date', name: 'endDate', type: 'date', value: e && e.endDate ? e.endDate : '', hint: 'Required when status is Left. Salary stops after this day.' })}
        ${ui.field({ label: 'Reason for leaving', name: 'reasonForLeaving', value: e ? e.reasonForLeaving : '', attrs: 'maxlength="500"' })}
      </div>
      ${ui.field({ label: 'Working stats', name: 'workingStats', type: 'textarea', value: e ? e.workingStats : '', full: true, placeholder: 'Optional — type stats exactly as you want them recorded', attrs: 'maxlength="500"' })}
      ${ui.field({ label: 'Notes', name: 'notes', type: 'textarea', value: e ? e.notes : '', full: true, attrs: 'maxlength="500"' })}
    `);

    ui.openModal({
      title: e ? `Edit ${e.name}` : 'Add employee',
      body,
      size: 'lg',
      footer: footer('employee-form', e ? 'Save changes' : 'Add employee'),
      onMount(el, close) {
        const form = el.querySelector('form');
        const status = form.elements.status;
        const endDate = form.elements.endDate;
        const leaving = form.querySelector('.leaving-fields');
        const syncLeaving = () => {
          leaving.hidden = status.value === 'active' && !endDate.value;
          if (status.value === 'left' && !endDate.value) endDate.value = U.todayISO();
        };
        status.addEventListener('change', syncLeaving);
        syncLeaving();
        if (e) {
          const eff = form.querySelector('.salary-effective');
          form.elements.salaryPerDay.addEventListener('input', () => {
            eff.hidden = U.parseMoney(form.elements.salaryPerDay.value) === salary;
          });
        }
        ui.bindSubmit(form, (data) => S.saveEmployee(data, id), {
          onSuccess(rec) { close(); ui.toast(e ? 'Employee updated' : `${rec.name} added`); },
        });
      },
    });
  }

  // ---------- Training ----------

  function trainingForm(id, { employeeId, date, trainCount, pricePerTrain, paidInFull, notes, onSaved } = {}) {
    const t = id ? db.get('training', id) : null;
    const s = db.settings();
    const type = t ? t.trainType : 'paid';
    const price = t ? t.pricePerTrain : (Number.isInteger(pricePerTrain) ? pricePerTrain : C.defaultPriceFor(type, s.trainPrice));
    const empId = t ? t.employeeId : (employeeId || '');

    const paymentSection = t ? '' : `
      <fieldset class="field field-full pay-now">
        <legend>Payment received now</legend>
        <div class="segmented">
          <label><input type="radio" name="paymentNow" value="none" ${paidInFull ? '' : 'checked'}><span>Not paid</span></label>
          <label><input type="radio" name="paymentNow" value="full" ${paidInFull ? 'checked' : ''}><span>Paid in full</span></label>
          <label><input type="radio" name="paymentNow" value="part"><span>Part paid</span></label>
        </div>
        <p class="field-hint">A matching payment record is created automatically.</p>
      </fieldset>
      <div class="field-full part-amount" hidden>${ui.field({ label: `Amount paid now (${s.currency})`, name: 'partAmount', value: '', hint: MONEY_HINT, attrs: 'inputmode="numeric" autocomplete="off"' })}</div>`;

    const body = formShell('training-form', `
      ${ui.field({ label: 'Employee', name: 'employeeId', type: 'select', required: true, options: ui.employeeOptions(empId), attrs: t ? '' : 'autofocus' })}
      ${ui.field({ label: 'Date', name: 'date', type: 'date', value: t ? t.date : (date || U.todayISO()), required: true })}
      ${ui.field({ label: 'Number of trains', name: 'trainCount', type: 'number', value: t ? t.trainCount : (trainCount || 1), required: true, attrs: 'min="1" max="1000" step="1"' })}
      ${ui.field({ label: 'Train type', name: 'trainType', type: 'select', required: true, options: ui.mapOptions(C.TRAIN_TYPES, type) })}
      ${ui.field({ label: `Price per train (${s.currency})`, name: 'pricePerTrain', value: moneyInputValue(price), required: true, hint: `Default is ${ui.money(s.trainPrice)} (change it in Settings). Free & director trains default to ${ui.money(0)}.`, attrs: 'inputmode="numeric" autocomplete="off"' })}
      <div class="field total-box"><span class="total-label">Total amount</span><span class="total-value" data-total>—</span><span class="field-hint" data-owes></span></div>
      ${paymentSection}
      ${ui.field({ label: 'Notes', name: 'notes', type: 'textarea', value: t ? t.notes : (notes || ''), full: true, attrs: 'maxlength="500"' })}
    `);

    ui.openModal({
      title: t ? 'Edit training record' : 'Record training',
      body,
      size: 'lg',
      footer: footer('training-form', t ? 'Save changes' : 'Record training'),
      onMount(el, close) {
        const form = el.querySelector('form');
        const f = form.elements;
        const totalEl = form.querySelector('[data-total]');
        const owesEl = form.querySelector('[data-owes]');
        const partWrap = form.querySelector('.part-amount');

        const update = () => {
          const count = Number(f.trainCount.value);
          const p = U.parseMoney(f.pricePerTrain.value);
          const ok = Number.isInteger(count) && count > 0 && !Number.isNaN(p) && p >= 0;
          totalEl.textContent = ok ? `${count} × ${ui.money(p)} = ${ui.money(count * p)}` : '—';
          if (f.employeeId.value) {
            const owes = C.ledgerForEmployee(db.snapshot(), f.employeeId.value).outstanding;
            owesEl.textContent = owes ? `Already owes ${ui.money(owes)} from earlier training.` : '';
          } else owesEl.textContent = '';
          if (partWrap) partWrap.hidden = !(form.querySelector('[name=paymentNow]:checked')?.value === 'part');
        };
        f.trainType.addEventListener('change', () => {
          f.pricePerTrain.value = String(C.defaultPriceFor(f.trainType.value, db.settings().trainPrice));
          update();
        });
        ['trainCount', 'pricePerTrain', 'employeeId'].forEach((n) => f[n].addEventListener('input', update));
        form.querySelectorAll('[name=paymentNow]').forEach((r) => r.addEventListener('change', update));
        update();

        ui.bindSubmit(form, (data) => S.saveTraining(data, id), {
          onSuccess(rec) { close(); ui.toast(t ? 'Training record updated' : 'Training recorded'); if (onSaved) onSaved(rec); },
        });
      },
    });
  }

  // ---------- Payment ----------

  function paymentForm(id, { employeeId, trainingId, amount, date, notes, onSaved } = {}) {
    const p = id ? db.get('payments', id) : null;
    const s = db.settings();
    const empId = p ? p.employeeId : (employeeId || '');
    const linkId = p ? p.trainingId : (trainingId || '');

    const body = formShell('payment-form', `
      ${ui.field({ label: 'Employee', name: 'employeeId', type: 'select', required: true, options: ui.employeeOptions(empId), attrs: p ? '' : 'autofocus' })}
      ${ui.field({ label: 'Date', name: 'date', type: 'date', value: p ? p.date : (date || U.todayISO()), required: true })}
      ${ui.field({ label: 'Payment type', name: 'paymentType', type: 'select', required: true, options: ui.mapOptions(C.PAYMENT_TYPES, p ? p.paymentType : 'train') })}
      ${ui.field({ label: `Amount (${s.currency})`, name: 'amount', value: p ? String(p.amount) : (amount ? String(amount) : ''), required: true, hint: MONEY_HINT, attrs: 'inputmode="numeric" autocomplete="off"' })}
      ${ui.field({ label: 'Related training record', name: 'trainingId', type: 'select', options: '', full: true, hint: 'Optional. If left blank, the payment clears the oldest unpaid training first.' })}
      <div class="field-full balance-box" data-balance></div>
      ${ui.field({ label: 'Notes', name: 'notes', type: 'textarea', value: p ? p.notes : (notes || ''), full: true, attrs: 'maxlength="500"' })}
    `);

    ui.openModal({
      title: p ? 'Edit payment' : 'Record payment',
      body,
      size: 'lg',
      footer: footer('payment-form', p ? 'Save changes' : 'Record payment'),
      onMount(el, close) {
        const form = el.querySelector('form');
        const f = form.elements;
        const balanceEl = form.querySelector('[data-balance]');

        // Ledger without this payment, so "owed" reflects what's left before it is applied.
        const ledgerExcludingSelf = (emp) => {
          const data = db.snapshot();
          return C.buildLedger(
            data.training.filter((t) => t.employeeId === emp),
            data.payments.filter((x) => x.employeeId === emp && x.id !== id),
          );
        };

        const fillTrainings = () => {
          const emp = f.employeeId.value;
          if (!emp) { f.trainingId.innerHTML = '<option value="">Select an employee first</option>'; f.trainingId.disabled = true; return; }
          const L = ledgerExcludingSelf(emp);
          const rows = [...L.rows.values()].filter((r) => r.charge > 0 && (r.outstanding > 0 || r.paid > 0 || r.training.id === linkId))
            .sort((a, b) => (a.training.date < b.training.date ? 1 : -1));
          f.trainingId.disabled = false;
          f.trainingId.innerHTML = `<option value="">Not linked — apply to oldest balance</option>` + rows.map((r) =>
            `<option value="${esc(r.training.id)}" ${r.training.id === (f.trainingId.dataset.keep || linkId) ? 'selected' : ''}>${esc(U.formatDate(r.training.date))} · ${r.training.trainCount} train(s) · ${ui.money(r.charge)} · owes ${ui.money(r.outstanding)}</option>`).join('');
        };

        const update = () => {
          const emp = f.employeeId.value;
          const isOther = f.paymentType.value === 'other';
          f.trainingId.closest('.field').hidden = isOther;
          if (isOther) f.trainingId.value = '';
          if (!emp) { balanceEl.innerHTML = ''; return; }
          const L = ledgerExcludingSelf(emp);
          const row = f.trainingId.value ? L.rows.get(f.trainingId.value) : null;
          const owed = row ? row.outstanding : L.outstanding;
          const amt = U.parseMoney(f.amount.value);
          const type = f.paymentType.value;
          let after = '';
          if (!Number.isNaN(amt) && amt > 0 && type !== 'other') {
            const next = type === 'refund' ? owed + amt : owed - amt;
            after = next < 0
              ? `<span class="text-red">${ui.money(-next)} more than is owed</span>`
              : `After this: <strong>${ui.money(next)}</strong>`;
          }
          const label = row ? 'This training record has' : 'Total outstanding';
          balanceEl.innerHTML = type === 'other'
            ? '<span class="muted">"Other" payments are recorded as other income and do not change training balances.</span>'
            : `<span>${label}: <strong>${ui.money(owed)}</strong></span>
               <span>${after}</span>
               ${owed > 0 && type === 'train' ? `<button type="button" class="btn btn-sm btn-ghost" data-fill>Pay full ${ui.money(owed)}</button>` : ''}`;
          const fill = balanceEl.querySelector('[data-fill]');
          if (fill) fill.addEventListener('click', () => { f.amount.value = String(owed); update(); });
        };

        f.employeeId.addEventListener('change', () => { f.trainingId.dataset.keep = ''; fillTrainings(); update(); });
        f.trainingId.addEventListener('change', () => { f.trainingId.dataset.keep = f.trainingId.value; update(); });
        f.paymentType.addEventListener('change', update);
        f.amount.addEventListener('input', update);
        fillTrainings();
        update();

        ui.bindSubmit(form, (data) => S.savePayment(data, id), {
          onSuccess(rec) { close(); ui.toast(p ? 'Payment updated' : 'Payment recorded'); if (onSaved) onSaved(rec); },
        });
      },
    });
  }

  // ---------- Other income / expense ----------

  function entryForm(kind, id) {
    const isExpense = kind === 'expense';
    const store = isExpense ? 'expenses' : 'income';
    const r = id ? db.get(store, id) : null;
    const s = db.settings();
    const cats = isExpense ? s.expenseCategories : s.incomeCategories;
    const formId = `${kind}-form`;
    const body = formShell(formId, `
      ${ui.field({ label: 'Date', name: 'date', type: 'date', value: r ? r.date : U.todayISO(), required: true })}
      ${ui.field({ label: 'Category', name: 'category', type: 'select', required: true, options: ui.options(cats, r ? r.category : '', { placeholder: 'Select category…' }) })}
      ${ui.field({ label: 'Description', name: 'description', value: r ? r.description : '', required: true, full: true, attrs: 'maxlength="120" autocomplete="off" autofocus' })}
      ${ui.field({ label: `Amount (${s.currency})`, name: 'amount', value: r ? String(r.amount) : '', required: true, hint: MONEY_HINT, attrs: 'inputmode="numeric" autocomplete="off"' })}
      ${ui.field({ label: 'Notes', name: 'notes', type: 'textarea', value: r ? r.notes : '', full: true, attrs: 'maxlength="500"' })}
    `);
    const noun = isExpense ? 'expense' : 'income';
    ui.openModal({
      title: `${r ? 'Edit' : 'Add'} ${isExpense ? 'expense' : 'other income'}`,
      body,
      footer: footer(formId, r ? 'Save changes' : `Add ${noun}`),
      onMount(el, close) {
        const save = isExpense ? S.saveExpense : S.saveIncome;
        ui.bindSubmit(el.querySelector('form'), (data) => save(data, id), {
          onSuccess() { close(); ui.toast(`${noun[0].toUpperCase() + noun.slice(1)} saved`); },
        });
      },
    });
  }

  // ---------- Import from Torn ----------

  function tornImport() {
    const key = db.settings().tornApiKey;
    if (!db.hasTornKey()) {
      ui.toast('Add your Torn API key in Settings first.', 'error');
      location.hash = '#/settings';
      return;
    }
    ui.openModal({
      title: 'Import from Torn',
      size: 'lg',
      body: '<div data-torn class="torn-import"><p class="muted">Fetching your company from Torn…</p></div>',
      footer: `<button type="button" class="btn btn-ghost" data-close>Cancel</button>
               <button type="button" class="btn btn-primary" data-apply disabled>Import selected</button>`,
      async onMount(el, close) {
        const box = el.querySelector('[data-torn]');
        const apply = el.querySelector('[data-apply]');
        let data;
        try {
          data = await DMB.torn.fetchCompany(key, { viaServer: db.mode === 'server' });
        } catch (err) {
          box.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
          return;
        }
        const snapshot = DMB.torn.companySnapshot(data, new Date().toISOString());
        const plan = DMB.torn.buildPlan(data, {
          employees: db.all('employees'), currentSalary: (e) => C.currentSalary(e),
          positions: db.settings().positions, setupImported: db.settings().tornSetupImported,
        });

        const check = (group, value, checked, label, sub) => `
          <label class="check-row"><input type="checkbox" data-group="${group}" value="${esc(value)}" ${checked ? 'checked' : ''}>
            <span><strong>${label}</strong>${sub ? `<span class="check-sub">${sub}</span>` : ''}</span></label>`;
        const section = (title, hint, rows) => (rows.length ? `<h3 class="subhead">${esc(title)}</h3>${hint ? `<p class="small muted">${hint}</p>` : ''}<div class="check-list">${rows.join('')}</div>` : '');

        const changeText = (c) => [
          c.position && `Position ${esc(c.position.from)} → <strong>${esc(c.position.to)}</strong>`,
          c.wage && `Wage ${ui.money(c.wage.from)} → <strong>${ui.money(c.wage.to)}</strong>/day from today`,
          c.workingStats && `Working stats → ${esc(c.workingStats.to)}`,
          c.status && 'Back in the company: <strong>re-activate</strong>',
        ].filter(Boolean).join(' · ');

        const s = plan.setup;
        box.innerHTML = `
          <div class="torn-company">
            <div><span class="muted small">Company</span><strong>${esc(snapshot.name)}</strong></div>
            <div><span class="muted small">Company funds</span><strong>${ui.money(snapshot.funds)}</strong></div>
            <div><span class="muted small">Trains available</span><strong>${U.formatNumber(snapshot.trainsAvailable)}</strong></div>
            <div><span class="muted small">Staff</span><strong>${snapshot.employeesHired}/${snapshot.employeesCapacity}</strong></div>
          </div>
          <p class="small muted">These company figures are saved to your Dashboard every time you import.</p>
          ${section('New employees', 'Start date is worked out from their days in the company.', plan.newEmployees.map((n) =>
            check('newEmployees', n.tornId, true, `${esc(n.name)} <span class="mono muted">[${esc(n.tornId)}]</span>`,
              `${esc(n.position)} · ${ui.money(n.wage)}/day · started ${U.formatDate(n.startDate)} · ${esc(n.workingStats)}`)))}
          ${section('Changes to existing employees', '', plan.updates.map((u) => check('updates', u.id, true, esc(u.name), changeText(u.changes))))}
          ${section('No longer in your Torn company', 'Tick to mark them as Left today. Their history is kept.', plan.gone.map((g) => check('gone', g.id, false, esc(g.name), `Torn ID ${esc(g.tornId)}`)))}
          ${s ? section('Money already spent', '', [check('setup', 'setup', true, `Company setup & upgrades: ${ui.money(s.amount)}`,
            `Added as one expense dated ${U.formatDate(s.date)}. Worked out as deposits ${ui.money(s.deposits)} − withdrawals ${ui.money(s.withdrawals)} − funds left ${ui.money(s.fundsLeft)}. Covers ${s.upgrades} upgrades (${esc(s.kinds.join(', '))}). The price you paid to start the company isn't in Torn's company data — add it as an expense yourself.`)]) : ''}
          ${plan.positions.length ? `<p class="small muted">New positions will be added to Settings: ${plan.positions.map(esc).join(', ')}.</p>` : ''}
          ${DMB.torn.isEmpty(plan) ? '<p class="muted">Everything already matches Torn. Importing will just refresh the company figures.</p>' : ''}`;
        apply.disabled = false;
        apply.textContent = DMB.torn.isEmpty(plan) ? 'Refresh company figures' : 'Import selected';

        apply.addEventListener('click', async () => {
          const picked = (g) => new Set([...box.querySelectorAll(`[data-group="${g}"]:checked`)].map((c) => c.value));
          apply.disabled = true;
          try {
            const summary = await S.applyTornImport(plan, { newEmployees: picked('newEmployees'), updates: picked('updates'), gone: picked('gone'), setup: picked('setup').size > 0 }, snapshot);
            close();
            ui.toast(summary.length ? `Imported: ${summary.join(', ')}` : 'Company figures refreshed');
          } catch (err) {
            console.error(err);
            ui.toast(`Import failed: ${err.message}`, 'error');
            apply.disabled = false;
          }
        });
      },
    });
  }

  // ---------- Shared delete confirmations ----------

  async function confirmDeleteTraining(id) {
    const t = db.get('training', id);
    if (!t) return;
    const ok = await ui.confirmDialog({
      title: 'Delete training record?',
      message: `This permanently deletes ${t.trainCount} train(s) for <strong>${esc(db.get('employees', t.employeeId)?.name || 'Unknown')}</strong> on ${U.formatDate(t.date)}.`,
      confirmText: 'Delete', danger: true,
    });
    if (ok) ui.runAction(() => S.deleteTraining(id), 'Training record deleted');
  }

  async function confirmDeletePayment(id) {
    const p = db.get('payments', id);
    if (!p) return;
    const ok = await ui.confirmDialog({
      title: 'Delete payment?',
      message: `This permanently deletes the ${ui.money(p.amount)} payment from <strong>${esc(db.get('employees', p.employeeId)?.name || 'Unknown')}</strong> on ${U.formatDate(p.date)}. Their balance will go back up.`,
      confirmText: 'Delete', danger: true,
    });
    if (ok) ui.runAction(() => S.deletePayment(id), 'Payment deleted');
  }

  async function confirmDeleteEntry(kind, id) {
    const store = kind === 'expense' ? 'expenses' : 'income';
    const r = db.get(store, id);
    if (!r) return;
    const ok = await ui.confirmDialog({
      title: `Delete ${kind}?`,
      message: `This permanently deletes <strong>${esc(r.description)}</strong> (${ui.money(r.amount)}).`,
      confirmText: 'Delete', danger: true,
    });
    if (ok) ui.runAction(() => (kind === 'expense' ? S.deleteExpense(id) : S.deleteIncome(id)), 'Deleted');
  }

  DMB.forms = {
    employeeForm, trainingForm, paymentForm, entryForm, tornImport,
    confirmDeleteTraining, confirmDeletePayment, confirmDeleteEntry,
  };
})(window.DMB = window.DMB || {});
