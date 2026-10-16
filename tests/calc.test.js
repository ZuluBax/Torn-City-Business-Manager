// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/calc.js');
const U = require('../js/util.js');

const train = (id, date, count, price, extra) => ({ id, employeeId: 'e1', date, trainCount: count, pricePerTrain: price, trainType: 'paid', createdAt: date, ...extra });
const pay = (id, date, amount, extra) => ({ id, employeeId: 'e1', date, amount, paymentType: 'train', trainingId: null, ...extra });

test('spec example: unpaid, partial, fully paid', () => {
  const t = [train('t1', '2026-01-01', 2, 420000)];
  let L = C.buildLedger(t, []);
  assert.equal(L.rows.get('t1').charge, 840000);
  assert.equal(L.outstanding, 840000);
  assert.equal(L.rows.get('t1').status, 'unpaid');

  L = C.buildLedger(t, [pay('p1', '2026-01-02', 420000)]);
  assert.equal(L.outstanding, 420000);
  assert.equal(L.rows.get('t1').status, 'partial');

  L = C.buildLedger(t, [pay('p1', '2026-01-02', 420000), pay('p2', '2026-01-03', 420000)]);
  assert.equal(L.outstanding, 0);
  assert.equal(L.rows.get('t1').status, 'paid');
  assert.equal(L.errors.length, 0);
  assert.equal(L.lastPaymentDate, '2026-01-03');
});

test('overpayment is reported as an error', () => {
  const L = C.buildLedger([train('t1', '2026-01-01', 1, 420000)], [pay('p1', '2026-01-02', 500000)]);
  assert.equal(L.errors[0].code, 'overpayment');
  assert.equal(L.errors[0].amount, 80000);
});

test('linked payment cannot exceed its own record even if employee owes more elsewhere', () => {
  const t = [train('t1', '2026-01-01', 1, 100), train('t2', '2026-01-02', 1, 100)];
  const L = C.buildLedger(t, [pay('p1', '2026-01-03', 150, { trainingId: 't1' })]);
  assert.equal(L.errors[0].code, 'overpaid');
});

test('unlinked payments fill oldest records first', () => {
  const t = [train('t2', '2026-02-01', 1, 100), train('t1', '2026-01-01', 1, 100)];
  const L = C.buildLedger(t, [pay('p1', '2026-03-01', 150)]);
  assert.equal(L.rows.get('t1').status, 'paid');
  assert.equal(L.rows.get('t2').paid, 50);
});

test('refunds reduce paid, newest first, and cannot exceed paid', () => {
  const t = [train('t1', '2026-01-01', 1, 100), train('t2', '2026-02-01', 1, 100)];
  let L = C.buildLedger(t, [pay('p1', '2026-03-01', 200), pay('r1', '2026-03-02', 50, { paymentType: 'refund' })]);
  assert.equal(L.rows.get('t1').paid, 100);
  assert.equal(L.rows.get('t2').paid, 50);
  assert.equal(L.outstanding, 50);

  L = C.buildLedger(t, [pay('p1', '2026-03-01', 20), pay('r1', '2026-03-02', 50, { paymentType: 'refund' })]);
  assert.equal(L.errors[0].code, 'refund_exceeds_paid');
});

test('free trains cost nothing and are never outstanding', () => {
  const L = C.buildLedger([train('t1', '2026-01-01', 3, 0, { trainType: 'free' })], []);
  assert.equal(L.rows.get('t1').status, 'free');
  assert.equal(L.outstanding, 0);
});

test('"other" payments do not touch training balances', () => {
  const L = C.buildLedger([train('t1', '2026-01-01', 1, 100)], [pay('p1', '2026-01-02', 999, { paymentType: 'other' })]);
  assert.equal(L.outstanding, 100);
  assert.equal(L.errors.length, 0);
});

test('salary cost uses the rate in force on each day', () => {
  const emp = {
    startDate: '2026-01-01', endDate: null, status: 'active',
    salaryHistory: [{ effectiveFrom: '2026-01-01', salaryPerDay: 1000 }, { effectiveFrom: '2026-01-11', salaryPerDay: 2000 }],
  };
  // Jan 1–10 at 1000 (10 days) + Jan 11–20 at 2000 (10 days)
  assert.equal(C.salaryCost(emp, null, '2026-01-20'), 10 * 1000 + 10 * 2000);
  assert.equal(C.salaryCost(emp, { from: '2026-01-10', to: '2026-01-11' }, '2026-01-20'), 3000);
  assert.equal(C.currentSalary(emp, '2026-01-20'), 2000);
  assert.equal(C.currentSalary(emp, '2026-01-05'), 1000);
});

test('salary stops at end date and is zero outside employment', () => {
  const emp = { startDate: '2026-01-01', endDate: '2026-01-05', status: 'left', salaryHistory: [{ effectiveFrom: '2026-01-01', salaryPerDay: 10 }] };
  assert.equal(C.salaryCost(emp, null, '2026-02-01'), 50);
  assert.equal(C.salaryCost(emp, { from: '2026-01-10', to: '2026-01-20' }, '2026-02-01'), 0);
  assert.equal(C.daysEmployed(emp, '2026-02-01'), 5);
  assert.equal(C.isCurrentStaff(emp, '2026-02-01'), false);
});

test('finance summary: net profit = income - expenses', () => {
  const data = {
    employees: [{ id: 'e1', startDate: '2026-01-01', status: 'active', salaryHistory: [{ effectiveFrom: '2026-01-01', salaryPerDay: 100 }] }],
    training: [train('t1', '2026-01-02', 1, 420000)],
    payments: [pay('p1', '2026-01-03', 200000)],
    income: [{ date: '2026-01-04', amount: 5000 }],
    expenses: [{ date: '2026-01-04', amount: 1000 }],
  };
  const f = C.financeSummary(data, { from: '2026-01-01', to: '2026-01-10' }, '2026-01-10');
  assert.equal(f.trainRevenue, 420000);
  assert.equal(f.trainCash, 200000);
  assert.equal(f.salaries, 1000);
  assert.equal(f.netProfit, 420000 + 5000 - 1000 - 1000);
});

test('parseMoney handles Torn-style shorthand and rejects junk', () => {
  assert.equal(U.parseMoney('$420,000'), 420000);
  assert.equal(U.parseMoney('420k'), 420000);
  assert.equal(U.parseMoney('1.5m'), 1500000);
  assert.ok(Number.isNaN(U.parseMoney('12.5')));
  assert.ok(Number.isNaN(U.parseMoney('abc')));
});

test('date presets', () => {
  assert.deepEqual(U.rangeFromPreset('lastMonth', null, '2026-03-15'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(U.rangeFromPreset('last7', null, '2026-03-02'), { from: '2026-02-24', to: '2026-03-02' });
  assert.equal(U.daysInclusive('2026-03-28', '2026-03-30'), 3); // spans a DST change in the UK
});

test('formatElapsed gives compact activity timer text', () => {
  assert.equal(U.formatElapsed(45000), '45s');
  assert.equal(U.formatElapsed(12 * 60000), '12m');
  assert.equal(U.formatElapsed((3 * 60 + 5) * 60000), '3h 05m');
  assert.equal(U.formatElapsed((4 * 24 + 2) * 3600000), '4d 2h');
  assert.equal(U.formatElapsed(-1), '—');
  assert.equal(U.formatElapsed(NaN), '—');
});

test('paidInFullPayment: the single full payment follows an edited total', () => {
  const t = train('t1', '2026-01-01', 5, 420000);
  const p = pay('p1', '2026-01-01', 2100000, { trainingId: 't1' });
  assert.equal(C.paidInFullPayment(t, 2000000, [p]), p);
  const edited = { ...t, pricePerTrain: 400000 };
  assert.equal(C.buildLedger([edited], [{ ...p, amount: 2000000 }]).errors.length, 0);
});

test('paidInFullPayment: leaves ambiguous or partial payments alone', () => {
  const t = train('t1', '2026-01-01', 5, 420000);
  const full = pay('p1', '2026-01-01', 2100000, { trainingId: 't1' });
  assert.equal(C.paidInFullPayment(t, 2100000, [full]), null, 'total unchanged');
  assert.equal(C.paidInFullPayment(t, 0, [full]), null, 'new total is zero');
  assert.equal(C.paidInFullPayment(t, 2000000, [pay('p1', '2026-01-01', 1000000, { trainingId: 't1' })]), null, 'part paid');
  assert.equal(C.paidInFullPayment(t, 2000000, [pay('p1', '2026-01-01', 2100000)]), null, 'not linked');
  assert.equal(C.paidInFullPayment(t, 2000000, [full, pay('p2', '2026-01-02', 1, { trainingId: 't1', paymentType: 'refund' })]), null, 'more than one linked');
});

test('removing a record and its linked payments leaves other records balanced', () => {
  const t1 = train('t1', '2026-01-01', 1, 100), t2 = train('t2', '2026-01-02', 1, 100);
  const linked = pay('p1', '2026-01-02', 100, { trainingId: 't2' });
  assert.equal(C.buildLedger([t1], []).errors.length, 0);
  // An unlinked payment that was covering t2 becomes an overpayment once t2 is gone.
  assert.equal(C.buildLedger([t1], [pay('p2', '2026-01-03', 200)]).errors[0].code, 'overpayment');
  assert.equal(C.buildLedger([t1, t2], [linked]).errors.length, 0);
});
