// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const J = require('../js/jobs.js');

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
