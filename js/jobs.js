/*
 * Job fit for any Torn company type: compares an employee's working stats with each
 * position's recommended stats. Pure (no DOM, no network) so it is unit tested in Node.
 *
 * Nothing here hard-codes a company. The job table comes from Torn's own list of company
 * types (torn?selections=companies), turned into our shape by fromTorn() and saved in
 * settings.companyType when you Import from Torn. Torn calls the stats "recommended": staff
 * below them still work, just less efficiently.
 *
 * Usage: const J = DMB.jobs.forTable(settings.companyType); J.jobFit(employee) …
 * forTable(null) gives an empty table, so every function still works (and finds nothing).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DMB = root.DMB || {}; root.DMB.jobs = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STAT_KEYS = ['MAN', 'INT', 'END'];
  const TORN_FIELD = { MAN: 'man', INT: 'int', END: 'end' }; // Torn's man_required, int_gain, …
  const MAX_JOBS = 30;      // Torn's biggest type has 13; anything far beyond that is junk
  const MAX_NAME = 60;
  const MAX_STAT = 1e9;
  const HIRE_ID = '__new_hire__'; // the pretend employee in previewHire; never saved

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

  // ---------- Building and checking a job table ----------

  const statValue = (n) => (Number.isInteger(n) && n > 0 && n <= MAX_STAT ? n : 0);

  // { END: 4000, MAN: 2000 }: only stats above 0, biggest first. Callers read the first key
  // as the job's main stat, so the order is part of the contract.
  function orderedStats(raw) {
    return Object.fromEntries(STAT_KEYS.map((k) => [k, statValue(raw && raw[k])]).filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || STAT_KEYS.indexOf(a[0]) - STAT_KEYS.indexOf(b[0])));
  }

  const mainNeed = (job) => Object.values(job.needs)[0] || 0;
  const totalNeed = (job) => Object.values(job.needs).reduce((a, b) => a + b, 0);
  // Easiest → hardest by main stat. Most Torn types have two jobs with the same main
  // requirement, so ties fall back to the total, then the name, to keep the order fixed.
  const byDifficulty = (a, b) => mainNeed(a) - mainNeed(b) || totalNeed(a) - totalNeed(b) || a.name.localeCompare(b.name);

  /*
   * Stored or imported table -> a clean { id, name, jobs } or null. The table can arrive
   * from a backup file or another device, so it's checked here rather than trusted; bad
   * jobs are dropped, and a table with no usable jobs counts as no table.
   */
  function cleanTable(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.jobs)) return null;
    const seen = new Set();
    const jobs = [];
    for (const j of raw.jobs.slice(0, MAX_JOBS)) {
      const name = j && typeof j.name === 'string' ? j.name.trim().slice(0, MAX_NAME) : '';
      if (!name || seen.has(name.toLowerCase())) continue;
      const needs = orderedStats(j.needs);
      if (!Object.keys(needs).length) continue; // a job with no requirements can't be ranked
      seen.add(name.toLowerCase());
      jobs.push({ name, needs, gains: orderedStats(j.gains), special: typeof j.special === 'string' ? j.special.slice(0, 30) : '' });
    }
    if (!jobs.length) return null;
    const id = Number.isInteger(raw.id) && raw.id > 0 ? raw.id : null;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, MAX_NAME) : 'Company';
    return { id, name, jobs: jobs.sort(byDifficulty) };
  }

  // One entry of Torn's torn?selections=companies reply -> our table (or null).
  function fromTorn(typeId, entry) {
    if (!entry || typeof entry !== 'object' || !entry.positions || typeof entry.positions !== 'object') return null;
    const pick = (p, suffix) => Object.fromEntries(STAT_KEYS.map((k) => [k, p[`${TORN_FIELD[k]}_${suffix}`]]));
    const jobs = Object.entries(entry.positions).map(([name, p]) => ({
      name,
      needs: pick(p || {}, 'required'),
      gains: pick(p || {}, 'gain'),
      special: p && typeof p.special_ability === 'string' && p.special_ability !== 'None' ? p.special_ability : '',
    }));
    return cleanTable({ id: Number(typeId), name: entry.name, jobs });
  }

  // ---------- Pure maths on one job ----------

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

  // Most people a job should hold. Torn doesn't cap these; it's the user's own rule. By
  // default each special-ability job (Cleaner, Secretary, Manager, Trainer, Marketer) gets
  // one person, since those are the one-per-company roles; every other job has no limit.
  const defaultLimits = (jobs) => Object.fromEntries(jobs.filter((j) => j.special).map((j) => [j.name, 1]));
  const MAX_LIMIT = 99;

  // ---------- Everything that needs the company's job table ----------

  // Cached per table object so views can call forTable() on every render for free. A saved
  // settings change creates a new object, so a new table is never served stale.
  const cache = new WeakMap();
  const EMPTY = {};

  function forTable(rawTable) {
    const key = rawTable && typeof rawTable === 'object' ? rawTable : EMPTY;
    if (cache.has(key)) return cache.get(key);
    const api = bind(cleanTable(rawTable));
    cache.set(key, api);
    return api;
  }

  function bind(table) {
    const JOBS = table ? table.jobs : [];
    const byName = new Map(JOBS.map((j) => [j.name.toLowerCase(), j]));
    const findJob = (name) => byName.get(String(name || '').trim().toLowerCase()) || null;

    /*
     * -> null when the stats can't be read, else {
     *   stats, current: { job, meets, short, trains } | null (position isn't one of this company's jobs),
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
     * "Strongest" = highest main stat (the job's larger requirement), then the next stat as
     * a tie-break. Employees without readable stats are skipped, not guessed.
     */
    function rankForJob(employees, jobName) {
      const job = findJob(jobName);
      if (!job) return [];
      const order = Object.keys(job.needs);
      return (employees || [])
        .map((employee) => ({ employee, stats: parseStats(employee && employee.workingStats) }))
        .filter((r) => r.stats && meets(r.stats, job))
        .sort((a, b) => order.reduce((d, k) => d || b.stats[k] - a.stats[k], 0));
    }

    // Settings form -> { limits, errors }. Blank = no limit; 0 = never suggest this job.
    // Unknown job names are dropped (e.g. from another company type) rather than rejected.
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

    // The job the user picked for this person, if their stats still meet it; else null.
    function validChoice(e) {
      const job = findJob(e && e.chosenJob);
      const stats = parseStats(e && e.workingStats);
      return job && stats && meets(stats, job) ? job.name : null;
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
     *
     * Chosen jobs (employee.chosenJob, set by the user) are placed before anything else and use
     * up that job's limit, even past it: the user's pick beats the automatic rule. A choice the
     * person no longer meets is ignored and reported as `staleChoice` so the page can warn.
     * Entries also carry `chosen: true` when the job came from the user's pick.
     */
    function suggestJobs(employees, limits) {
      const lim = limits || {};
      const out = new Map();
      let left = (employees || []).filter((e) => e && parseStats(e.workingStats));
      const lostTo = new Map(left.map((e) => [e.id, []]));
      const used = {};
      for (const e of left) {
        const job = validChoice(e);
        if (!job) continue;
        used[job] = (used[job] || 0) + 1;
        out.set(e.id, { job, lostTo: [], chosen: true });
      }
      left = left.filter((e) => !out.has(e.id));
      for (const job of [...JOBS].reverse()) {
        const ranked = rankForJob(left, job.name).map((r) => r.employee);
        const limited = Number.isInteger(lim[job.name]);
        const placed = limited ? ranked.slice(0, Math.max(0, lim[job.name] - (used[job.name] || 0))) : ranked;
        // Whoever holds the job: chosen people first, then those placed here. With nobody in it
        // (e.g. a limit of 0) there's no one they "lost" to, so nothing useful to report.
        const holders = [...(employees || []).filter((e) => out.get(e && e.id)?.chosen && out.get(e.id).job === job.name), ...placed];
        if (holders.length) for (const e of ranked.slice(placed.length)) lostTo.get(e.id).push({ job: job.name, takenBy: holders });
        for (const e of placed) out.set(e.id, { job: job.name, lostTo: lostTo.get(e.id) });
        left = left.filter((e) => !placed.includes(e));
      }
      for (const e of left) out.set(e.id, { job: null, lostTo: lostTo.get(e.id) });
      for (const e of employees || []) {
        if (e && e.chosenJob && out.has(e.id) && !out.get(e.id).chosen) out.get(e.id).staleChoice = e.chosenJob;
      }
      return out;
    }

    const CLOSEST_SHOWN = 2;

    /*
     * The director's "who suits which role" view, built on suggestJobs so it can never disagree
     * with the Suggested job column. Staff who have left are dropped here (not by the caller)
     * because advice about them is never useful. -> {
     *   roles: [{ job, needs, limit|null,
     *             best:      [employee]  suggested holders,
     *             alsoMeets: [employee]  meet it but are suggested elsewhere, strongest first,
     *             closest:   [{ employee, short, trains }]  nearest who don't meet it yet,
     *             heldNow:   [employee]  position on Torn today }], hardest job first
     *   moves: [{ employee, from, to, chosen, belowNow }], hardest destination first
     *   stuck: [{ employee, job, short, trains }]  meet no job with room, so nowhere to move them
     * }
     */
    function adviseRoles(employees, limits) {
      if (!JOBS.length) return { roles: [], moves: [], stuck: [] };
      const staff = (employees || []).filter((e) => e && e.status !== 'left');
      const sugs = suggestJobs(staff, limits);
      const lim = limits || {};
      const withStats = staff.map((e) => ({ e, stats: parseStats(e.workingStats) })).filter((r) => r.stats);
      const totalShort = (s) => Object.values(s).reduce((a, b) => a + b, 0);

      const roles = [...JOBS].reverse().map((job) => {
        const best = staff.filter((e) => sugs.get(e.id) && sugs.get(e.id).job === job.name);
        const alsoMeets = rankForJob(staff, job.name).map((r) => r.employee).filter((e) => !best.includes(e));
        const closest = withStats
          .filter((r) => !meets(r.stats, job))
          .map((r) => ({ employee: r.e, short: shortfall(r.stats, job), trains: trainsToMeet(r.stats, job) }))
          .sort((a, b) => (a.trains - b.trains) || (totalShort(a.short) - totalShort(b.short)) || a.employee.name.localeCompare(b.employee.name))
          .slice(0, CLOSEST_SHOWN);
        const heldNow = staff.filter((e) => findJob(e.position) === job);
        return { job: job.name, needs: job.needs, limit: Number.isInteger(lim[job.name]) ? lim[job.name] : null, best, alsoMeets, closest, heldNow };
      });

      const hardness = (name) => JOBS.findIndex((j) => j.name === name);
      const moves = [], stuck = [];
      for (const { e, stats } of withStats) {
        const sug = sugs.get(e.id);
        const now = findJob(e.position);
        if (!sug.job) {
          // Measure them against the job they're in, or the entry job if theirs isn't one of ours.
          const target = now || JOBS[0];
          stuck.push({ employee: e, job: target.name, short: shortfall(stats, target), trains: trainsToMeet(stats, target) });
        } else if (!now || now.name !== sug.job) {
          // Only a limited job has to be emptied before someone new fits in; an unlimited one has room.
          const replaces = Number.isInteger(lim[sug.job])
            ? staff.filter((x) => x !== e && findJob(x.position) && findJob(x.position).name === sug.job && !(sugs.get(x.id) && sugs.get(x.id).job === sug.job))
            : [];
          moves.push({ employee: e, from: e.position, to: sug.job, chosen: !!sug.chosen, belowNow: !!now && !meets(stats, now), replaces });
        }
      }
      // Array sort is stable, so people heading to the same job keep the team's order.
      moves.sort((a, b) => hardness(b.to) - hardness(a.to));
      return { roles, moves, stuck };
    }

    /*
     * "What if I hire someone with these stats?" Nothing is saved: the newcomer is a temporary
     * employee (id HIRE_ID) run through the same rules as everyone else. -> null if the stats
     * aren't three whole numbers, else {
     *   hire:     the temporary employee,
     *   job:      job name | null (the job they'd get),
     *   replaces: [{ employee, from, to }]  staff the hire pushes out of the job they'd have had,
     *   knockOn:  [{ employee, from, to }]  everyone else whose suggested job changes as a result,
     *   advice:   adviseRoles() with the hire included (full move list),
     *   letGo:    employee  the weakest fit with the hire in (maybe the hire), for a full company
     * }
     */
    function previewHire(employees, limits, stats, name) {
      if (!stats || !STAT_KEYS.every((k) => Number.isInteger(stats[k]) && stats[k] >= 0 && stats[k] <= MAX_STAT)) return null;
      const staff = (employees || []).filter((e) => e && e.status !== 'left');
      const hire = {
        id: HIRE_ID, name: String(name || '').trim().slice(0, MAX_NAME) || 'New hire', position: '', status: 'active',
        workingStats: STAT_KEYS.map((k) => `${k} ${stats[k]}`).join(' / '),
      };
      const before = suggestJobs(staff, limits);
      const after = suggestJobs([...staff, hire], limits);
      const job = after.get(HIRE_ID).job;
      const changed = staff.filter((e) => before.has(e.id) && before.get(e.id).job !== after.get(e.id).job)
        .map((e) => ({ employee: e, from: before.get(e.id).job, to: after.get(e.id).job }));
      const replaces = changed.filter((c) => job && c.from === job);
      return {
        hire, job, replaces,
        knockOn: changed.filter((c) => !replaces.includes(c)),
        advice: adviseRoles([...staff, hire], limits),
        letGo: weakestFit([...staff, hire], after),
      };
    }

    /*
     * The person contributing least by stats, given suggestions `sugs`. Someone who meets no job
     * is weaker than anyone placed (most trains from the entry job first; can't-train-to-it worst).
     * Among the placed, the easiest suggested job is weakest, then the lowest stats for that job.
     */
    function weakestFit(list, sugs) {
      const scored = list.map((e) => ({ e, stats: parseStats(e.workingStats), job: sugs.get(e.id) && findJob(sugs.get(e.id).job) }))
        .filter((r) => r.stats);
      if (!scored.length) return null;
      const hardness = (r) => (r.job ? JOBS.indexOf(r.job) : -1);
      const trainsAway = (r) => { const t = trainsToMeet(r.stats, JOBS[0]); return t == null ? Infinity : t; };
      scored.sort((a, b) => {
        if (hardness(a) !== hardness(b)) return hardness(a) - hardness(b);
        if (!a.job) return trainsAway(b) - trainsAway(a);
        return Object.keys(a.job.needs).reduce((d, k) => d || a.stats[k] - b.stats[k], 0);
      });
      return scored[0].e;
    }

    return {
      table, hasJobs: JOBS.length > 0, JOBS, STAT_KEYS, DEFAULT_LIMITS: defaultLimits(JOBS), HIRE_ID,
      parseStats, findJob, shortfall, meets, trainsToMeet, jobFit, rankForJob, cleanLimits, suggestJobs, validChoice, adviseRoles, previewHire,
    };
  }

  return { STAT_KEYS, parseStats, cleanTable, fromTorn, forTable, defaultLimits, shortfall, meets, trainsToMeet };
});
