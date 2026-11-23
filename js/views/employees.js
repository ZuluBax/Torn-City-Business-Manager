(function (DMB) {
  'use strict';
  const U = DMB.util, C = DMB.calc, db = DMB.db, S = DMB.services, ui = DMB.ui, F = DMB.forms;
  // Looked up per call: importing a different company type swaps the table at runtime.
  const J = () => DMB.jobs.forTable(db.settings().companyType);
  const esc = U.escapeHtml;

  // ---------- Job fit (stats vs. your company type's recommended stats, from Torn) ----------

  const NO_JOBS_TEXT = 'Import from Torn to load your company\'s jobs, then this shows who suits each one.';
  const noJobsDash = () => `<span class="muted" title="${esc(NO_JOBS_TEXT)}">—</span>`;

  const shortText = (short) => Object.entries(short).map(([k, n]) => `${U.formatNumber(n)} ${k}`).join(' and ');
  const trainsText = (n) => (n == null ? '' : ` (about ${U.formatNumber(n)} train${n === 1 ? '' : 's'})`);

  // Suggestions depend on the whole team (a limited job goes to the strongest), so they're
  // worked out once per render. Staff who have left neither get nor take a job.
  const suggestions = () => J().suggestJobs(db.all('employees').filter((e) => e.status !== 'left'), db.settings().jobLimits);

  // "Cleaner goes to Strongest1" — why someone isn't suggested a job their stats meet.
  const lostText = (lostTo) => lostTo.map((l) => `${l.job} goes to ${l.takenBy.map((x) => x.name).join(', ')}`).join('; ');

  function jobFitBadge(e, sugs) {
    if (!J().hasJobs) return noJobsDash();
    const fit = J().jobFit(e);
    if (!fit) return '<span class="muted" title="No working stats yet. Import from Torn to fetch them.">—</span>';
    if (e.status === 'left') return '<span class="muted" title="Has left, so no job is suggested.">—</span>';
    const tag = (tone, text, title) => `<span class="badge badge-${tone}" title="${esc(title)}">${esc(text)}</span>`;
    const sug = sugs.get(e.id) || { job: null, lostTo: [] };
    if (sug.chosen) {
      return sug.job === e.position
        ? tag('green', 'Right job', 'The job you chose for them, and their stats meet it.')
        : tag('blue', `Move to ${sug.job}`, `You chose ${sug.job} for them; on Torn they're still in ${e.position}.`);
    }
    // A pick they no longer meet is ignored; say so first so it isn't silently lost.
    const stale = sug.staleChoice ? `${tag('amber', 'Chosen job no longer fits', `You chose ${sug.staleChoice}, but their stats no longer meet it, so the automatic suggestion is shown instead.`)} ` : '';
    return stale + autoFitBadge(e, fit, sug, tag);
  }

  function autoFitBadge(e, fit, sug, tag) {
    const why = sug.lostTo.length ? ` ${lostText(sug.lostTo)}.` : '';
    // Placed below stats to fill the line-up in Settings → Job limits (nobody closer was free).
    if (sug.below) {
      const short = shortText(J().shortfall(fit.stats, J().findJob(sug.job)));
      const title = `Fills a ${sug.job} place in your line-up. Short by ${short}; they still work there, just less effectively.`;
      return sug.job === e.position ? tag('amber', 'Right job · below stats', title) : tag('amber', `Move to ${sug.job} · below stats`, title);
    }
    const target = sug.job ? `Suggest ${sug.job}` : 'No open job fits';
    if (fit.current && !fit.current.meets) return tag('amber', `Below stats · ${target}`, `Short of ${fit.current.job} by ${shortText(fit.current.short)}${trainsText(fit.current.trains)}.${why}`);
    if (!fit.current) return tag(sug.job ? 'blue' : 'muted', target, `"${e.position}" isn't one of the ${J().table.name} jobs.${why}`);
    if (sug.job === fit.current.job) return tag('green', 'Right job', `Best job for their stats that has room.${why}`);
    if (sug.job) return tag('blue', `Move to ${sug.job}`, `${sug.job} is the hardest job they meet that has room.${why}`);
    return tag('muted', target, `Every job they meet is full.${why}`);
  }

  // Bold when it differs from their job now, so moves stand out in the list.
  // Someone who meets two or more jobs gets a picker, so you can choose which one they do.
  // withPicker = false where the page shows the picker somewhere else (the profile's Job fit).
  function suggestedCell(e, sugs, withPicker = true) {
    const sug = e.status !== 'left' && sugs.get(e.id);
    if (sug && withPicker) {
      const picker = chosenJobPicker(e, sug);
      if (picker) return picker;
    }
    if (!sug || !sug.job) return '<span class="muted">—</span>';
    return sug.job === e.position ? esc(sug.job) : `<strong>${esc(sug.job)}</strong>`;
  }

  // '' when there's nothing to choose between (fewer than two jobs met).
  function chosenJobPicker(e, sug) {
    const fit = J().jobFit(e);
    if (!fit || fit.qualifies.length < 2) return '';
    const chosen = sug.chosen ? sug.job : '';
    const auto = sug.chosen ? 'Automatic' : `Automatic (${sug.job || 'none'})`;
    const opts = [`<option value=""${chosen ? '' : ' selected'}>${esc(auto)}</option>`]
      .concat([...fit.qualifies].reverse().map((j) => `<option value="${esc(j)}"${j === chosen ? ' selected' : ''}>${esc(j)}</option>`));
    return `<select class="input-sm" data-chosen-job="${esc(e.id)}" aria-label="Chosen job for ${esc(e.name)}" title="Their stats meet ${fit.qualifies.length} jobs. Pick the one they should do.">${opts.join('')}</select>`;
  }

  function bindChosenJobPickers(root) {
    root.querySelectorAll('[data-chosen-job]').forEach((sel) => sel.addEventListener('change', () => {
      const e = db.get('employees', sel.dataset.chosenJob);
      ui.runAction(() => S.setChosenJob(sel.dataset.chosenJob, sel.value), sel.value ? `${e ? e.name : 'Employee'}: chosen job ${sel.value}` : 'Back to automatic');
    }));
  }

  function effectivenessText(tornId) {
    const ef = ui.effectivenessOf(tornId);
    if (!ef) return '<span class="muted">—</span>';
    return `${U.formatNumber(ef.total)} · addiction ${ui.addictionBadge(tornId)}`;
  }

  // Newest first, last 30 Torn days on which this employee appeared in the log.
  function effectivenessHistory(tornId) {
    return db.all('effectivenessLog')
      .filter((r) => r.employees && r.employees[tornId])
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 30)
      .map((r) => ({ date: r.date, dailyIncome: r.dailyIncome, ef: r.employees[tornId] }));
  }

  function jobFitDetails(e) {
    if (!J().hasJobs) return `<span class="muted">${esc(NO_JOBS_TEXT)}</span>`;
    const fit = J().jobFit(e);
    if (!fit) return '<span class="muted">Needs working stats (MAN / INT / END) to compare.</span>';
    const sugs = suggestions();
    const sug = sugs.get(e.id);
    const lines = [jobFitBadge(e, sugs)];
    if (fit.current && !fit.current.meets) lines.push(`Short of ${esc(fit.current.job)} by ${esc(shortText(fit.current.short))}${esc(trainsText(fit.current.trains))}.`);
    lines.push(fit.qualifies.length ? `Stats meet: ${fit.qualifies.map(esc).join(', ')}.` : `Stats don't meet any ${esc(J().table.name)} job yet.`);
    const picker = e.status !== 'left' && sug ? chosenJobPicker(e, sug) : '';
    if (picker) lines.push(`<label class="inline-field">Chosen job ${picker}</label>`);
    if (sug && sug.lostTo.length) lines.push(`${esc(lostText(sug.lostTo))} (stronger stats).`);
    return `${lines.join('<br>')}<br><span class="small muted">Based on Torn's recommended stats and your job limits in Settings.</span>`;
  }

  // "Best for this job": who meets a job's stats, strongest first. Staff who have left are
  // excluded so the list only suggests people you can actually move.
  function renderBestForJob(el) {
    const job = J().findJob(bestFor.job) || J().JOBS[0];
    if (!job) { el.querySelector('[data-best]').innerHTML = `<p class="muted">${esc(NO_JOBS_TEXT)}</p>`; return; }
    // Torn jobs need two stats today; reading the keys keeps this right if one ever needs one or three.
    const keys = Object.keys(job.needs);
    const current = db.snapshot().employees.filter((e) => e.status !== 'left');
    const rows = J().rankForJob(current, job.name).map((r, i) => ({ ...r, rank: i + 1 }));
    const sugs = suggestions();
    const limit = (db.settings().jobLimits || {})[job.name];
    const limitText = limit === 0 ? ' Limit: 0, so nobody is suggested here.' : Number.isInteger(limit) ? ` Limit: ${limit} ${limit === 1 ? 'person' : 'people'}, so only the top ${limit === 1 ? 'one is' : `${limit} are`} suggested here.` : '';
    const needs = `Needs ${keys.map((k) => `${U.formatNumber(job.needs[k])} ${k}`).join(' and ')}.`;
    el.querySelector('[data-best]').innerHTML = `<p class="small muted">${esc(needs)} Ranked by ${esc(keys.join(', then '))}.${esc(limitText)}</p>` + ui.table({
      empty: `Nobody meets the ${job.name} stats yet.`,
      rows,
      columns: [
        { label: '#', align: 'right', render: (r) => r.rank },
        { label: 'Employee', render: (r) => ui.employeeLink(r.employee.id) },
        ...keys.map((k, i) => ({ label: k, align: 'right', render: (r) => (i === 0 ? `<strong>${U.formatNumber(r.stats[k])}</strong>` : U.formatNumber(r.stats[k])) })),
        { label: 'Job now', render: (r) => esc(r.employee.position) },
        { label: 'Suggested job', render: (r) => suggestedCell(r.employee, sugs) },
        { label: 'Job fit', render: (r) => jobFitBadge(r.employee, sugs) },
      ],
    });
    bindChosenJobPickers(el.querySelector('[data-best]'));
  }

  // ---------- Role advisor: who suits which role, and who should move ----------

  const needsText = (needs) => Object.entries(needs).map(([k, n]) => `${U.formatNumber(n)} ${k}`).join(' / ');
  const people = (list, max) => {
    if (!list.length) return '<span class="muted">—</span>';
    const shown = list.slice(0, max).map((e) => ui.employeeLink(e.id)).join(', ');
    return list.length > max ? `${shown} <span class="muted">+${list.length - max} more</span>` : shown;
  };
  // A best-fit name, with how far short they are when the line-up had to fill the place below stats.
  const fitText = (e, jobName) => {
    const stats = J().parseStats(e.workingStats);
    const job = J().findJob(jobName);
    if (!stats || !job || J().meets(stats, job)) return ui.employeeLink(e.id);
    return `${ui.employeeLink(e.id)} <span class="small muted">${esc(shortText(J().shortfall(stats, job)))} short</span>`;
  };
  // Strongest first, so a numbered list reads as a ranking: fewest trains to meet the job (0 = meets).
  const byCloseness = (list, jobName) => {
    const job = J().findJob(jobName);
    const trains = (e) => {
      const stats = J().parseStats(e.workingStats);
      const t = stats && job ? J().trainsToMeet(stats, job) : null;
      return t == null ? Infinity : t;
    };
    return [...list].sort((a, b) => (trains(a) - trains(b)) || a.name.localeCompare(b.name));
  };
  const fitList = (list, jobName) => byCloseness(list, jobName).map((e) => fitText(e, jobName)).join('<br>');

  // "Who are my best N for each job?" answered straight from the line-up, hardest job first.
  function lineUpHtml(advice) {
    const items = advice.roles.filter((r) => r.best.length).map((r) => {
      const count = r.limit != null ? `${r.best.length} of ${r.limit}` : `${r.best.length}`;
      const names = byCloseness(r.best, r.job).map((e) =>`<li>${fitText(e, r.job)}</li>`).join('');
      return `<li><strong>${esc(r.job)}</strong> <span class="small muted">${count}</span><ol>${names}</ol></li>`;
    });
    if (!items.length) return '';
    return `<h3 class="sub-heading">Best line-up</h3><ul class="advice-list">${items.join('')}</ul>`;
  }
  const nearText = (c) =>`${ui.employeeLink(c.employee.id)} <span class="small muted">${esc(shortText(c.short))} short${esc(trainsText(c.trains))}</span>`;

  // The pretend newcomer from the New hire check isn't in the database, so it can't be a link.
  const personLink = (e) => {
    if (e.id !== J().HIRE_ID) return ui.employeeLink(e.id);
    // The default name already says "New hire"; only tag a typed-in name.
    return e.name === 'New hire' ? '<strong>New hire</strong>' : `<strong>${esc(e.name)}</strong> <span class="badge badge-blue">New hire</span>`;
  };

  function movesHtml(advice) {
    if (!advice.moves.length && !advice.stuck.length) return '<p class="muted">Everyone is already in the best job for their stats.</p>';
    const items = advice.moves.map((m) => {
      const tags = [
        m.belowNow ? `<span class="badge badge-amber" title="Their stats are below what ${esc(m.from)} recommends.">Below stats now</span>` : '',
        m.belowTarget ? `<span class="badge badge-amber" title="Nobody free meets ${esc(m.to)} yet, so the closest person fills the place in your line-up.">Below stats for ${esc(m.to)}</span>` : '',
        m.chosen ? '<span class="badge badge-blue" title="You picked this job for them.">Your choice</span>' : '',
      ].filter(Boolean).join(' ');
      const from = m.employee.id === J().HIRE_ID ? 'joins' : esc(m.from);
      const replaces = m.replaces && m.replaces.length ? ` <span class="small muted">replaces ${m.replaces.map((x) => esc(x.name)).join(', ')}</span>` : '';
      return `<li>${personLink(m.employee)}: ${from} → <strong>${esc(m.to)}</strong>${replaces} ${tags}</li>`;
    }).concat(advice.stuck.map((s) => (Object.keys(s.short).length
      ? `<li>${personLink(s.employee)}: no job fits yet. <span class="small muted">${esc(shortText(s.short))} short of ${esc(s.job)}${esc(trainsText(s.trains))}</span></li>`
      // They meet a job, but every job they meet is full of stronger people (or limited to 0).
      : `<li>${personLink(s.employee)}: <strong>no place left</strong> <span class="badge badge-amber" title="Every job their stats meet is already full of stronger people.">Jobs full</span> <span class="small muted">Let them go, or raise a job limit in Settings.</span></li>`)));
    return `<ul class="advice-list">${items.join('')}</ul>`;
  }

  // ---------- New hire check: "where would this person go, and who would they replace?" ----------

  // Kept at module level so the typed stats survive re-renders (e.g. a Pi refresh).
  const hireCheck = { name: '', MAN: '', INT: '', END: '' };

  function hireFormHtml() {
    const box = (k) => `<label class="hire-field"><span>${k}</span><input type="text" inputmode="numeric" name="${k}" value="${esc(hireCheck[k])}" placeholder="0" autocomplete="off" required></label>`;
    return `<form class="hire-form" data-hire-form novalidate>
        <label class="hire-field hire-name"><span>Name (optional)</span><input type="text" name="name" value="${esc(hireCheck.name)}" maxlength="60" placeholder="New hire" autocomplete="off"></label>
        ${J().STAT_KEYS.map(box).join('')}
        <button type="submit" class="btn btn-primary">Check</button>
        <button type="button" class="btn btn-ghost" data-hire-clear>Clear</button>
      </form>
      <p class="small muted">Type their working stats (MAN, INT, END). Nothing is saved: once they're hired, Import from Torn adds them for real.</p>
      <div data-hire-result aria-live="polite"></div>`;
  }

  // "9,000" or "9000" -> 9000; anything else -> NaN so the form can say which box is wrong.
  const statInput = (text) => (/^\s*[\d,]+\s*$/.test(String(text)) ? Number(String(text).replace(/[\s,]/g, '')) : NaN);

  function hireResultHtml() {
    if (!J().STAT_KEYS.some((k) => String(hireCheck[k]).trim())) return '';
    const stats = Object.fromEntries(J().STAT_KEYS.map((k) => [k, statInput(hireCheck[k])]));
    const bad = J().STAT_KEYS.filter((k) => !Number.isInteger(stats[k]));
    if (bad.length) return `<p class="form-error" role="alert">Enter a whole number for ${bad.join(', ')}.</p>`;
    const p = J().previewHire(db.all('employees'), db.settings().jobLimits, stats, hireCheck.name);
    if (!p) return '<p class="form-error" role="alert">Those stats look wrong. Use whole numbers from 0 up.</p>';
    const name = esc(p.hire.name);
    // from/to are suggestions (without vs with the hire), which can differ from their job on Torn.
    const move = (c) => `<li>${ui.employeeLink(c.employee.id)} <span class="small muted">(${esc(c.employee.position)} now)</span>: would have been ${c.from ? esc(c.from) : 'without a place'}, now <strong>${c.to ? esc(c.to) : 'no place left'}</strong></li>`;
    const parts = [];
    if (p.job) {
      parts.push(`<p><strong>${name}</strong> would go in <strong>${esc(p.job)}</strong>.</p>`);
    } else {
      const stuck = p.advice.stuck.find((s) => s.employee === p.hire);
      parts.push(`<p><strong>${name}</strong> wouldn't fit any job with room${stuck ? ` (${esc(shortText(stuck.short))} short of ${esc(stuck.job)}${esc(trainsText(stuck.trains))})` : ''}.</p>`);
    }
    parts.push(p.replaces.length
      ? `<h3 class="sub-heading">They replace</h3><ul class="advice-list">${p.replaces.map(move).join('')}</ul>`
      : '<p class="muted">They don\'t push anyone out of their job.</p>');
    if (p.knockOn.length) parts.push(`<h3 class="sub-heading">Knock-on changes</h3><ul class="advice-list">${p.knockOn.map(move).join('')}</ul>`);
    parts.push(letGoHtml(p));
    parts.push(`<h3 class="sub-heading">All moves if you hire them</h3>${movesHtml(p.advice)}`);
    return parts.join('');
  }

  // Torn caps staff at the company's capacity, so a full company has to lose someone to hire.
  function letGoHtml(p) {
    const tc = db.settings().tornCompany;
    const full = tc && Number.isInteger(tc.employeesHired) && Number.isInteger(tc.employeesCapacity) && tc.employeesHired >= tc.employeesCapacity;
    const who = p.letGo === p.hire ? `<strong>${esc(p.hire.name)}</strong> (the newcomer)` : (p.letGo ? ui.employeeLink(p.letGo.id) : null);
    if (!who) return '';
    const why = '<span class="small muted">(Weakest fit = lowest job, then lowest stats for that job. It doesn\'t weigh effectiveness, addiction or activity.)</span>';
    if (p.letGo === p.hire) {
      return `<p>${full ? `Your company is full (${tc.employeesHired}/${tc.employeesCapacity}). ` : ''}<span class="badge badge-amber">Weakest fit</span> ${who} would be the weakest person on the team, so hiring them won't help much. ${why}</p>`;
    }
    return full
      ? `<p><span class="badge badge-amber">Company full</span> ${tc.employeesHired}/${tc.employeesCapacity} staff. To hire them, someone has to go: the weakest fit would be ${who}. ${why}</p>`
      : `<p class="small">If your company is full, the weakest fit to replace would be ${who}. ${why}</p>`;
  }

  function bindHireCheck(el) {
    const form = el.querySelector('[data-hire-form]');
    if (!form) return;
    const out = el.querySelector('[data-hire-result]');
    const show = () => { out.innerHTML = hireResultHtml(); };
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      for (const k of ['name', ...J().STAT_KEYS]) hireCheck[k] = form.elements[k].value;
      show();
    });
    el.querySelector('[data-hire-clear]').addEventListener('click', () => {
      for (const k of ['name', ...J().STAT_KEYS]) { hireCheck[k] = ''; form.elements[k].value = ''; }
      show();
    });
    show();
  }

  /*
   * compact = the dashboard summary (moves only); otherwise the full per-role table too.
   * Same rules as the Suggested job column (J().adviseRoles builds on suggestJobs).
   */
  function roleAdvisorHtml({ compact = false } = {}) {
    const staff = db.all('employees');
    if (!J().hasJobs) return `<p class="muted">${esc(NO_JOBS_TEXT)}</p>`;
    const advice = J().adviseRoles(staff, db.settings().jobLimits);
    if (!staff.some((e) => e.status !== 'left' && J().parseStats(e.workingStats))) {
      return '<p class="muted">No working stats yet. Import from Torn to fetch them, then this will show who suits each role.</p>';
    }
    const caveat = '<p class="small muted">Based on Torn\'s recommended stats and your job limits in Settings, using the latest working stats the app has. A job with a limit is filled to that number: if too few people meet its stats, the closest fill it, marked below stats. Train counts are rough (as if they train in that job). It doesn\'t weigh effectiveness or addiction, and nothing changes on Torn until you move people there.</p>';
    const moves = lineUpHtml(advice) + `<h3 class="sub-heading">Suggested moves</h3>${movesHtml(advice)}`;
    if (compact) return moves + caveat;
    const table = `<h3 class="sub-heading">By role (hardest first)</h3>` + ui.table({
      rows: advice.roles,
      columns: [
        { label: 'Role', render: (r) => `<strong>${esc(r.job)}</strong>${r.limit != null ? `<br><span class="small muted">Limit ${r.limit}</span>` : ''}` },
        { label: 'Needs', render: (r) => `<span class="small">${esc(needsText(r.needs))}</span>` },
        { label: 'Best fit', render: (r) => {
          if (r.best.length) return fitList(r.best, r.job);
          // People who meet it went to other jobs (a harder one, or your pick): the role is open, not out of reach.
          if (r.alsoMeets.length) return '<span class="badge badge-amber" title="Everyone who meets it is suggested for another job. Use a chosen job to put someone here.">Unfilled</span>';
          return '<span class="badge badge-muted">Nobody qualifies yet</span>';
        } },
        { label: 'Also meets it', render: (r) => people(r.alsoMeets, 3) },
        { label: 'Closest to it', render: (r) => (r.closest.length ? r.closest.map(nearText).join('<br>') : '<span class="muted">—</span>') },
        { label: 'In it on Torn now', render: (r) => people(r.heldNow, 3) },
      ],
    });
    return moves + table + caveat;
  }

  // Kept at module level so filters survive re-renders when data changes.
  const filters = { q: '', status: 'current', position: '', sort: 'name' };
  const bestFor = { job: '' }; // '' = the easiest job of whatever company type is loaded

  const SORTS = {
    name: { label: 'Name (A–Z)', fn: (a, b) => a.e.name.localeCompare(b.e.name) },
    salary: { label: 'Salary (high–low)', fn: (a, b) => b.salary - a.salary },
    start: { label: 'Start date (newest)', fn: (a, b) => (a.e.startDate < b.e.startDate ? 1 : -1) },
    outstanding: { label: 'Outstanding (high–low)', fn: (a, b) => b.stats.outstanding - a.stats.outstanding },
    // Least recently active first; anyone without Torn activity data sinks to the bottom.
    active: { label: 'Last active (longest ago)', fn: (a, b) => (a.activeAt || Number.MAX_SAFE_INTEGER) - (b.activeAt || Number.MAX_SAFE_INTEGER) },
  };
  // No "everyone" option on purpose: leavers only show when "Left" is picked.
  const STATUS_FILTERS = { current: 'All current', active: 'Active', inactive: 'Inactive', left: 'Left' };

  // ---------- List ----------

  function rowsFor(data, ledgers) {
    const q = filters.q.trim().toLowerCase();
    return data.employees
      .filter((e) => {
        if (filters.status === 'current' ? e.status === 'left' : e.status !== filters.status) return false;
        if (filters.position && e.position !== filters.position) return false;
        if (q && !e.name.toLowerCase().includes(q) && !e.tornId.includes(q)) return false;
        return true;
      })
      .map((e) => ({ e, salary: C.currentSalary(e), stats: C.employeeStats(data, e, null, ledgers), activeAt: (ui.lastActiveOf(e.tornId) || {}).at }))
      .sort(SORTS[filters.sort].fn);
  }

  function renderTable(el) {
    const data = db.snapshot();
    const ledgers = C.allLedgers(data);
    const rows = rowsFor(data, ledgers);
    const sugs = suggestions();
    const anyEmployees = data.employees.length > 0;
    const target = el.querySelector('[data-table]');
    if (!anyEmployees) {
      target.innerHTML = ui.emptyState('No employees yet', 'Add your first employee to start tracking salaries and training.',
        `<button type="button" class="btn btn-primary" data-add>${ui.icon('plus')} Add employee</button>`);
      target.querySelector('[data-add]').addEventListener('click', () => F.employeeForm());
      return;
    }
    // Staff who have left are kept only for their money history, so they appear just under the
    // "Left" filter and never inflate the current-staff count; a note says how many are hidden.
    const leftCount = data.employees.filter((e) => e.status === 'left').length;
    const showingLeft = filters.status === 'left';
    const total = showingLeft ? leftCount : data.employees.length - leftCount;
    const hiddenNote = !showingLeft && leftCount
      ? ` <span class="muted">· ${leftCount} who left are hidden (choose “Left” in the status filter to see them)</span>` : '';
    const countText = showingLeft ? `${rows.length} of ${total} who left` : `${rows.length} of ${total} current employees${hiddenNote}`;
    target.innerHTML = `<p class="result-count">${countText}</p>` + ui.table({
      empty: 'No employees match these filters.',
      rows,
      columns: [
        { label: 'Employee', render: (r) => `${ui.employeeLink(r.e.id)}${r.e.isDemo ? ' <span class="badge badge-muted">demo</span>' : ''}` },
        { label: 'Torn ID', render: (r) => `<span class="mono">${esc(r.e.tornId)}</span>` },
        { label: 'Job now', render: (r) => esc(r.e.position) },
        { label: 'Suggested job', render: (r) => suggestedCell(r.e, sugs) },
        { label: 'Job fit', render: (r) => jobFitBadge(r.e, sugs) },
        { label: 'Salary/day', align: 'right', render: (r) => ui.money(r.salary) },
        { label: 'Start date', render: (r) => U.formatDate(r.e.startDate) },
        { label: 'Status', render: (r) => ui.statusBadge(r.e.status) },
        { label: 'Last active', render: (r) => ui.lastActiveBadge(r.e.tornId) },
        { label: 'Addiction', render: (r) => ui.addictionBadge(r.e.tornId) },
        { label: 'Trains', align: 'right', render: (r) => U.formatNumber(r.stats.trainsReceived) },
        { label: 'Outstanding', align: 'right', render: (r) => (r.stats.outstanding ? `<span class="text-red">${ui.money(r.stats.outstanding)}</span>` : '<span class="muted">—</span>') },
        { label: '', cls: 'actions', render: (r) => `
          <a class="icon-btn" href="#/employees/${esc(r.e.id)}" title="View" aria-label="View ${esc(r.e.name)}">${ui.icon('eye')}</a>
          <button type="button" class="icon-btn" data-edit="${esc(r.e.id)}" title="Edit" aria-label="Edit ${esc(r.e.name)}">${ui.icon('edit')}</button>` },
      ],
    });
    target.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => F.employeeForm(b.dataset.edit)));
    bindChosenJobPickers(target);
  }

  function renderList(el) {
    const s = db.settings();
    el.innerHTML = `
      ${ui.pageHeader('Employees', 'Staff records, positions and salaries.', `
        ${db.hasTornKey() ? `<button type="button" class="btn btn-ghost" data-torn>${ui.icon('download')} Import from Torn</button>` : ''}
        <button type="button" class="btn btn-primary" data-add>${ui.icon('plus')} Add employee</button>`)}
      <div class="toolbar">
        <label class="search"><span class="sr-only">Search</span>${ui.icon('search')}<input type="search" data-filter="q" placeholder="Search name or Torn ID…" value="${esc(filters.q)}"></label>
        <select data-filter="status" aria-label="Filter by status">${ui.mapOptions(STATUS_FILTERS, filters.status)}</select>
        <select data-filter="position" aria-label="Filter by position">${ui.options(s.positions, filters.position, { placeholder: 'All positions' })}</select>
        <select data-filter="sort" aria-label="Sort">${ui.options(Object.entries(SORTS).map(([value, o]) => ({ value, label: o.label })), filters.sort)}</select>
      </div>
      <div data-table></div>
      ${ui.panel('Role advisor', roleAdvisorHtml(), { cls: 'panel-best' })}
      ${J().hasJobs ? ui.panel('New hire check', hireFormHtml(), { cls: 'panel-best' }) : ''}
      ${ui.panel('Best for each job', '<div data-best></div>', {
        cls: 'panel-best',
        actions: `<select data-best-job aria-label="Choose a job">${ui.options(J().JOBS.map((j) => j.name), bestFor.job)}</select>`,
      })}`;
    el.querySelector('[data-add]').addEventListener('click', () => F.employeeForm());
    el.querySelector('[data-best-job]').addEventListener('change', (ev) => { bestFor.job = ev.target.value; renderBestForJob(el); });
    renderBestForJob(el);
    bindHireCheck(el);
    const tornBtn = el.querySelector('[data-torn]');
    if (tornBtn) tornBtn.addEventListener('click', () => F.tornImport());
    ui.bindFilters(el, filters, () => renderTable(el));
    renderTable(el);
  }

  // ---------- Profile ----------

  function renderProfile(el, id) {
    const e = db.get('employees', id);
    if (!e) {
      el.innerHTML = `${ui.pageHeader('Employee not found')}${ui.emptyState('This employee does not exist', 'They may have been removed.', '<a class="btn btn-ghost" href="#/employees">Back to employees</a>')}`;
      return;
    }
    const data = db.snapshot();
    const ledger = C.ledgerForEmployee(data, id);
    const st = C.employeeStats(data, e);
    const salary = C.currentSalary(e);
    const trainings = data.training.filter((t) => t.employeeId === id).sort((a, b) => (a.date < b.date ? 1 : -1));
    const payments = data.payments.filter((p) => p.employeeId === id).sort((a, b) => (a.date < b.date ? 1 : -1));
    const canDelete = !S.employeeHasRecords(id);

    const statusAction = e.status === 'left'
      ? `<button type="button" class="btn btn-ghost" data-act="reactivate">${ui.icon('userOn')} Re-activate</button>`
      : `<button type="button" class="btn btn-ghost" data-act="leave">${ui.icon('userOff')} Mark as left</button>`;

    el.innerHTML = `
      <a href="#/employees" class="back-link">${ui.icon('back')} All employees</a>
      <header class="profile-header">
        <div class="avatar" aria-hidden="true">${esc(e.name.replace(/\[DEMO\]\s*/, '').slice(0, 1).toUpperCase())}</div>
        <div class="profile-title">
          <h1>${esc(e.name)}</h1>
          <p class="page-sub">${esc(e.position)} · Torn ID <span class="mono">${esc(e.tornId)}</span> · ${ui.statusBadge(e.status)} · Last active ${ui.lastActiveBadge(e.tornId)}</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-primary" data-act="train">${ui.icon('train')} Record train</button>
          <button type="button" class="btn btn-primary" data-act="pay">${ui.icon('cash')} Record payment</button>
          <button type="button" class="btn btn-ghost" data-act="edit">${ui.icon('edit')} Edit</button>
          ${statusAction}
          ${canDelete ? `<button type="button" class="btn btn-ghost btn-danger-ghost" data-act="delete" title="Only possible while they have no history">${ui.icon('trash')} Delete</button>` : ''}
        </div>
      </header>

      <div class="stat-grid">
        ${ui.statCard({ label: 'Outstanding balance', value: ui.money(st.outstanding), tone: st.outstanding ? 'red' : 'green', iconName: 'alert', sub: st.lastPaymentDate ? `Last payment ${U.formatDate(st.lastPaymentDate)}` : 'No payments yet' })}
        ${ui.statCard({ label: 'Trains received', value: U.formatNumber(st.trainsReceived), iconName: 'train', sub: `${st.paidTrains} paid · ${st.unpaidTrains} unpaid · ${st.freeTrains} free${st.trainsWaiting ? ` · <span class="text-amber">${st.trainsWaiting} still to give</span>` : ''}` })}
        ${ui.statCard({ label: 'Spent on trains', value: ui.money(st.charged), iconName: 'tag', sub: `${ui.money(st.paid)} paid so far` })}
        ${ui.statCard({ label: 'Salary paid (est.)', value: ui.money(st.salaryCost), iconName: 'wallet', sub: `${U.formatNumber(st.daysEmployed)} day${st.daysEmployed === 1 ? '' : 's'} at up to ${ui.money(salary)}/day` })}
      </div>

      <div class="grid-2">
        ${ui.panel('Details', `
          <dl class="details">
            <dt>Job now</dt><dd>${esc(e.position)}</dd>
            <dt>Suggested job</dt><dd>${suggestedCell(e, suggestions(), false)}</dd>
            <dt>Salary / day</dt><dd>${ui.money(salary)}</dd>
            <dt>Start date</dt><dd>${U.formatDate(e.startDate)}</dd>
            <dt>End date</dt><dd>${e.endDate ? U.formatDate(e.endDate) : '<span class="muted">—</span>'}</dd>
            ${e.reasonForLeaving ? `<dt>Reason for leaving</dt><dd>${esc(e.reasonForLeaving)}</dd>` : ''}
            <dt>Working stats</dt><dd class="pre">${e.workingStats ? esc(e.workingStats) : '<span class="muted">—</span>'}</dd>
            <dt>Effectiveness</dt><dd>${effectivenessText(e.tornId)}</dd>
            <dt>Job fit</dt><dd>${jobFitDetails(e)}</dd>
            <dt>Notes</dt><dd class="pre">${e.notes ? esc(e.notes) : '<span class="muted">—</span>'}</dd>
          </dl>`)}
        ${ui.panel('Financial summary', `
          <dl class="details">
            <dt>Training charged</dt><dd>${ui.money(st.charged)}</dd>
            <dt>Training paid</dt><dd>${ui.money(st.paid)}</dd>
            <dt>Outstanding</dt><dd class="${st.outstanding ? 'text-red' : ''}">${ui.money(st.outstanding)}</dd>
            <dt>Estimated salary paid</dt><dd>${ui.money(st.salaryCost)}</dd>
            <dt>Net value to company</dt><dd class="${st.netValue < 0 ? 'text-red' : 'text-green'}">${ui.money(st.netValue)}</dd>
            <dt>Last train</dt><dd>${st.lastTrainDate ? U.formatDate(st.lastTrainDate) : '<span class="muted">—</span>'}</dd>
          </dl>
          <p class="small muted">Net value = training charged + other payments − estimated salary.</p>`)}
      </div>

      ${ui.panel('Training history', ui.table({
        rows: trainings,
        empty: 'No training recorded yet.',
        columns: [
          { label: 'Date', render: (t) => U.formatDate(t.date) },
          { label: 'Trains', align: 'right', render: (t) => t.trainCount },
          { label: 'Type', render: (t) => ui.trainTypeBadge(t.trainType) },
          { label: 'Price/train', align: 'right', render: (t) => ui.money(t.pricePerTrain) },
          { label: 'Total', align: 'right', render: (t) => ui.money(ledger.rows.get(t.id).charge) },
          { label: 'Paid', align: 'right', render: (t) => ui.money(ledger.rows.get(t.id).paid) },
          { label: 'Outstanding', align: 'right', render: (t) => ui.money(ledger.rows.get(t.id).outstanding) },
          { label: 'Status', render: (t) => ui.payStatusBadge(ledger.rows.get(t.id).status) },
          { label: 'Notes', cls: 'notes', render: (t) => esc(t.notes) },
          { label: '', cls: 'actions', render: (t) => `
            ${ledger.rows.get(t.id).outstanding ? `<button type="button" class="icon-btn" data-pay-training="${esc(t.id)}" title="Record payment for this" aria-label="Record payment">${ui.icon('cash')}</button>` : ''}
            <button type="button" class="icon-btn" data-edit-training="${esc(t.id)}" title="Edit" aria-label="Edit">${ui.icon('edit')}</button>
            <button type="button" class="icon-btn icon-danger" data-del-training="${esc(t.id)}" title="Delete (e.g. they never paid)" aria-label="Delete">${ui.icon('trash')}</button>` },
        ],
      }))}

      ${ui.panel('Payment history', ui.table({
        rows: payments,
        empty: 'No payments recorded yet.',
        columns: [
          { label: 'Date', render: (p) => U.formatDate(p.date) },
          { label: 'Type', render: (p) => ui.paymentTypeBadge(p.paymentType) },
          { label: 'Amount', align: 'right', render: (p) => (p.paymentType === 'refund' ? `<span class="text-red">−${ui.money(p.amount)}</span>` : ui.money(p.amount)) },
          { label: 'For training', render: (p) => { const t = p.trainingId && db.get('training', p.trainingId); return t ? `${U.formatDate(t.date)} (${t.trainCount})` : '<span class="muted">Oldest balance</span>'; } },
          { label: 'Notes', cls: 'notes', render: (p) => esc(p.notes) },
          { label: '', cls: 'actions', render: (p) => `<button type="button" class="icon-btn" data-edit-payment="${esc(p.id)}" title="Edit" aria-label="Edit">${ui.icon('edit')}</button>` },
        ],
      }))}

      ${ui.panel('Effectiveness history', ui.table({
        rows: effectivenessHistory(e.tornId),
        empty: 'No daily readings yet. The Pi saves one each day after Torn\'s 18:10 TCT update.',
        columns: [
          { label: 'Torn day', render: (r) => U.formatDate(r.date) },
          { label: 'Effectiveness', align: 'right', render: (r) => U.formatNumber(r.ef.total) },
          { label: 'Addiction', render: (r) => ui.addictionBadgeOf(r.ef) },
          { label: 'Company daily income', align: 'right', render: (r) => (r.dailyIncome == null ? '<span class="muted">—</span>' : ui.money(r.dailyIncome)) },
        ],
      }))}

      ${ui.panel('Salary history', ui.table({
        rows: C.sortedSalaryHistory(e).reverse(),
        columns: [
          { label: 'Effective from', render: (h) => U.formatDate(h.effectiveFrom) },
          { label: 'Salary/day', align: 'right', render: (h) => ui.money(h.salaryPerDay) },
        ],
      }))}
    `;

    const on = (sel, fn) => { const b = el.querySelector(sel); if (b) b.addEventListener('click', fn); };
    on('[data-act=train]', () => F.trainingForm(null, { employeeId: id }));
    on('[data-act=pay]', () => F.paymentForm(null, { employeeId: id }));
    on('[data-act=edit]', () => F.employeeForm(id));
    on('[data-act=leave]', () => markLeft(e));
    on('[data-act=reactivate]', async () => {
      const ok = await ui.confirmDialog({ title: `Re-activate ${e.name}?`, message: 'Their status will be set to Active and their end date cleared.<br><br><strong>Note:</strong> the salary estimate treats them as employed continuously from their start date, including any time away. If they were gone a while, edit their start date afterwards.', confirmText: 'Re-activate' });
      if (ok) ui.runAction(() => S.setEmployeeStatus(id, 'active'), `${e.name} re-activated`);
    });
    on('[data-act=delete]', async () => {
      const ok = await ui.confirmDialog({ title: `Delete ${e.name}?`, message: 'They have no training or payment history, so this permanently deletes the record. To keep a record of past staff, use <strong>Mark as left</strong> instead.', confirmText: 'Delete', danger: true });
      if (ok && await ui.runAction(() => S.deleteEmployee(id), 'Employee deleted')) location.hash = '#/employees';
    });
    el.querySelectorAll('[data-edit-training]').forEach((b) => b.addEventListener('click', () => F.trainingForm(b.dataset.editTraining)));
    bindChosenJobPickers(el);
    el.querySelectorAll('[data-del-training]').forEach((b) => b.addEventListener('click', () => F.confirmDeleteTraining(b.dataset.delTraining)));
    el.querySelectorAll('[data-pay-training]').forEach((b) => b.addEventListener('click', () => F.paymentForm(null, { employeeId: id, trainingId: b.dataset.payTraining })));
    el.querySelectorAll('[data-edit-payment]').forEach((b) => b.addEventListener('click', () => F.paymentForm(b.dataset.editPayment)));
  }

  function markLeft(e) {
    ui.openModal({
      title: `Mark ${e.name} as left`,
      size: 'sm',
      body: `<form id="leave-form" class="form-grid" novalidate><p class="form-error" role="alert" hidden></p>
        <p class="field-full muted small">Their record, training and payments are kept. Salary stops after the end date.</p>
        ${ui.field({ label: 'End date', name: 'endDate', type: 'date', value: U.todayISO(), required: true, full: true })}
        ${ui.field({ label: 'Reason for leaving', name: 'reasonForLeaving', value: e.reasonForLeaving || '', full: true, attrs: 'maxlength="500"' })}
      </form>`,
      footer: `<button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" form="leave-form" class="btn btn-primary">Mark as left</button>`,
      onMount(el, close) {
        ui.bindSubmit(el.querySelector('form'), (d) => S.saveEmployee({ ...e, salaryPerDay: String(C.currentSalary(e)), status: 'left', endDate: d.endDate, reasonForLeaving: d.reasonForLeaving }, e.id), {
          onSuccess() { close(); ui.toast(`${e.name} marked as left`); },
        });
      },
    });
  }

  function render(el, params) {
    if (params && params.id) renderProfile(el, params.id);
    else renderList(el);
  }

  DMB.views = DMB.views || {};
  DMB.views.employees = { title: 'Employees', render, roleAdvisorHtml };
})(window.DMB = window.DMB || {});
