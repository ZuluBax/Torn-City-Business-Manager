/*
 * Music Store job fit: compares an employee's working stats with each position's
 * recommended stats. Pure (no DOM, no network) so it is unit tested in Node.
 *
 * Requirements come from https://wiki.torn.com/wiki/Music_Store (checked 2026-10-10).
 * Torn calls them "recommended": staff below them still work, just less efficiently.
 * If Torn changes the table, update JOBS here — nothing else hard-codes these numbers.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DMB = root.DMB || {}; root.DMB.jobs = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Ordered easiest → hardest (by main-stat requirement); jobFit() relies on this order.
  // gains = stats added per train while in that job (used to estimate trains needed).
  const JOBS = [
    { name: 'Sales Apprentice', needs: { END: 1000, INT: 500 }, gains: { END: 30, INT: 15 }, special: '' },
    { name: 'Cleaner', needs: { MAN: 2000, END: 1000 }, gains: { MAN: 36, END: 18 }, special: 'Cleaner' },
    { name: 'Sales Assistant', needs: { END: 3500, INT: 1750 }, gains: { END: 40, INT: 20 }, special: '' },
    { name: 'Bookkeeper', needs: { END: 5500, INT: 2750 }, gains: { END: 44, INT: 22 }, special: 'Secretary' },
    { name: 'Supervisor', needs: { END: 7000, INT: 3500 }, gains: { END: 46, INT: 23 }, special: 'Manager' },
    { name: 'Musician', needs: { INT: 9000, MAN: 4500 }, gains: { INT: 48, MAN: 24 }, special: '' },
    { name: 'Trainer', needs: { INT: 10500, END: 5250 }, gains: { INT: 49, END: 25 }, special: 'Trainer' },
  ];
  const byName = new Map(JOBS.map((j) => [j.name.toLowerCase(), j]));
  const STAT_KEYS = ['MAN', 'INT', 'END'];

  // "MAN 6,850 / INT 1,669 / END 13,146" -> { MAN: 6850, INT: 1669, END: 13146 }.
  // Working stats can also be typed by hand, so accept any order, "MAN: 6850", and
  // missing commas. Returns null unless all three are present, rather than guess.
  function parseStats(text) {
    const out = {};
    const re = /\b(MAN|INT|END)\b\s*[:=]?\s*([\d,]+)/gi;
    let m;
    while ((m = re.exec(String(text || '')))) out[m[1].toUpperCase()] = Number(m[2].replace(/,/g, ''));
    return STAT_KEYS.every((k) => Number.isFinite(out[k])) ? out : null;
  }

  const findJob = (name) => byName.get(String(name || '').trim().toLowerCase()) || null;

  // { END: 582 } = how far short of each requirement; empty object when they meet it.
  function shortfall(stats, job) {
    const out = {};
    for (const [k, min] of Object.entries(job.needs)) if (stats[k] < min) out[k] = min - stats[k];
    return out;
  }

  const meets = (stats, job) => Object.keys(shortfall(stats, job)).length === 0;

  // Rough trains needed to close the gap while working in `job` (gains differ per job).
  // null when the job's training doesn't raise a stat that's short.
  function trainsToMeet(stats, job, trainingIn = job) {
    let n = 0;
    for (const [k, gap] of Object.entries(shortfall(stats, job))) {
      if (!trainingIn.gains[k]) return null;
      n = Math.max(n, Math.ceil(gap / trainingIn.gains[k]));
    }
    return n;
  }

  /*
   * -> null when the stats can't be read, else {
   *   stats, current: { job, meets, short, trains } | null (position not a Music Store job),
   *   qualifies: [job names, easiest first], best: job name | null (hardest job they meet),
   *   verdict: 'right' | 'better' | 'below' | 'unassigned'
   * }
   */
  function jobFit(employee) {
    const stats = parseStats(employee && employee.workingStats);
    if (!stats) return null;
    const job = findJob(employee.position);
    const qualified = JOBS.filter((j) => meets(stats, j));
    // JOBS is ordered easiest first, so the last job they meet is the most demanding fit.
    const bestJob = qualified[qualified.length - 1] || null;
    const current = job ? { job: job.name, meets: meets(stats, job), short: shortfall(stats, job), trains: trainsToMeet(stats, job) } : null;
    let verdict;
    if (!current) verdict = 'unassigned';
    else if (!current.meets) verdict = 'below';
    else verdict = bestJob && bestJob.name !== job.name ? 'better' : 'right';
    return { stats, current, qualifies: qualified.map((j) => j.name), best: bestJob ? bestJob.name : null, verdict };
  }

  /*
   * Everyone whose stats meet `jobName`, strongest first -> [{ employee, stats }].
   * "Strongest" = highest main stat (the job's first, larger requirement), then the
   * second stat as a tie-break. Employees without readable stats are skipped, not guessed.
   * Callers decide who to pass in (e.g. drop staff who have left).
   */
  function rankForJob(employees, jobName) {
    const job = findJob(jobName);
    if (!job) return [];
    const [main, second] = Object.keys(job.needs);
    return (employees || [])
      .map((employee) => ({ employee, stats: parseStats(employee && employee.workingStats) }))
      .filter((r) => r.stats && meets(r.stats, job))
      .sort((a, b) => (b.stats[main] - a.stats[main]) || (b.stats[second] - a.stats[second]));
  }

  // Most people a job should hold. Torn doesn't cap these; it's the user's own rule, so it
  // lives in Settings. A job missing here has no limit.
  const DEFAULT_LIMITS = { Cleaner: 1, Bookkeeper: 1, Supervisor: 1, Trainer: 1 };
  const MAX_LIMIT = 99;

  // Settings form -> { limits, errors }. Blank = no limit; 0 = never suggest this job.
  // Unknown job names are dropped (e.g. from an old backup) rather than rejected.
  function cleanLimits(raw) {
    const limits = {}, errors = {};
    for (const [name, value] of Object.entries(raw || {})) {
      const job = findJob(name);
      const text = String(value == null ? '' : value).trim();
      if (!job || text === '') continue;
      const n = Number(text);
      if (!Number.isInteger(n) || n < 0 || n > MAX_LIMIT) errors[job.name] = `Use a whole number from 0 to ${MAX_LIMIT}, or leave it empty for no limit.`;
      else limits[job.name] = n;
    }
    return { limits, errors };
  }

  /*
   * One suggested job per employee, honouring `limits` -> Map(employee.id -> {
   *   job: name | null,                       // null = no job with room fits them
   *   lostTo: [{ job, takenBy: [employee] }]  // limited jobs they met, given to someone stronger
   * }). Employees without readable stats get no entry.
   *
   * Hardest job first: a limited job goes to its strongest candidates (rankForJob order) among
   * people not yet placed; an unlimited job takes everyone left who meets it. So each person
   * lands in the hardest job they meet that still has room. Who holds a job today is ignored
   * on purpose: the user's rule is that the strongest person gets it.
   */
  function suggestJobs(employees, limits) {
    const lim = limits || {};
    const out = new Map();
    let left = (employees || []).filter((e) => e && parseStats(e.workingStats));
    const lostTo = new Map(left.map((e) => [e.id, []]));
    for (const job of [...JOBS].reverse()) {
      const ranked = rankForJob(left, job.name).map((r) => r.employee);
      const limited = Number.isInteger(lim[job.name]);
      const placed = limited ? ranked.slice(0, lim[job.name]) : ranked;
      // With a limit of 0 nobody "lost" to a person, so there's nothing useful to report.
      if (placed.length) for (const e of ranked.slice(placed.length)) lostTo.get(e.id).push({ job: job.name, takenBy: placed });
      for (const e of placed) out.set(e.id, { job: job.name, lostTo: lostTo.get(e.id) });
      left = left.filter((e) => !placed.includes(e));
    }
    for (const e of left) out.set(e.id, { job: null, lostTo: lostTo.get(e.id) });
    return out;
  }

  return { JOBS, STAT_KEYS, DEFAULT_LIMITS, parseStats, findJob, shortfall, meets, trainsToMeet, jobFit, rankForJob, cleanLimits, suggestJobs };
});
