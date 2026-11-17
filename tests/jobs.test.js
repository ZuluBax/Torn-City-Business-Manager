// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const JOBS = require('../js/jobs.js');
const TYPES = require('./fixtures/torn-company-types.json').companies; // real Torn data, 17 Nov 2026

// These tests were written against the old hard-coded Music Store table. Running them
// unchanged against Torn's own Music Store data (type 23) proves nothing moved.
const J = JOBS.forTable(JOBS.fromTorn('23', TYPES['23']));

const emp = (position, workingStats) => ({ position, workingStats });

test('parseStats reads the imported format and hand-typed variants', () => {
  assert.deepEqual(J.parseStats('MAN 6,850 / INT 1,669 / END 13,146'), { MAN: 6850, INT: 1669, END: 13146 });
  assert.deepEqual(J.parseStats('end: 10, man 2000, Int=5'), { MAN: 2000, INT: 5, END: 10 });
  assert.equal(J.parseStats('MAN 100 / INT 200'), null, 'all three stats are required');
  assert.equal(J.parseStats(''), null);
  assert.equal(J.parseStats(undefined), null);
  assert.equal(J.parseStats('MAN — / INT — / END —'), null, 'dashes from missing Torn data are not zero');
});

test('JOBS stays ordered easiest first (jobFit relies on it)', () => {
  const mains = J.JOBS.map((j) => Math.max(...Object.values(j.needs)));
  assert.deepEqual(mains, [...mains].sort((a, b) => a - b));
});

test('meets the job exactly at the threshold', () => {
  const cleaner = J.findJob('Cleaner');
  assert.equal(J.meets({ MAN: 2000, INT: 0, END: 1000 }, cleaner), true);
  assert.equal(J.meets({ MAN: 1999, INT: 0, END: 1000 }, cleaner), false);
});

test('right job: meets current, nothing harder fits', () => {
  const fit = J.jobFit(emp('Cleaner', 'MAN 3,294 / INT 1,457 / END 2,277'));
  assert.equal(fit.verdict, 'right');
  assert.equal(fit.best, 'Cleaner');
  assert.deepEqual(fit.qualifies, ['Sales Apprentice', 'Cleaner']);
});

test('below stats: reports the shortfall and trains in the current job', () => {
  const fit = J.jobFit(emp('Sales Assistant', 'MAN 3,268 / INT 5,397 / END 2,918'));
  assert.equal(fit.verdict, 'below');
  assert.deepEqual(fit.current.short, { END: 582 });
  assert.equal(fit.current.trains, 15); // 582 / 40 END per train, rounded up
  assert.equal(fit.best, 'Cleaner');
});

test('a new hire below every job fits nothing yet', () => {
  const fit = J.jobFit(emp('Sales Apprentice', 'MAN 1 / INT 15 / END 28'));
  assert.equal(fit.verdict, 'below');
  assert.equal(fit.best, null);
  assert.deepEqual(fit.qualifies, []);
  assert.equal(fit.current.trains, 33); // END 972/30 → 33 beats INT 485/15 → 33
});

test('better: meets current but qualifies for a harder job', () => {
  const fit = J.jobFit(emp('Sales Apprentice', 'MAN 100 / INT 2,000 / END 4,000'));
  assert.equal(fit.verdict, 'better');
  assert.equal(fit.best, 'Sales Assistant');
});

test('unassigned or unknown positions still get a suggestion', () => {
  const fit = J.jobFit(emp('Unassigned', 'MAN 6,850 / INT 1,669 / END 13,146'));
  assert.equal(fit.verdict, 'unassigned');
  assert.equal(fit.current, null);
  assert.equal(fit.best, 'Cleaner');
});

test('position names match case-insensitively', () => {
  assert.equal(J.jobFit(emp('cleaner ', 'MAN 3,294 / INT 1,457 / END 2,277')).verdict, 'right');
});

test('no stats -> null, so the page shows a dash rather than a guess', () => {
  assert.equal(J.jobFit(emp('Cleaner', '')), null);
  assert.equal(J.jobFit(null), null);
});

test('trainsToMeet is null when the training job never raises the missing stat', () => {
  const stats = { MAN: 0, INT: 0, END: 5000 };
  assert.equal(J.trainsToMeet(stats, J.findJob('Cleaner'), J.findJob('Sales Assistant')), null);
});

test('rankForJob lists only people who meet the job, strongest main stat first', () => {
  const staff = [
    { name: 'Cleaner1', position: 'Cleaner', workingStats: 'MAN 3,294 / INT 1,457 / END 2,277' },
    { name: 'NewHire', position: 'Sales Apprentice', workingStats: 'MAN 1 / INT 15 / END 28' },
    { name: 'Strongest1', position: 'Sales Apprentice', workingStats: 'MAN 6,850 / INT 1,669 / END 13,146' },
    { name: 'NoStats', position: 'Cleaner', workingStats: '' },
    { name: 'Boss1', position: 'Supervisor', workingStats: 'MAN 4,658 / INT 7,716 / END 5,114' },
  ];
  assert.deepEqual(J.rankForJob(staff, 'Cleaner').map((r) => r.employee.name), ['Strongest1', 'Boss1', 'Cleaner1']);
  assert.deepEqual(J.rankForJob(staff, 'Trainer'), []);
});

test('rankForJob breaks a main-stat tie on the second stat', () => {
  const staff = [
    { name: 'A', workingStats: 'MAN 3,000 / INT 0 / END 1,500' },
    { name: 'B', workingStats: 'MAN 3,000 / INT 0 / END 2,500' },
  ];
  assert.deepEqual(J.rankForJob(staff, 'Cleaner').map((r) => r.employee.name), ['B', 'A']);
});

test('rankForJob returns nothing for an unknown job or no staff', () => {
  assert.deepEqual(J.rankForJob([{ workingStats: 'MAN 9 / INT 9 / END 9' }], 'Astronaut'), []);
  assert.deepEqual(J.rankForJob(undefined, 'Cleaner'), []);
});

// A sample team (stats from a real company, names made up), used to check suggestions end to end.
const TEAM = [
  { id: 'amelia', name: 'NewHire', position: 'Sales Apprentice', workingStats: 'MAN 1 / INT 15 / END 28' },
  { id: 'dex', name: 'Cleaner1', position: 'Cleaner', workingStats: 'MAN 3,294 / INT 1,457 / END 2,277' },
  { id: 'ski', name: 'Seller1', position: 'Sales Assistant', workingStats: 'MAN 3,268 / INT 5,397 / END 2,918' },
  { id: 'shy', name: 'Boss1', position: 'Supervisor', workingStats: 'MAN 4,658 / INT 7,716 / END 5,114' },
  { id: 'lulu', name: 'Strongest1', position: 'Sales Apprentice', workingStats: 'MAN 6,850 / INT 1,669 / END 13,146' },
  { id: 'noid', name: 'Spare1', position: 'Unassigned', workingStats: 'MAN 2,345 / INT 4,164 / END 2,239' },
  { id: 'nostats', name: 'NoStats', position: 'Cleaner', workingStats: '' },
];
const jobsOf = (m) => Object.fromEntries([...m].map(([id, s]) => [id, s.job]));

test('suggestJobs: the strongest gets a 1-person job, the rest drop to their next best', () => {
  const m = J.suggestJobs(TEAM, J.DEFAULT_LIMITS);
  assert.deepEqual(jobsOf(m), {
    shy: 'Sales Assistant', // meets Sales Assistant (no limit), which is harder than Cleaner
    lulu: 'Cleaner', // highest MAN of those left, so Cleaner is theirs
    dex: 'Sales Apprentice', ski: 'Sales Apprentice', noid: 'Sales Apprentice',
    amelia: null, // meets nothing yet
  });
  assert.equal(m.has('nostats'), false, 'no stats -> no suggestion rather than a guess');
  const dexLost = m.get('dex').lostTo;
  assert.equal(dexLost.length, 1);
  assert.equal(dexLost[0].job, 'Cleaner');
  assert.deepEqual(dexLost[0].takenBy.map((e) => e.name), ['Strongest1']);
});

test('suggestJobs: no limits -> everyone gets the hardest job they meet', () => {
  const m = J.suggestJobs(TEAM, {});
  assert.equal(m.get('dex').job, 'Cleaner');
  assert.equal(m.get('lulu').job, 'Cleaner');
  assert.deepEqual(m.get('dex').lostTo, []);
});

test('suggestJobs: a limit of 2 keeps the top two, and 0 closes the job', () => {
  assert.deepEqual(['lulu', 'dex', 'ski'].map((id) => J.suggestJobs(TEAM, { Cleaner: 2 }).get(id).job), ['Cleaner', 'Cleaner', 'Sales Apprentice']);
  const closed = J.suggestJobs(TEAM, { Cleaner: 0 });
  assert.equal(closed.get('lulu').job, 'Sales Apprentice');
  assert.deepEqual(closed.get('lulu').lostTo, [], 'nobody took it, so nothing was lost to anyone');
});

test('cleanLimits: blanks mean no limit, bad numbers are errors, unknown jobs are dropped', () => {
  assert.deepEqual(J.cleanLimits({ Cleaner: '1', Trainer: '', Musician: ' 3 ', Astronaut: '2', Supervisor: 0 }),
    { limits: { Cleaner: 1, Musician: 3, Supervisor: 0 }, errors: {} });
  const bad = J.cleanLimits({ Cleaner: '1.5', Trainer: '-1', Bookkeeper: '100', Musician: 'two' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['Bookkeeper', 'Cleaner', 'Musician', 'Trainer']);
  assert.deepEqual(J.cleanLimits(undefined), { limits: {}, errors: {} });
});

test('suggestJobs: a chosen job is kept, uses up the limit, and stale choices are flagged', () => {
  const p = (id, stats, chosenJob) => ({ id, name: id, position: 'Sales Apprentice', workingStats: stats, chosenJob });
  // Both meet Supervisor (limit 1) and Musician; Strong would win Musician automatically.
  const strong = p('Strong', 'MAN 9000 / INT 20000 / END 20000');
  const picky = p('Picky', 'MAN 5000 / INT 10000 / END 8000', 'Supervisor');
  const fallen = p('Fallen', 'MAN 10 / INT 600 / END 1200', 'Trainer'); // no longer meets Trainer
  const m = J.suggestJobs([strong, picky, fallen], { Supervisor: 1, Trainer: 1 });
  assert.deepEqual(m.get('Picky'), { job: 'Supervisor', lostTo: [], chosen: true });
  assert.equal(m.get('Strong').job, 'Trainer');
  assert.equal(m.get('Fallen').job, 'Sales Apprentice');
  assert.equal(m.get('Fallen').staleChoice, 'Trainer');
  // Someone who'd otherwise get Supervisor loses it to the chosen holder.
  const other = p('Other', 'MAN 10 / INT 4000 / END 7500');
  const m2 = J.suggestJobs([picky, other], { Supervisor: 1 });
  assert.equal(m2.get('Other').job, 'Bookkeeper');
  assert.deepEqual(m2.get('Other').lostTo.map((l) => [l.job, l.takenBy.map((x) => x.id)]), [['Supervisor', ['Picky']]]);
  assert.equal(J.validChoice({ chosenJob: 'Not a job', workingStats: strong.workingStats }), null);
});

// ---------- Role advisor ----------

const roleOf = (advice, name) => advice.roles.find((r) => r.job === name);
const names = (list) => list.map((x) => (x.employee || x).name);

test('adviseRoles: every job is listed, hardest first, with who fits and who holds it now', () => {
  const a = J.adviseRoles(TEAM, J.DEFAULT_LIMITS);
  assert.deepEqual(a.roles.map((r) => r.job), [...J.JOBS].reverse().map((j) => j.name));
  const cleaner = roleOf(a, 'Cleaner');
  assert.deepEqual(names(cleaner.best), ['Strongest1'], 'the suggested holder, not whoever has it on Torn');
  assert.deepEqual(names(cleaner.alsoMeets), ['Boss1', 'Cleaner1', 'Seller1', 'Spare1'], 'others who meet it, strongest MAN first');
  assert.deepEqual(names(cleaner.heldNow), ['Cleaner1', 'NoStats'], 'held now = position on Torn, stats or not');
  assert.equal(cleaner.limit, 1);
  assert.equal(roleOf(a, 'Musician').limit, null, 'no limit set -> null');
});

test('adviseRoles: nobody qualifies -> best is empty and the closest are ranked by trains', () => {
  const a = J.adviseRoles(TEAM, J.DEFAULT_LIMITS);
  const sup = roleOf(a, 'Supervisor'); // END 7,000 / INT 3,500
  assert.deepEqual(sup.best, []);
  // Strongest1 is only INT 1,831 short (80 trains at 23 INT); Boss1 END 1,886 short (41 at 46 END).
  assert.deepEqual(sup.closest.map((c) => [c.employee.name, c.trains]), [['Boss1', 41], ['Strongest1', 80]]);
  assert.deepEqual(sup.closest[0].short, { END: 1886 });
  assert.ok(sup.closest.length <= 2, 'only the nearest two, so the panel stays short');
});

test('adviseRoles: equal trains break on smaller total shortfall, then name', () => {
  const p = (name, stats) => ({ id: name, name, position: 'Sales Apprentice', workingStats: stats });
  // Musician: INT 9,000 / MAN 4,500, gains INT 48 / MAN 24. Both are 10 trains away.
  const staff = [p('Zed', 'MAN 4500 / INT 8520 / END 0'), p('Amy', 'MAN 4500 / INT 8530 / END 0'), p('Bob', 'MAN 4500 / INT 8530 / END 0')];
  assert.deepEqual(roleOf(J.adviseRoles(staff, {}), 'Musician').closest.map((c) => c.employee.name), ['Amy', 'Bob']);
});

test('adviseRoles: staff who left and staff without stats are never suggested', () => {
  const gone = { id: 'gone', name: 'Gone', status: 'left', position: 'Trainer', workingStats: 'MAN 99999 / INT 99999 / END 99999' };
  const a = J.adviseRoles([...TEAM, gone], J.DEFAULT_LIMITS);
  const trainer = roleOf(a, 'Trainer');
  assert.deepEqual(trainer.best, []);
  assert.deepEqual(trainer.heldNow, [], 'someone who left does not hold a job');
  assert.ok(!a.moves.some((m) => m.employee.id === 'gone'));
  for (const r of a.roles) assert.ok(!names(r.closest).includes('NoStats'));
  assert.ok(!a.moves.some((m) => m.employee.id === 'nostats'));
});

test('adviseRoles: moves list who should change job, hardest destination first', () => {
  const a = J.adviseRoles(TEAM, J.DEFAULT_LIMITS);
  assert.deepEqual(a.moves.map((m) => [m.employee.name, m.from, m.to, m.belowNow]), [
    ['Boss1', 'Supervisor', 'Sales Assistant', true],
    ['Strongest1', 'Sales Apprentice', 'Cleaner', false],
    ['Cleaner1', 'Cleaner', 'Sales Apprentice', false],
    ['Seller1', 'Sales Assistant', 'Sales Apprentice', true],
    ['Spare1', 'Unassigned', 'Sales Apprentice', false],
  ]);
  // NewHire meets nothing and is in Sales Apprentice: flagged, but there's nowhere to move them.
  assert.deepEqual(a.stuck.map((s) => [s.employee.name, s.job, s.trains]), [['NewHire', 'Sales Apprentice', 33]]);
});

test('adviseRoles: a chosen job is respected and marked', () => {
  const p = (id, position, stats, chosenJob) => ({ id, name: id, position, workingStats: stats, chosenJob });
  const a = J.adviseRoles([p('Picky', 'Musician', 'MAN 5000 / INT 10000 / END 8000', 'Supervisor')], J.DEFAULT_LIMITS);
  assert.deepEqual(a.moves.map((m) => [m.employee.id, m.to, m.chosen]), [['Picky', 'Supervisor', true]]);
  assert.equal(roleOf(a, 'Supervisor').best[0].id, 'Picky');
});

test('adviseRoles: empty or missing staff gives empty advice, not a crash', () => {
  const a = J.adviseRoles(undefined, undefined);
  assert.equal(a.roles.length, J.JOBS.length);
  assert.ok(a.roles.every((r) => !r.best.length && !r.closest.length && !r.heldNow.length));
  assert.deepEqual(a.moves, []);
  assert.deepEqual(a.stuck, []);
});

// ---------- Any company type (job tables built from Torn's data) ----------

// The Music Store table as it was hard-coded before 17 Nov 2026 (from the Torn wiki).
const OLD_MUSIC_STORE = [
  { name: 'Sales Apprentice', needs: { END: 1000, INT: 500 }, gains: { END: 30, INT: 15 }, special: '' },
  { name: 'Cleaner', needs: { MAN: 2000, END: 1000 }, gains: { MAN: 36, END: 18 }, special: 'Cleaner' },
  { name: 'Sales Assistant', needs: { END: 3500, INT: 1750 }, gains: { END: 40, INT: 20 }, special: '' },
  { name: 'Bookkeeper', needs: { END: 5500, INT: 2750 }, gains: { END: 44, INT: 22 }, special: 'Secretary' },
  { name: 'Supervisor', needs: { END: 7000, INT: 3500 }, gains: { END: 46, INT: 23 }, special: 'Manager' },
  { name: 'Musician', needs: { INT: 9000, MAN: 4500 }, gains: { INT: 48, MAN: 24 }, special: '' },
  { name: 'Trainer', needs: { INT: 10500, END: 5250 }, gains: { INT: 49, END: 25 }, special: 'Trainer' },
];

test('fromTorn: Music Store matches the old hard-coded table exactly, order and limits included', () => {
  const t = JOBS.fromTorn('23', TYPES['23']);
  assert.equal(t.id, 23);
  assert.equal(t.name, 'Music Store');
  assert.deepEqual(t.jobs, OLD_MUSIC_STORE);
  // Key order matters: the first need is the main stat used for ranking.
  assert.deepEqual(t.jobs.map((j) => Object.keys(j.needs)), OLD_MUSIC_STORE.map((j) => Object.keys(j.needs)));
  assert.deepEqual(J.DEFAULT_LIMITS, { Cleaner: 1, Bookkeeper: 1, Supervisor: 1, Trainer: 1 });
});

const AN = JOBS.forTable(JOBS.fromTorn('10', TYPES['10']));

test('fromTorn: Adult Novelties gets its own jobs, easiest first, one-per-company specials limited', () => {
  assert.equal(AN.table.name, 'Adult Novelties');
  assert.deepEqual(AN.JOBS.map((j) => j.name), ['Cleaner', 'Sales Assistant', 'Receptionist', 'Marketing Manager', 'Store Manager', 'Sexpert', 'HR Officer']);
  assert.deepEqual(AN.findJob('sexpert').needs, { INT: 10000, END: 5000 });
  assert.deepEqual(AN.DEFAULT_LIMITS, { Cleaner: 1, Receptionist: 1, 'Marketing Manager': 1, 'Store Manager': 1, 'HR Officer': 1 });
  assert.equal(AN.findJob('Musician'), null, 'no Music Store jobs leak in');
});

test('Adult Novelties: job fit and suggestions use the new table', () => {
  const sa = { id: 'a', name: 'A', position: 'Sales Assistant', workingStats: 'MAN 2,500 / INT 11,000 / END 6,000' };
  const fit = AN.jobFit(sa);
  assert.equal(fit.verdict, 'better');
  assert.equal(fit.best, 'Sexpert');
  assert.deepEqual(fit.qualifies, ['Cleaner', 'Sales Assistant', 'Receptionist', 'Marketing Manager', 'Sexpert']);
  assert.equal(AN.suggestJobs([sa], AN.DEFAULT_LIMITS).get('a').job, 'Sexpert');
  // A Music Store position isn't a job here, so they're "unassigned" and still get advice.
  assert.equal(AN.jobFit({ ...sa, position: 'Musician' }).verdict, 'unassigned');
});

test('fromTorn: every one of Torn\'s 39 company types builds a usable table', () => {
  const ids = Object.keys(TYPES);
  assert.equal(ids.length, 39);
  for (const id of ids) {
    const t = JOBS.fromTorn(id, TYPES[id]);
    assert.ok(t, `type ${id} built`);
    assert.equal(t.jobs.length, Object.keys(TYPES[id].positions).length, `${t.name}: no job dropped`);
    const mains = t.jobs.map((j) => Object.values(j.needs)[0]);
    assert.deepEqual(mains, [...mains].sort((a, b) => a - b), `${t.name}: easiest first`);
    for (const j of t.jobs) {
      const zero = { MAN: 0, INT: 0, END: 0 };
      assert.notEqual(JOBS.trainsToMeet(zero, j), null, `${t.name} / ${j.name}: its own training can reach it`);
    }
  }
});

test('forTable(null): no table means no jobs and no advice, never a crash', () => {
  const N = JOBS.forTable(null);
  const e = { id: 'x', name: 'X', position: 'Cleaner', workingStats: 'MAN 1 / INT 1 / END 1' };
  assert.equal(N.hasJobs, false);
  assert.deepEqual(N.JOBS, []);
  assert.deepEqual(N.DEFAULT_LIMITS, {});
  assert.equal(N.jobFit(e).verdict, 'unassigned');
  assert.equal(N.suggestJobs([e], {}).get('x').job, null);
  assert.deepEqual(N.adviseRoles([e], {}), { roles: [], moves: [], stuck: [] });
  assert.deepEqual(N.cleanLimits({ Cleaner: '1' }), { limits: {}, errors: {} });
});

test('forTable caches per table object, so a new saved table is never served stale', () => {
  const t = JOBS.fromTorn('10', TYPES['10']);
  assert.equal(JOBS.forTable(t), JOBS.forTable(t));
  assert.notEqual(JOBS.forTable(t), JOBS.forTable({ ...t }));
});

test('cleanTable: junk from a backup or another device is dropped, not trusted', () => {
  assert.equal(JOBS.cleanTable(null), null);
  assert.equal(JOBS.cleanTable({ jobs: 'nope' }), null);
  assert.equal(JOBS.cleanTable({ jobs: [] }), null, 'no usable jobs counts as no table');
  const t = JOBS.cleanTable({ id: -4, name: '', jobs: [
    { name: 'Good', needs: { MAN: 100, INT: 50 }, gains: { MAN: 5 } },
    { name: 'good', needs: { MAN: 1 } },                       // duplicate name (case-insensitive)
    { name: 'NoNeeds', needs: { MAN: 0, INT: -5 } },           // nothing usable
    { name: 'Weird', needs: { MAN: 1.5, END: 'x', INT: 2e9, LUCK: 7 } },
    { name: '', needs: { MAN: 1 } },
    null,
  ] });
  assert.deepEqual(t, { id: null, name: 'Company', jobs: [{ name: 'Good', needs: { MAN: 100, INT: 50 }, gains: { MAN: 5 }, special: '' }] });
  const many = { jobs: Array.from({ length: 50 }, (_, i) => ({ name: `J${i}`, needs: { MAN: i + 1 } })) };
  assert.equal(JOBS.cleanTable(many).jobs.length, 30, 'capped');
});

test('fromTorn: a malformed Torn entry gives null', () => {
  assert.equal(JOBS.fromTorn('1', null), null);
  assert.equal(JOBS.fromTorn('1', { name: 'X' }), null);
  assert.equal(JOBS.fromTorn('1', { name: 'X', positions: { A: { man_required: 0 } } }), null);
});
