/*
 * Backup export/import, demo data and full reset.
 *
 * Backup file format (JSON):
 *   { app: 'dukes-music-box', backupVersion: 1, exportedAt, data: { settings, employees, ... } }
 * `backupVersion` lets a future version migrate older files in migrate() before importing.
 */
(function (DMB) {
  'use strict';
  const U = DMB.util, C = DMB.calc, db = DMB.db;

  // Internal format tag (not shown to users). Never change it: old backups would be rejected.
  const APP_ID = 'dukes-music-box';
  const BACKUP_VERSION = 1;
  const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

  function exportBackup() {
    const payload = { app: APP_ID, backupVersion: BACKUP_VERSION, exportedAt: new Date().toISOString(), data: db.exportState() };
    const name = `${U.slugify(db.settings().companyName)}-backup-${U.todayISO()}.json`;
    DMB.ui.downloadFile(name, JSON.stringify(payload, null, 2), 'application/json');
    return name;
  }

  // Upgrades older backup formats to the current one. Add a step per version bump.
  function migrate(backup) {
    // if (backup.backupVersion === 1) { ...transform...; backup.backupVersion = 2; }
    return backup;
  }

  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const isMoney = (n) => Number.isInteger(n) && n >= 0;

  // Throws a readable Error describing the first problem found. Checks structure and the
  // links between records, then re-runs every ledger so a corrupted file can't be imported.
  function validate(raw) {
    if (!isObj(raw) || raw.app !== APP_ID) throw new Error('This is not a backup file from this app.');
    if (!Number.isInteger(raw.backupVersion) || raw.backupVersion < 1) throw new Error('Backup version is missing or invalid.');
    if (raw.backupVersion > BACKUP_VERSION) throw new Error('This backup was made by a newer version of the app. Update the app first.');
    const b = migrate(raw);
    const d = b.data;
    if (!isObj(d)) throw new Error('Backup has no data section.');
    for (const s of db.RECORD_STORES) {
      if (d[s] == null) d[s] = [];
      if (!Array.isArray(d[s])) throw new Error(`"${s}" in the backup is not a list.`);
      const ids = new Set();
      d[s].forEach((r, i) => {
        if (!isObj(r) || typeof r.id !== 'string' || !r.id) throw new Error(`Record ${i + 1} in "${s}" has no id.`);
        if (ids.has(r.id)) throw new Error(`Duplicate id in "${s}": ${r.id}`);
        ids.add(r.id);
      });
    }
    if (d.settings != null && !isObj(d.settings)) throw new Error('Settings in the backup are invalid.');

    const empIds = new Set(d.employees.map((e) => e.id));
    for (const e of d.employees) {
      if (typeof e.name !== 'string' || !e.name.trim()) throw new Error(`An employee (${e.id}) has no name.`);
      if (!C.STATUSES[e.status]) throw new Error(`Employee ${e.name} has an unknown status.`);
      if (!U.isISODate(e.startDate)) throw new Error(`Employee ${e.name} has an invalid start date.`);
      if (!Array.isArray(e.salaryHistory) || !e.salaryHistory.length || e.salaryHistory.some((h) => !U.isISODate(h.effectiveFrom) || !isMoney(h.salaryPerDay))) {
        throw new Error(`Employee ${e.name} has invalid salary history.`);
      }
    }
    const trainIds = new Set(d.training.map((t) => t.id));
    for (const t of d.training) {
      if (!empIds.has(t.employeeId)) throw new Error(`A training record (${t.id}) points to a missing employee.`);
      if (!U.isISODate(t.date) || !Number.isInteger(t.trainCount) || t.trainCount < 1 || !isMoney(t.pricePerTrain) || !C.TRAIN_TYPES[t.trainType]) {
        throw new Error(`Training record ${t.id} has invalid values.`);
      }
    }
    for (const p of d.payments) {
      if (!empIds.has(p.employeeId)) throw new Error(`A payment (${p.id}) points to a missing employee.`);
      if (p.trainingId && !trainIds.has(p.trainingId)) throw new Error(`A payment (${p.id}) points to a missing training record.`);
      if (!U.isISODate(p.date) || !isMoney(p.amount) || !C.PAYMENT_TYPES[p.paymentType]) throw new Error(`Payment ${p.id} has invalid values.`);
    }
    for (const s of ['expenses', 'income']) {
      for (const r of d[s]) {
        if (!U.isISODate(r.date) || !isMoney(r.amount)) throw new Error(`An entry in "${s}" (${r.id}) has invalid values.`);
      }
    }
    for (const e of d.employees) {
      const L = C.buildLedger(d.training.filter((t) => t.employeeId === e.id), d.payments.filter((p) => p.employeeId === e.id));
      if (L.errors.length) throw new Error(`Balances for ${e.name} don't add up: ${C.describeLedgerError(L.errors[0], (d.settings && d.settings.currency) || '$')}`);
    }
    return b;
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      if (file.size > MAX_IMPORT_BYTES) { reject(new Error('That file is too large to be a backup.')); return; }
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read the file.'));
      r.readAsText(file);
    });
  }

  async function parseBackupFile(file) {
    const text = await readFile(file);
    let raw;
    try { raw = JSON.parse(text); } catch (e) { throw new Error('The file is not valid JSON.'); }
    return validate(raw);
  }

  async function restore(backup) {
    // Backups never contain the Torn key, so carry the current one over.
    const settings = { ...(backup.data.settings || {}) };
    delete settings.tornApiKey;
    if (db.settings().tornApiKey) settings.tornApiKey = db.settings().tornApiKey;
    await db.replaceAll({ ...backup.data, settings }, { type: 'backup_imported', message: `Backup imported (exported ${U.formatDateTime(backup.exportedAt)})` });
  }

  async function resetAll() {
    await db.replaceAll({}, { type: 'data_reset', message: 'All data was reset' }, { clearSecrets: true });
  }

  // ---------- Demo data ----------
  // Every demo record carries isDemo: true so it can be removed without touching real data.

  function hasDemo() {
    return db.RECORD_STORES.some((s) => s !== 'activity' && db.all(s).some((r) => r.isDemo));
  }

  function buildDemo(trainPrice) {
    const t = U.todayISO();
    const d = (n) => U.addDays(t, n);
    const now = new Date().toISOString();
    const mk = (extra) => ({ id: U.uid(), isDemo: true, createdAt: now, updatedAt: now, ...extra });

    const emp = (name, tornId, position, salary, start, status, extra) => mk({
      name, tornId, position, status, startDate: start, endDate: null, workingStats: '', notes: 'Demo record — safe to remove.',
      reasonForLeaving: '', salaryHistory: [{ effectiveFrom: start, salaryPerDay: salary }], ...extra,
    });
    const e1 = emp('[DEMO] Alex Example', '9000001', 'Supervisor', 45000, d(-90), 'active', {
      salaryHistory: [{ effectiveFrom: d(-90), salaryPerDay: 35000 }, { effectiveFrom: d(-30), salaryPerDay: 45000 }],
    });
    const e2 = emp('[DEMO] Sam Placeholder', '9000002', 'Sales Assistant', 25000, d(-60), 'active');
    const e3 = emp('[DEMO] Jo Testcase', '9000003', 'Musician', 30000, d(-40), 'inactive');
    const e4 = emp('[DEMO] Riley Sample', '9000004', 'Cleaner', 15000, d(-120), 'left', { endDate: d(-50), reasonForLeaving: 'Demo: moved company' });
    const employees = [e1, e2, e3, e4];

    const tr = (e, date, count, type, price) => mk({ employeeId: e.id, date, trainCount: count, trainType: type, pricePerTrain: price, totalAmount: count * price, notes: '' });
    const t1 = tr(e1, d(-45), 2, 'paid', trainPrice);
    const t2 = tr(e2, d(-20), 3, 'paid', trainPrice);
    const t3 = tr(e3, d(-10), 1, 'paid', trainPrice);
    const t4 = tr(e1, d(-5), 1, 'director', 0);
    const t5 = tr(e2, d(-2), 1, 'free', 0);
    const training = [t1, t2, t3, t4, t5];

    const pay = (e, t, date, amount, type) => mk({ employeeId: e.id, trainingId: t ? t.id : null, date, amount, paymentType: type || 'train', notes: '' });
    const payments = [
      pay(e1, t1, d(-45), 2 * trainPrice),
      pay(e2, null, d(-15), trainPrice),
      pay(e3, t3, d(-8), Math.round(trainPrice / 2)),
    ];

    const expenses = [
      mk({ date: d(-25), category: 'Advertising', description: '[DEMO] Newspaper advert', amount: 2500000, notes: '' }),
      mk({ date: d(-3), category: 'Stock', description: '[DEMO] Stock top-up', amount: 1200000, notes: '' }),
    ];
    const income = [mk({ date: d(-12), category: 'Other sales', description: '[DEMO] Private event booking', amount: 3000000, notes: '' })];
    return { employees, training, payments, expenses, income };
  }

  async function loadDemo() {
    if (hasDemo()) throw new Error('Demo data is already loaded.');
    const demo = buildDemo(db.settings().trainPrice);
    const clash = demo.employees.find((e) => db.all('employees').some((x) => x.tornId === e.tornId));
    if (clash) throw new Error(`Torn ID ${clash.tornId} is already used by a real employee.`);
    const ops = [];
    for (const [store, list] of Object.entries(demo)) list.forEach((r) => ops.push({ store, put: r }));
    await db.commit(ops, { type: 'demo_loaded', message: 'Demo data loaded' });
  }

  async function removeDemo() {
    const demoEmpIds = new Set(db.all('employees').filter((e) => e.isDemo).map((e) => e.id));
    const tangled = [...db.all('training'), ...db.all('payments')].find((r) => !r.isDemo && demoEmpIds.has(r.employeeId));
    if (tangled) throw new Error('Some real training or payment records belong to a demo employee. Move or delete them first.');
    const ops = [];
    for (const store of ['employees', 'training', 'payments', 'expenses', 'income']) {
      db.all(store).filter((r) => r.isDemo).forEach((r) => ops.push({ store, del: r.id }));
    }
    if (!ops.length) return 0;
    await db.commit(ops, { type: 'demo_removed', message: 'Demo data removed' });
    return ops.length;
  }

  DMB.backup = { exportBackup, parseBackupFile, restore, resetAll, loadDemo, removeDemo, hasDemo, BACKUP_VERSION };
})(window.DMB = window.DMB || {});
