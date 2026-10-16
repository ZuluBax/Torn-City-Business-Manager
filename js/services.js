/*
 * Business operations: validate input, enforce the data rules, write via db.commit, and log
 * activity. Views never write to the database directly — they call these functions and show
 * any ValidationError.fields next to the matching form inputs.
 */
(function (DMB) {
  'use strict';
  const U = DMB.util, C = DMB.calc, db = DMB.db;

  class ValidationError extends Error {
    constructor(fields) {
      super(Object.values(fields)[0] || 'Please check the form.');
      this.fields = fields;
    }
  }

  const MAX_TEXT = 500;
  const MAX_BANNER_CHARS = Math.ceil(500 * 1024 * 4 / 3) + 40; // 500 KB image as base64
  const now = () => new Date().toISOString();
  const cur = () => db.settings().currency;
  const money = (n) => U.formatMoney(n, cur());
  const str = (v) => (v == null ? '' : String(v).trim());

  // Collects field errors and throws them together so the user sees every problem at once.
  function validator() {
    const errors = {};
    return {
      errors,
      add(field, msg) { if (!errors[field]) errors[field] = msg; },
      throwIfAny() { if (Object.keys(errors).length) throw new ValidationError(errors); },
    };
  }

  function requireDate(v, field, value, label) {
    if (!value) v.add(field, `${label} is required.`);
    else if (!U.isISODate(value)) v.add(field, `${label} is not a valid date.`);
  }

  function requireMoney(v, field, raw, label, { allowZero = true } = {}) {
    const n = U.parseMoney(raw);
    if (str(raw) === '') v.add(field, `${label} is required.`);
    else if (Number.isNaN(n)) v.add(field, `${label} must be a whole dollar amount (e.g. 420000 or 420k).`);
    else if (n < 0) v.add(field, `${label} cannot be negative.`);
    else if (!allowZero && n === 0) v.add(field, `${label} must be more than zero.`);
    return n;
  }

  function limitText(v, field, value, label) {
    if (value.length > MAX_TEXT) v.add(field, `${label} must be ${MAX_TEXT} characters or fewer.`);
  }

  // Re-runs the employee's ledger as it WOULD be after a change and rejects it if any money
  // can't be placed — this single check enforces every "can't pay more than owed" rule.
  function checkLedger(employeeId, training, payments, field) {
    const L = C.buildLedger(
      training.filter((t) => t.employeeId === employeeId),
      payments.filter((p) => p.employeeId === employeeId),
    );
    if (L.errors.length) throw new ValidationError({ [field]: C.describeLedgerError(L.errors[0], cur()) });
  }

  function replaceById(list, rec) {
    const out = list.filter((r) => r.id !== rec.id);
    out.push(rec);
    return out;
  }

  function employeeName(id) {
    const e = db.get('employees', id);
    return e ? e.name : 'Unknown employee';
  }

  // ---------- Employees ----------

  async function saveEmployee(input, id) {
    const existing = id ? db.get('employees', id) : null;
    if (id && !existing) throw new ValidationError({ _form: 'That employee no longer exists.' });
    const v = validator();

    const name = str(input.name);
    const tornId = str(input.tornId);
    const position = str(input.position);
    const status = str(input.status) || 'active';
    const startDate = str(input.startDate);
    const endDate = str(input.endDate) || null;

    if (!name) v.add('name', 'Employee name is required.');
    else if (name.length > 60) v.add('name', 'Name must be 60 characters or fewer.');
    if (!tornId) v.add('tornId', 'Torn ID is required.');
    else if (!/^\d{1,10}$/.test(tornId)) v.add('tornId', 'Torn ID must be a number.');
    else {
      const dupe = db.all('employees').find((e) => e.tornId === tornId && e.id !== id);
      if (dupe) v.add('tornId', `Torn ID already belongs to ${dupe.name}. Re-activate that record instead.`);
    }
    if (!position) v.add('position', 'Position is required.');
    const salary = requireMoney(v, 'salaryPerDay', input.salaryPerDay, 'Salary');
    requireDate(v, 'startDate', startDate, 'Start date');
    if (!C.STATUSES[status]) v.add('status', 'Choose a valid status.');
    if (endDate && !U.isISODate(endDate)) v.add('endDate', 'End date is not a valid date.');
    else if (endDate && startDate && endDate < startDate) v.add('endDate', 'End date cannot be before the start date.');
    if (status === 'left' && !endDate) v.add('endDate', 'Enter the date they left.');

    const workingStats = str(input.workingStats);
    const notes = str(input.notes);
    const reasonForLeaving = str(input.reasonForLeaving);
    limitText(v, 'notes', notes, 'Notes');
    limitText(v, 'workingStats', workingStats, 'Working stats');
    limitText(v, 'reasonForLeaving', reasonForLeaving, 'Reason for leaving');

    let salaryHistory = existing ? C.sortedSalaryHistory(existing) : [{ effectiveFrom: startDate, salaryPerDay: salary }];
    let salaryChanged = false;
    if (existing && !Number.isNaN(salary) && salary !== C.currentSalary(existing)) {
      const eff = str(input.salaryEffectiveFrom) || U.todayISO();
      if (!U.isISODate(eff)) v.add('salaryEffectiveFrom', 'Effective date is not valid.');
      else if (startDate && eff < startDate) v.add('salaryEffectiveFrom', 'Effective date cannot be before the start date.');
      else {
        salaryHistory = salaryHistory.filter((h) => h.effectiveFrom !== eff);
        salaryHistory.push({ effectiveFrom: eff, salaryPerDay: salary });
        salaryHistory.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
        salaryChanged = true;
      }
    }
    v.throwIfAny();

    const rec = {
      ...(existing || { id: U.uid(), createdAt: now() }),
      name, tornId, position, status, startDate, endDate, workingStats, notes, reasonForLeaving,
      salaryHistory, updatedAt: now(),
    };

    let activity;
    if (!existing) activity = { type: 'employee_added', message: `Employee added: ${name} (${position}, ${money(salary)}/day)` };
    else if (status === 'left' && existing.status !== 'left') activity = { type: 'employee_left', message: `${name} marked as left` };
    else if (salaryChanged) activity = { type: 'salary_changed', message: `Salary changed for ${name}: ${money(C.currentSalary(existing))} → ${money(salary)}/day` };
    else if (status !== existing.status) activity = { type: 'employee_updated', message: `${name} status changed to ${C.STATUSES[status]}` };
    else activity = { type: 'employee_updated', message: `Employee updated: ${name}` };

    await db.commit([{ store: 'employees', put: rec }], activity);
    return rec;
  }

  async function setEmployeeStatus(id, status, endDate) {
    const e = db.get('employees', id);
    if (!e) throw new ValidationError({ _form: 'That employee no longer exists.' });
    const input = { ...e, salaryPerDay: String(C.currentSalary(e)), status, endDate: status === 'left' ? (endDate || e.endDate || U.todayISO()) : (status === 'active' ? null : e.endDate) };
    return saveEmployee(input, id);
  }

  function employeeHasRecords(id) {
    return db.all('training').some((t) => t.employeeId === id) || db.all('payments').some((p) => p.employeeId === id);
  }

  // Permanent delete is only allowed for records with no history (e.g. a typo'd new hire).
  async function deleteEmployee(id) {
    const e = db.get('employees', id);
    if (!e) return;
    if (employeeHasRecords(id)) {
      throw new ValidationError({ _form: `${e.name} has training or payment history. Mark them as Left instead so the history is kept.` });
    }
    await db.commit([{ store: 'employees', del: id }], { type: 'employee_removed', message: `Employee removed: ${e.name}` });
  }

  // ---------- Training ----------

  async function saveTraining(input, id) {
    const existing = id ? db.get('training', id) : null;
    if (id && !existing) throw new ValidationError({ _form: 'That training record no longer exists.' });
    const v = validator();

    const employeeId = str(input.employeeId);
    const date = str(input.date);
    const trainType = str(input.trainType);
    const countRaw = str(input.trainCount);
    const trainCount = Number(countRaw);
    const notes = str(input.notes);

    if (!employeeId || !db.get('employees', employeeId)) v.add('employeeId', 'Choose an employee.');
    requireDate(v, 'date', date, 'Date');
    if (!countRaw || !Number.isInteger(trainCount)) v.add('trainCount', 'Train count must be a whole number.');
    else if (trainCount < 1) v.add('trainCount', 'Train count must be at least 1.');
    else if (trainCount > 1000) v.add('trainCount', 'Train count looks too high — check the number.');
    if (!C.TRAIN_TYPES[trainType]) v.add('trainType', 'Choose a train type.');
    const pricePerTrain = requireMoney(v, 'pricePerTrain', input.pricePerTrain, 'Price per train');
    limitText(v, 'notes', notes, 'Notes');

    // New records can take an upfront payment, which becomes a separate linked payment record.
    let upfront = 0;
    if (!existing) {
      const total = trainCount * pricePerTrain;
      if (input.paymentNow === 'full') upfront = total;
      else if (input.paymentNow === 'part') {
        upfront = requireMoney(v, 'partAmount', input.partAmount, 'Amount paid', { allowZero: false });
        if (!Number.isNaN(upfront) && Number.isFinite(total) && upfront > total) v.add('partAmount', `Amount paid cannot exceed the total of ${money(total)}.`);
      }
    }
    v.throwIfAny();

    const rec = {
      ...(existing || { id: U.uid(), createdAt: now() }),
      employeeId, date, trainCount, trainType, pricePerTrain, notes,
      totalAmount: trainCount * pricePerTrain, // snapshot for exports; calc.js always recomputes
      updatedAt: now(),
    };
    const ops = [{ store: 'training', put: rec }];
    let payments = db.all('payments');
    const followed = existing ? C.paidInFullPayment(existing, rec.totalAmount, payments) : null;
    if (followed) {
      const p = { ...followed, amount: rec.totalAmount, updatedAt: now() };
      ops.push({ store: 'payments', put: p });
      payments = replaceById(payments, p);
    }
    if (upfront > 0) {
      const p = { id: U.uid(), employeeId, trainingId: rec.id, date, amount: upfront, paymentType: 'train', notes: 'Paid when training was recorded', createdAt: now() };
      ops.push({ store: 'payments', put: p });
      payments = payments.concat(p);
    }

    const training = replaceById(db.all('training'), rec);
    checkLedger(employeeId, training, payments, existing ? 'pricePerTrain' : 'partAmount');
    if (existing && existing.employeeId !== employeeId) {
      if (payments.some((p) => p.trainingId === rec.id)) {
        throw new ValidationError({ employeeId: 'This record has payments linked to it, so its employee cannot be changed.' });
      }
      checkLedger(existing.employeeId, training, payments, 'employeeId');
    }

    const name = employeeName(employeeId);
    const what = `${trainCount} ${C.TRAIN_TYPES[trainType].toLowerCase()}${trainCount === 1 ? '' : 's'}`;
    const activity = existing
      ? { type: 'training_updated', message: `Training updated: ${name}, ${what}${followed ? `; linked payment ${money(followed.amount)} → ${money(rec.totalAmount)}` : ''}` }
      : { type: 'training_recorded', message: `Training recorded: ${name}, ${what} (${money(rec.totalAmount)})${upfront ? `, ${money(upfront)} paid` : ''}` };
    await db.commit(ops, activity);
    return rec;
  }

  async function deleteTraining(id) {
    const t = db.get('training', id);
    if (!t) return;
    // Linked payments (and refunds) only make sense against this record, so they go with it.
    const linked = db.all('payments').filter((p) => p.trainingId === id);
    const remaining = db.all('payments').filter((p) => p.trainingId !== id);
    // Unlinked payments may have been covering this record; without it they could be an overpayment.
    checkLedger(t.employeeId, db.all('training').filter((x) => x.id !== id), remaining, '_form');
    const ops = [{ store: 'training', del: id }, ...linked.map((p) => ({ store: 'payments', del: p.id }))];
    const alsoPaid = linked.length ? ` and ${linked.length} linked payment${linked.length === 1 ? '' : 's'} (${linked.map((p) => money(p.amount)).join(', ')})` : '';
    await db.commit(ops, { type: 'training_deleted', message: `Training deleted: ${employeeName(t.employeeId)}, ${t.trainCount} train(s) on ${U.formatDate(t.date)}${alsoPaid}` });
  }

  // ---------- Payments ----------

  async function savePayment(input, id) {
    const existing = id ? db.get('payments', id) : null;
    if (id && !existing) throw new ValidationError({ _form: 'That payment no longer exists.' });
    const v = validator();

    const employeeId = str(input.employeeId);
    const date = str(input.date);
    const paymentType = str(input.paymentType) || 'train';
    const trainingId = str(input.trainingId) || null;
    const notes = str(input.notes);

    if (!employeeId || !db.get('employees', employeeId)) v.add('employeeId', 'Choose an employee.');
    requireDate(v, 'date', date, 'Date');
    const amount = requireMoney(v, 'amount', input.amount, 'Amount', { allowZero: false });
    if (!C.PAYMENT_TYPES[paymentType]) v.add('paymentType', 'Choose a payment type.');
    if (trainingId) {
      const t = db.get('training', trainingId);
      if (!t || t.employeeId !== employeeId) v.add('trainingId', 'That training record belongs to a different employee.');
      if (paymentType === 'other') v.add('trainingId', '"Other" payments cannot be linked to a training record.');
    }
    limitText(v, 'notes', notes, 'Notes');
    v.throwIfAny();

    const rec = {
      ...(existing || { id: U.uid(), createdAt: now() }),
      employeeId, date, amount, paymentType, trainingId, notes, updatedAt: now(),
    };
    const payments = replaceById(db.all('payments'), rec);
    checkLedger(employeeId, db.all('training'), payments, 'amount');
    if (existing && existing.employeeId !== employeeId) checkLedger(existing.employeeId, db.all('training'), payments, 'employeeId');

    const name = employeeName(employeeId);
    const label = C.PAYMENT_TYPES[paymentType].toLowerCase();
    const activity = existing
      ? { type: 'payment_updated', message: `Payment updated: ${name}, ${money(amount)} (${label})` }
      : { type: 'payment_recorded', message: `Payment recorded: ${name}, ${money(amount)} (${label})` };
    await db.commit([{ store: 'payments', put: rec }], activity);
    return rec;
  }

  async function deletePayment(id) {
    const p = db.get('payments', id);
    if (!p) return;
    // Deleting a refund puts money back as "paid", which could now exceed what's owed.
    checkLedger(p.employeeId, db.all('training'), db.all('payments').filter((x) => x.id !== id), '_form');
    await db.commit([{ store: 'payments', del: id }], { type: 'payment_deleted', message: `Payment deleted: ${employeeName(p.employeeId)}, ${money(p.amount)}` });
  }

  // ---------- Other income / expenses ----------

  function makeLedgerEntrySaver(store, noun) {
    return async function (input, id) {
      const existing = id ? db.get(store, id) : null;
      if (id && !existing) throw new ValidationError({ _form: `That ${noun} no longer exists.` });
      const v = validator();
      const date = str(input.date);
      const description = str(input.description);
      const category = str(input.category);
      const notes = str(input.notes);
      requireDate(v, 'date', date, 'Date');
      if (!description) v.add('description', 'Description is required.');
      else if (description.length > 120) v.add('description', 'Description must be 120 characters or fewer.');
      if (!category) v.add('category', 'Choose a category.');
      const amount = requireMoney(v, 'amount', input.amount, 'Amount', { allowZero: false });
      limitText(v, 'notes', notes, 'Notes');
      v.throwIfAny();

      const rec = { ...(existing || { id: U.uid(), createdAt: now() }), date, description, category, amount, notes, updatedAt: now() };
      const verb = existing ? 'updated' : 'added';
      await db.commit([{ store, put: rec }], { type: `${store}_${verb}`, message: `${noun[0].toUpperCase() + noun.slice(1)} ${verb}: ${description} (${money(amount)})` });
      return rec;
    };
  }

  function makeLedgerEntryDeleter(store, noun) {
    return async function (id) {
      const r = db.get(store, id);
      if (!r) return;
      await db.commit([{ store, del: id }], { type: `${store}_deleted`, message: `${noun[0].toUpperCase() + noun.slice(1)} deleted: ${r.description} (${money(r.amount)})` });
    };
  }

  // ---------- Settings ----------

  function cleanList(v, field, raw, label) {
    const list = (Array.isArray(raw) ? raw : []).map(str).filter(Boolean);
    const unique = [...new Set(list.map((x) => x.toLowerCase()))];
    if (!list.length) v.add(field, `Keep at least one ${label}.`);
    else if (unique.length !== list.length) v.add(field, `Each ${label} must be unique.`);
    else if (list.some((x) => x.length > 40)) v.add(field, `Each ${label} must be 40 characters or fewer.`);
    return list;
  }

  async function saveSettings(patch) {
    const current = db.settings();
    const next = { ...current };
    const v = validator();
    const changes = [];

    if ('companyName' in patch) {
      next.companyName = str(patch.companyName);
      if (!next.companyName) v.add('companyName', 'Company name is required.');
      else if (next.companyName.length > 60) v.add('companyName', 'Company name must be 60 characters or fewer.');
    }
    if ('currency' in patch) {
      next.currency = str(patch.currency);
      if (!next.currency) v.add('currency', 'Currency symbol is required.');
      else if (next.currency.length > 3) v.add('currency', 'Use a short symbol, e.g. $.');
    }
    if ('trainPrice' in patch) {
      next.trainPrice = requireMoney(v, 'trainPrice', patch.trainPrice, 'Default train price');
    }
    if ('positions' in patch) next.positions = cleanList(v, 'positions', patch.positions, 'position');
    if ('expenseCategories' in patch) next.expenseCategories = cleanList(v, 'expenseCategories', patch.expenseCategories, 'category');
    if ('incomeCategories' in patch) next.incomeCategories = cleanList(v, 'incomeCategories', patch.incomeCategories, 'category');
    if ('theme' in patch) next.theme = patch.theme === 'light' ? 'light' : 'dark';
    if ('dashboardLayout' in patch) {
      // null = back to the default layout. Only short id strings are kept; unknown ids are
      // harmless because the dashboard ignores anything it doesn't render.
      const l = patch.dashboardLayout;
      const okId = (x) => typeof x === 'string' && /^[a-zA-Z]{1,30}$/.test(x);
      if (l === null) next.dashboardLayout = null;
      else if (!l || !Array.isArray(l.items) || l.items.length > 60
        || !l.items.every((it) => it && okId(it.id) && Number.isInteger(it.span) && it.span >= 1 && it.span <= 4
          && (it.col === undefined || (Number.isInteger(it.col) && it.col >= 1 && it.col + it.span - 1 <= 4)))) v.add('_form', 'That layout could not be saved.');
      else next.dashboardLayout = { items: l.items.map((it) => (it.col ? { id: it.id, span: it.span, col: it.col } : { id: it.id, span: it.span })) };
    }
    if ('banner' in patch) {
      // Stored inline as a data URL so it travels with backups and syncs via the Pi.
      next.banner = str(patch.banner);
      if (next.banner && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(next.banner)) v.add('banner', 'The banner must be a PNG, JPEG, WebP or GIF image.');
      else if (next.banner.length > MAX_BANNER_CHARS) v.add('banner', 'The banner image is too large (max 500 KB).');
    }
    if ('jobLimits' in patch) {
      const { limits, errors } = DMB.jobs.cleanLimits(patch.jobLimits);
      for (const [job, msg] of Object.entries(errors)) v.add(job, msg); // field names are the job names
      next.jobLimits = limits;
    }
    if ('tornApiKey' in patch) {
      next.tornApiKey = str(patch.tornApiKey);
      if (next.tornApiKey && !DMB.torn.KEY_PATTERN.test(next.tornApiKey)) v.add('tornApiKey', 'A Torn API key is 16 letters and numbers.');
    }
    v.throwIfAny();

    if (next.trainPrice !== current.trainPrice) changes.push(`default train price ${money(current.trainPrice)} → ${money(next.trainPrice)}`);
    if (next.companyName !== current.companyName) changes.push('company name');
    if (next.currency !== current.currency) changes.push('currency');
    if (JSON.stringify(next.positions) !== JSON.stringify(current.positions)) changes.push('positions');
    if (JSON.stringify(next.expenseCategories) !== JSON.stringify(current.expenseCategories)) changes.push('expense categories');
    if (JSON.stringify(next.incomeCategories) !== JSON.stringify(current.incomeCategories)) changes.push('income categories');
    if (next.theme !== current.theme) changes.push('theme');
    if (JSON.stringify(next.jobLimits) !== JSON.stringify(current.jobLimits)) changes.push('job limits');
    if ((next.banner || '') !== (current.banner || '')) changes.push(next.banner ? 'banner uploaded' : 'banner removed');
    // Never write the key itself into the activity log.
    if ((next.tornApiKey || '') !== (current.tornApiKey || '')) changes.push(next.tornApiKey ? 'Torn API key saved' : 'Torn API key removed');

    const activity = changes.length ? { type: 'settings_changed', message: `Settings changed: ${changes.join(', ')}` } : null;
    await db.commit([{ store: 'settings', put: next }], activity);
    return next;
  }

  // ---------- Torn import ----------

  /*
   * Saves the parts of a Torn import plan the user ticked, all in one transaction.
   * `pick` = { newEmployees: Set<tornId>, updates: Set<id>, gone: Set<id>, setup: boolean }.
   * The company snapshot is always stored so the dashboard can show funds / trains.
   */
  async function applyTornImport(plan, pick, snapshot) {
    const today = U.todayISO();
    const ops = [];
    const summary = [];
    const settings = { ...db.settings(), tornCompany: snapshot, tornLastSync: now() };
    if (plan.positions.length) settings.positions = [...settings.positions, ...plan.positions];

    const added = plan.newEmployees.filter((n) => pick.newEmployees.has(n.tornId));
    for (const n of added) {
      if (db.all('employees').some((e) => e.tornId === n.tornId)) continue;
      ops.push({ store: 'employees', put: {
        id: U.uid(), createdAt: now(), updatedAt: now(),
        name: n.name, tornId: n.tornId, position: n.position, status: 'active', startDate: n.startDate, endDate: null,
        workingStats: n.workingStats, notes: 'Imported from Torn.', reasonForLeaving: '',
        salaryHistory: [{ effectiveFrom: n.startDate, salaryPerDay: n.wage }],
      } });
    }
    if (added.length) summary.push(`${added.length} employee${added.length === 1 ? '' : 's'} added`);

    const updates = plan.updates.filter((u) => pick.updates.has(u.id));
    for (const u of updates) {
      const e = db.get('employees', u.id);
      if (!e) continue;
      const rec = { ...e, updatedAt: now() };
      if (u.changes.position) rec.position = u.changes.position.to;
      if (u.changes.workingStats) rec.workingStats = u.changes.workingStats.to;
      if (u.changes.status) { rec.status = 'active'; rec.endDate = null; }
      if (u.changes.wage) {
        rec.salaryHistory = C.sortedSalaryHistory(e).filter((h) => h.effectiveFrom !== today);
        rec.salaryHistory.push({ effectiveFrom: today < e.startDate ? e.startDate : today, salaryPerDay: u.changes.wage.to });
      }
      ops.push({ store: 'employees', put: rec });
    }
    if (updates.length) summary.push(`${updates.length} updated`);

    const gone = plan.gone.filter((g) => pick.gone.has(g.id));
    for (const g of gone) {
      const e = db.get('employees', g.id);
      if (!e) continue;
      ops.push({ store: 'employees', put: { ...e, status: 'left', endDate: today < e.startDate ? e.startDate : today, reasonForLeaving: e.reasonForLeaving || 'No longer in the company on Torn', updatedAt: now() } });
    }
    if (gone.length) summary.push(`${gone.length} marked as left`);

    if (plan.setup && pick.setup) {
      const s = plan.setup;
      ops.push({ store: 'expenses', put: {
        id: U.uid(), createdAt: now(), updatedAt: now(), date: s.date,
        category: settings.expenseCategories.includes('Company upgrades') ? 'Company upgrades' : settings.expenseCategories[0],
        description: 'Company setup & upgrades (from Torn)', amount: s.amount,
        notes: `Worked out from Torn company news: deposits ${money(s.deposits)} − withdrawals ${money(s.withdrawals)} − funds left ${money(s.fundsLeft)}. ${s.upgrades} upgrades: ${s.kinds.join(', ')}.`,
      } });
      settings.tornSetupImported = true;
      summary.push(`setup spend ${money(s.amount)} added`);
    }

    ops.push({ store: 'settings', put: settings });
    await db.commit(ops, { type: 'torn_import', message: `Imported from Torn: ${summary.length ? summary.join(', ') : 'company figures refreshed'}` });
    return summary;
  }

  // ---------- Payments from Torn "sent you" events ----------

  let processing = false;

  /*
   * Handles every tornEvents record still marked 'new'. Each event is committed on its own,
   * together with its status change, so an event can never be applied twice — and if two
   * devices race, the Pi refuses the second save (409) and that device simply re-reads.
   * Returns how many payments were added automatically.
   */
  async function processTornEvents() {
    if (processing) return 0;
    processing = true;
    let added = 0;
    try {
      const pending = db.all('tornEvents').filter((e) => e.status === 'new').sort((a, b) => (a.at < b.at ? -1 : 1));
      for (const ev of pending) {
        if (db.get('tornEvents', ev.id)?.status !== 'new') continue; // handled by another device meanwhile
        const data = db.snapshot();
        const c = DMB.torn.classifyMoneyEvent(ev, data);
        const date = U.toISODate(new Date(ev.at));
        const done = { ...ev, processedAt: now(), reason: c.reason || '', employeeId: c.employeeId || null, amount: c.parsed ? c.parsed.amount : null, message: c.parsed ? c.parsed.message : '' };
        const ops = [];
        let activity = null;
        try {
          if (c.action === 'pay' || c.action === 'trainAndPay') {
            let training = null;
            if (c.action === 'trainAndPay') {
              training = {
                id: U.uid(), createdAt: now(), updatedAt: now(), employeeId: c.employeeId, date,
                trainCount: c.count, trainType: 'paid', pricePerTrain: c.price, totalAmount: c.count * c.price,
                notes: 'Recorded automatically from a Torn payment.',
              };
              ops.push({ store: 'training', put: training });
            }
            const payment = {
              id: U.uid(), createdAt: now(), updatedAt: now(), employeeId: c.employeeId, trainingId: training ? training.id : null,
              date, amount: c.parsed.amount, paymentType: 'train', notes: `From Torn: "${c.parsed.message}"`, tornEventId: ev.id,
            };
            ops.push({ store: 'payments', put: payment });
            const trainingList = training ? db.all('training').concat(training) : db.all('training');
            checkLedger(c.employeeId, trainingList, db.all('payments').concat(payment), '_form');
            Object.assign(done, { status: 'applied', paymentId: payment.id, trainingId: training ? training.id : null });
            const name = employeeName(c.employeeId);
            activity = { type: 'payment_recorded', message: `Payment from Torn: ${name}, ${money(c.parsed.amount)} for ${c.count} train${c.count === 1 ? '' : 's'}${training ? ' (training recorded too)' : ''}` };
          } else {
            done.status = c.action; // 'review' or 'ignore'
          }
        } catch (err) {
          ops.length = 0;
          Object.assign(done, { status: 'review', reason: err instanceof ValidationError ? Object.values(err.fields)[0] : 'Could not record this payment.' });
        }
        ops.push({ store: 'tornEvents', put: done });
        try {
          await db.commit(ops, activity);
          if (done.status === 'applied') added += 1;
        } catch (err) {
          console.warn('Torn event not processed (will retry):', err.message);
          break; // usually a 409 after another device saved; the refreshed state retries later
        }
      }
    } finally {
      processing = false;
    }
    return added;
  }

  // Stores new "sent you" events (local mode; on the Pi the server does this itself).
  async function addTornEvents(rawEvents) {
    const known = new Set(db.all('tornEvents').map((e) => e.id));
    const ops = [];
    for (const [eid, ev] of Object.entries(rawEvents || {})) {
      const id = 'tev-' + eid;
      if (known.has(id) || !DMB.torn.isMoneyEvent(ev.event)) continue;
      ops.push({ store: 'tornEvents', put: { id, at: new Date(ev.timestamp * 1000).toISOString(), html: ev.event, status: 'new', createdAt: now() } });
    }
    if (ops.length) await db.commit(ops);
    return ops.length;
  }

  async function resolveTornEvent(id, note) {
    const ev = db.get('tornEvents', id);
    if (!ev) return;
    await db.commit([{ store: 'tornEvents', put: { ...ev, status: 'resolved', resolvedAt: now(), resolution: note || '' } }]);
  }

  DMB.services = {
    processTornEvents, addTornEvents, resolveTornEvent,
    applyTornImport,
    ValidationError,
    saveEmployee, setEmployeeStatus, deleteEmployee, employeeHasRecords,
    saveTraining, deleteTraining,
    savePayment, deletePayment,
    saveExpense: makeLedgerEntrySaver('expenses', 'expense'),
    deleteExpense: makeLedgerEntryDeleter('expenses', 'expense'),
    saveIncome: makeLedgerEntrySaver('income', 'income'),
    deleteIncome: makeLedgerEntryDeleter('income', 'income'),
    saveSettings,
  };
})(window.DMB = window.DMB || {});
