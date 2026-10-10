// Run with: node --test tests/*.test.js — uses a made-up company, never the real API.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/torn.js');
const C = require('../js/calc.js');

const ts = (iso) => Date.parse(iso + 'T12:00:00Z') / 1000;
function company(overrides) {
  return {
    company: { ID: 1, name: 'Test Co', director: 99, employees_hired: 3, employees_capacity: 9, daily_income: 0, weekly_income: 0, days_old: 0 },
    company_detailed: { company_funds: 1000, trains_available: 2, advertising_budget: 0, popularity: 0, efficiency: 0, environment: 0 },
    company_employees: {
      111: { name: 'Alpha', position: 'Cleaner', days_in_company: 3, wage: 5000, manual_labor: 10, intelligence: 20, endurance: 30 },
      222: { name: 'Bravo', position: 'Musician', days_in_company: 0, wage: 0, manual_labor: 1, intelligence: 2, endurance: 3 },
    },
    news: {
      a: { news: '<a href="#">Boss</a> started the Music Store company.', timestamp: ts('2026-10-01') },
      b: { news: 'Boss has made a deposit of $10,000 to the company funds', timestamp: ts('2026-10-01') },
      c: { news: 'Boss has upgraded the Staff Room to a Small staff room', timestamp: ts('2026-10-01') },
      d: { news: 'Boss has withdrawn $500 from the company funds', timestamp: ts('2026-10-02') },
    },
    ...overrides,
  };
}
const existing = (employees, extra) => ({ employees, currentSalary: (e) => C.currentSalary(e, '2026-10-06'), positions: ['Cleaner'], setupImported: false, ...extra });
const emp = (tornId, extra) => ({ id: 'e' + tornId, tornId, name: 'X', position: 'Cleaner', status: 'active', startDate: '2026-10-01', workingStats: '', salaryHistory: [{ effectiveFrom: '2026-10-01', salaryPerDay: 5000 }], ...extra });

test('new employees get start date from days in company, wage and stats', () => {
  const plan = T.buildPlan(company(), existing([]), { today: '2026-10-06' });
  assert.equal(plan.newEmployees.length, 2);
  const a = plan.newEmployees.find((n) => n.tornId === '111');
  assert.equal(a.startDate, '2026-10-03');
  assert.equal(a.wage, 5000);
  assert.equal(a.workingStats, 'MAN 10 / INT 20 / END 30');
  assert.deepEqual(plan.positions, ['Musician']);
});

test('existing employees are matched by Torn ID and only real changes are listed', () => {
  const plan = T.buildPlan(company(), existing([emp('111', { workingStats: 'MAN 10 / INT 20 / END 30' }), emp('222', { position: 'Cleaner' })]), { today: '2026-10-06' });
  assert.equal(plan.newEmployees.length, 0);
  assert.equal(plan.updates.length, 1);
  const u = plan.updates[0];
  assert.equal(u.tornId, '222');
  assert.deepEqual(u.changes.position, { from: 'Cleaner', to: 'Musician' });
  assert.deepEqual(u.changes.wage, { from: 5000, to: 0 });
});

test('staff missing from Torn are offered as "gone" (but never demo records)', () => {
  const plan = T.buildPlan(company(), existing([emp('333'), emp('9000001', { isDemo: true }), emp('444', { status: 'left' })]), { today: '2026-10-06' });
  assert.deepEqual(plan.gone.map((g) => g.tornId), ['333']);
});

test('setup spend = deposits - withdrawals - funds left, dated the founding day', () => {
  const s = T.buildPlan(company(), existing([])).setup;
  assert.equal(s.amount, 10000 - 500 - 1000);
  assert.equal(s.date, '2026-10-01');
  assert.deepEqual(s.kinds, ['Staff Room']);
});

test('setup spend is not offered when the maths would be unreliable or already imported', () => {
  assert.equal(T.buildPlan(company({ company: { ...company().company, weekly_income: 5 } }), existing([])).setup, null);
  const noFounding = company();
  delete noFounding.news.a;
  assert.equal(T.buildPlan(noFounding, existing([])).setup, null);
  assert.equal(T.buildPlan(company(), existing([], { setupImported: true })).setup, null);
});

test('snapshot keeps each employee\'s last action time, skipping missing or bad ones', () => {
  const data = company();
  data.company_employees[111].last_action = { status: 'Idle', timestamp: 1759700000, relative: '9 minutes ago' };
  data.company_employees[222].last_action = { status: 'Offline', timestamp: 'soon' };
  const snap = T.companySnapshot(data, '2026-10-06T12:00:00Z');
  assert.deepEqual(snap.lastActive, { 111: { at: 1759700000000, status: 'Idle' } });
});

test('fetchEvents explains a Cloudflare 429 instead of failing to parse HTML', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ status: 429, ok: false, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  try {
    await assert.rejects(T.fetchEvents('A'.repeat(16)), /Too many requests/);
  } finally {
    global.fetch = realFetch;
  }
});
