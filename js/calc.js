/*
 * Financial calculations. Pure functions over plain data — no DOM, no IndexedDB —
 * so every number on screen comes from one place and can be unit tested in Node.
 *
 * Core rule: balances are never stored. They are derived from training charges and
 * payment records every time, so they can't drift out of sync.
 */
(function (root, factory) {
  const util = (typeof module === 'object' && module.exports) ? require('./util.js') : root.DMB.util;
  const api = factory(util);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DMB = root.DMB || {}; root.DMB.calc = api; }
})(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';

  const TRAIN_TYPES = { paid: 'Paid Train', free: 'Free Train', director: 'Director Train', other: 'Other' };
  const PAYMENT_TYPES = { train: 'Train Payment', other: 'Other', refund: 'Refund' };
  const STATUSES = { active: 'Active', inactive: 'Inactive', left: 'Left' };
  const PAY_STATUS = { paid: 'Paid', partial: 'Partial', unpaid: 'Unpaid', free: 'Free' };

  // Default price suggested in the form when a train type is picked. Free/Director trains
  // start at $0 but the user can override the price on any record.
  function defaultPriceFor(trainType, settingsPrice) {
    return (trainType === 'free' || trainType === 'director') ? 0 : settingsPrice;
  }

  function chargeOf(t) { return t.trainCount * t.pricePerTrain; }

  // Delivery is tracked apart from payment: staff often pay before the director gives the
  // trains in Torn. Records saved before this field existed count as fully given.
  function trainsGiven(t) {
    return Number.isInteger(t.trainsGiven) ? Math.min(Math.max(t.trainsGiven, 0), t.trainCount) : t.trainCount;
  }
  function trainsWaiting(t) { return t.trainCount - trainsGiven(t); }

  function trainsOwed(data) {
    const byEmployee = new Map();
    for (const t of data.training) {
      const w = trainsWaiting(t);
      if (w > 0) byEmployee.set(t.employeeId, (byEmployee.get(t.employeeId) || 0) + w);
    }
    return { trains: U.sum([...byEmployee.values()], (n) => n), employees: byEmployee.size, byEmployee };
  }

  // Only train payments and refunds touch a training balance. "Other" payments are income
  // unrelated to training and are reported separately.
  function signedTrainAmount(p) {
    if (p.paymentType === 'train') return p.amount;
    if (p.paymentType === 'refund') return -p.amount;
    return 0;
  }

  const byDateThenCreated = (a, b) =>
    (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || '') < (b.createdAt || '') ? -1 : 1);

  /*
   * Allocates one employee's payments against their training charges.
   *  1. Payments linked to a training record go to that record.
   *  2. Unlinked refunds claw back from the newest paid records first.
   *  3. Unlinked payments fill the oldest outstanding records first (FIFO).
   * Any money that can't be placed is reported in `errors` — callers use this to reject a
   * change before it is saved, which is how "payment can't exceed amount owed" is enforced.
   */
  function buildLedger(trainings, payments) {
    const ordered = trainings.slice().sort(byDateThenCreated);
    const rows = new Map();
    for (const t of ordered) rows.set(t.id, { training: t, charge: chargeOf(t), paid: 0 });

    const errors = [];
    let pool = 0;
    let lastPaymentDate = null;

    for (const p of payments) {
      const amt = signedTrainAmount(p);
      if (amt === 0) continue;
      if (!lastPaymentDate || p.date > lastPaymentDate) lastPaymentDate = p.date;
      const row = p.trainingId ? rows.get(p.trainingId) : null;
      if (row) row.paid += amt;
      else pool += amt;
    }

    for (const row of rows.values()) {
      if (row.paid > row.charge) errors.push({ code: 'overpaid', trainingId: row.training.id, amount: row.paid - row.charge });
      if (row.paid < 0) errors.push({ code: 'negative', trainingId: row.training.id, amount: -row.paid });
    }

    if (pool < 0) {
      for (let i = ordered.length - 1; i >= 0 && pool < 0; i--) {
        const row = rows.get(ordered[i].id);
        const take = Math.min(Math.max(row.paid, 0), -pool);
        row.paid -= take;
        pool += take;
      }
      if (pool < 0) errors.push({ code: 'refund_exceeds_paid', amount: -pool });
    }

    if (pool > 0) {
      for (const t of ordered) {
        if (pool <= 0) break;
        const row = rows.get(t.id);
        const take = Math.min(Math.max(row.charge - row.paid, 0), pool);
        row.paid += take;
        pool -= take;
      }
      if (pool > 0) errors.push({ code: 'overpayment', amount: pool });
    }

    let charged = 0, paid = 0;
    for (const row of rows.values()) {
      row.outstanding = Math.max(row.charge - row.paid, 0);
      row.status = row.charge === 0 ? 'free' : row.paid >= row.charge ? 'paid' : row.paid > 0 ? 'partial' : 'unpaid';
      charged += row.charge;
      paid += row.paid;
    }

    return { rows, charged, paid, outstanding: Math.max(charged - paid, 0), lastPaymentDate, errors };
  }

  function ledgerForEmployee(data, employeeId) {
    return buildLedger(
      data.training.filter((t) => t.employeeId === employeeId),
      data.payments.filter((p) => p.employeeId === employeeId),
    );
  }

  // One ledger per employee plus a flat trainingId -> row lookup for tables.
  function allLedgers(data) {
    const byEmployee = new Map();
    const rows = new Map();
    const ids = new Set([...data.training.map((t) => t.employeeId), ...data.payments.map((p) => p.employeeId)]);
    for (const id of ids) {
      const ledger = ledgerForEmployee(data, id);
      byEmployee.set(id, ledger);
      for (const [tid, row] of ledger.rows) rows.set(tid, row);
    }
    return { byEmployee, rows };
  }

  function describeLedgerError(err, currency) {
    const m = U.formatMoney(err.amount, currency);
    switch (err.code) {
      case 'overpaid': return `This would pay ${m} more than that training record is worth.`;
      case 'overpayment': return `This is ${m} more than the employee owes.`;
      case 'negative': return `Refunds on that training record would exceed what was paid by ${m}.`;
      case 'refund_exceeds_paid': return `The refund is ${m} more than the employee has paid.`;
      default: return 'The payments and charges for this employee no longer balance.';
    }
  }

  // When a fully paid record's total is edited, its single linked payment should follow the
  // new total, otherwise lowering a price makes the record "overpaid". Only the unambiguous
  // case qualifies: exactly one linked payment, a train payment equal to the old total, and
  // a new total above zero (a $0 payment isn't allowed, so the user must remove it instead).
  function paidInFullPayment(oldTraining, newTotal, payments) {
    if (newTotal <= 0 || newTotal === chargeOf(oldTraining)) return null;
    const linked = payments.filter((p) => p.trainingId === oldTraining.id);
    if (linked.length !== 1) return null;
    const p = linked[0];
    return p.paymentType === 'train' && p.amount === chargeOf(oldTraining) ? p : null;
  }

  // ---------- Salary ----------
  // salaryHistory: [{effectiveFrom: 'YYYY-MM-DD', salaryPerDay}] — a new entry is added when
  // pay changes, so past salary cost keeps using the rate that applied at the time.

  function sortedSalaryHistory(emp) {
    return (emp.salaryHistory || []).slice().sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  }

  function currentSalary(emp, today) {
    const t = today || U.todayISO();
    const hist = sortedSalaryHistory(emp);
    let rate = hist.length ? hist[0].salaryPerDay : 0;
    for (const h of hist) if (h.effectiveFrom <= t) rate = h.salaryPerDay;
    return rate;
  }

  // Last day salary is counted for: their end date, or today if still employed.
  function employmentEnd(emp, today) {
    const t = today || U.todayISO();
    return emp.endDate && emp.endDate < t ? emp.endDate : t;
  }

  function isCurrentStaff(emp, today) {
    const t = today || U.todayISO();
    return emp.status !== 'left' && !(emp.endDate && emp.endDate < t);
  }

  function daysEmployed(emp, today) {
    if (!emp.startDate) return 0;
    return U.daysInclusive(emp.startDate, employmentEnd(emp, today));
  }

  // Estimated salary cost for days employed inside [range.from, range.to] (inclusive).
  // Counts both the start and end day; this is an estimate, not Torn's exact payout rules.
  function salaryCost(emp, range, today) {
    if (!emp.startDate) return 0;
    let from = emp.startDate;
    let to = employmentEnd(emp, today);
    if (range && range.from && range.from > from) from = range.from;
    if (range && range.to && range.to < to) to = range.to;
    if (from > to) return 0;

    const hist = sortedSalaryHistory(emp);
    if (!hist.length) return 0;
    let total = 0;
    for (let i = 0; i < hist.length; i++) {
      // The first rate also covers any days before its effective date.
      const segFrom = i === 0 ? from : (hist[i].effectiveFrom > from ? hist[i].effectiveFrom : from);
      const nextStart = i + 1 < hist.length ? U.addDays(hist[i + 1].effectiveFrom, -1) : to;
      const segTo = nextStart < to ? nextStart : to;
      if (segFrom <= segTo) total += U.daysInclusive(segFrom, segTo) * hist[i].salaryPerDay;
    }
    return total;
  }

  function dailySalaryBill(employees, today) {
    return U.sum(employees.filter((e) => isCurrentStaff(e, today)), (e) => currentSalary(e, today));
  }

  // ---------- Summaries ----------

  function trainingSummary(data, range, ledgers) {
    const L = ledgers || allLedgers(data);
    const s = { records: 0, trains: 0, soldTrains: 0, freeTrains: 0, paidTrains: 0, partialTrains: 0, unpaidTrains: 0, revenue: 0, collected: 0, outstanding: 0 };
    for (const t of data.training) {
      if (!U.inRange(t.date, range)) continue;
      const row = L.rows.get(t.id);
      s.records += 1;
      s.trains += t.trainCount;
      s.revenue += row.charge;
      s.collected += row.paid;
      s.outstanding += row.outstanding;
      if (row.status === 'free') s.freeTrains += t.trainCount;
      else {
        s.soldTrains += t.trainCount;
        if (row.status === 'paid') s.paidTrains += t.trainCount;
        else if (row.status === 'partial') s.partialTrains += t.trainCount;
        else s.unpaidTrains += t.trainCount;
      }
    }
    return s;
  }

  /*
   * Profit uses the "charged" basis: training revenue counts when the training is recorded,
   * whether or not it has been paid yet. Cash actually received is reported alongside as
   * `trainCash` so outstanding debt is never hidden.
   */
  function financeSummary(data, range, today) {
    const inR = (x) => U.inRange(x.date, range);
    const trainRevenue = U.sum(data.training.filter(inR), chargeOf);
    const trainCash = U.sum(data.payments.filter(inR), signedTrainAmount);
    const otherEmployeePayments = U.sum(data.payments.filter((p) => inR(p) && p.paymentType === 'other'), (p) => p.amount);
    const otherIncome = U.sum(data.income.filter(inR), (i) => i.amount);
    const salaries = U.sum(data.employees, (e) => salaryCost(e, range, today));
    const otherExpenses = U.sum(data.expenses.filter(inR), (x) => x.amount);
    const totalIncome = trainRevenue + otherIncome + otherEmployeePayments;
    const totalExpenses = salaries + otherExpenses;
    return {
      trainRevenue, trainCash, otherIncome, otherEmployeePayments, salaries, otherExpenses,
      totalIncome, totalExpenses, netProfit: totalIncome - totalExpenses,
    };
  }

  // Per-month income/expense/profit for the months covering `range` (or the last `months`).
  function monthlyFinance(data, range, today, months) {
    const t = today || U.todayISO();
    const to = (range && range.to) || t;
    let from = range && range.from;
    if (!from) {
      const [y, m] = to.split('-').map(Number);
      const d = new Date(y, m - (months || 6), 1);
      from = U.toISODate(d);
    }
    const out = [];
    let [y, m] = from.split('-').map(Number);
    const [ey, em] = to.split('-').map(Number);
    while (y < ey || (y === ey && m <= em)) {
      const first = `${y}-${String(m).padStart(2, '0')}-01`;
      const last = U.toISODate(new Date(y, m, 0));
      const r = { from: first < from ? from : first, to: last > to ? to : last };
      out.push({ month: U.monthKey(first), ...financeSummary(data, r, t) });
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }

  function employeeStats(data, emp, today, ledgers) {
    const ledger = (ledgers && ledgers.byEmployee.get(emp.id)) || ledgerForEmployee(data, emp.id);
    const trainings = data.training.filter((t) => t.employeeId === emp.id);
    let paidTrains = 0, unpaidTrains = 0, freeTrains = 0, lastTrainDate = null;
    for (const t of trainings) {
      const row = ledger.rows.get(t.id);
      if (row.status === 'free') freeTrains += t.trainCount;
      else if (row.status === 'paid') paidTrains += t.trainCount;
      else unpaidTrains += t.trainCount;
      if (!lastTrainDate || t.date > lastTrainDate) lastTrainDate = t.date;
    }
    const otherPaid = U.sum(data.payments.filter((p) => p.employeeId === emp.id && p.paymentType === 'other'), (p) => p.amount);
    const salary = salaryCost(emp, null, today);
    return {
      trainsReceived: U.sum(trainings, (t) => t.trainCount),
      trainsWaiting: U.sum(trainings, trainsWaiting),
      paidTrains, unpaidTrains, freeTrains, lastTrainDate,
      charged: ledger.charged,
      paid: ledger.paid,
      outstanding: ledger.outstanding,
      lastPaymentDate: ledger.lastPaymentDate,
      salaryCost: salary,
      daysEmployed: daysEmployed(emp, today),
      // What the company has earned from this employee's training (and other payments)
      // minus what it has cost in salary. Negative is normal for most staff.
      netValue: ledger.charged + otherPaid - salary,
    };
  }

  return {
    TRAIN_TYPES, PAYMENT_TYPES, STATUSES, PAY_STATUS,
    defaultPriceFor, chargeOf, trainsGiven, trainsWaiting, trainsOwed, signedTrainAmount, buildLedger, ledgerForEmployee, allLedgers,
    describeLedgerError, paidInFullPayment, sortedSalaryHistory, currentSalary, employmentEnd, isCurrentStaff,
    daysEmployed, salaryCost, dailySalaryBill, trainingSummary, financeSummary, monthlyFinance,
    employeeStats,
  };
});
