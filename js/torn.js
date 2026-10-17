/*
 * Torn API integration (read-only). Fetches the company the key's owner directs and turns
 * it into an import "plan" the user reviews before anything is saved.
 *
 * buildPlan() is pure (no DOM, no network) so it is unit tested in Node. Only fetchCompany()
 * touches the network, and only when the user presses a button.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const util = isNode ? require('./util.js') : root.DMB.util;
  const calc = isNode ? require('./calc.js') : root.DMB.calc;
  const api = factory(util, calc);
  if (isNode) module.exports = api;
  else { root.DMB = root.DMB || {}; root.DMB.torn = api; }
})(typeof self !== 'undefined' ? self : this, function (U, C) {
  'use strict';

  const API_URL = 'https://api.torn.com/company/';
  const SELECTIONS = 'profile,employees,detailed,news';
  const TIMEOUT_MS = 15000;
  const KEY_PATTERN = /^[A-Za-z0-9]{16}$/;

  // Friendly text for the Torn error codes a director is likely to hit.
  const ERROR_HELP = {
    1: 'The API key is empty.',
    2: 'Torn says this API key is incorrect. Check it in Settings.',
    5: 'Too many requests to Torn right now. Wait a minute and try again.',
    6: 'Torn could not find your company. Are you a company director?',
    7: 'This key can\'t see company data. You need to be the company director.',
    8: 'Your IP is temporarily blocked by Torn for too many bad requests.',
    9: 'The Torn API is temporarily disabled. Try again later.',
    10: 'The key owner is in federal jail, so the key is blocked.',
    13: 'This key was disabled because the owner has been inactive.',
    16: 'This key\'s access level is too low. Create a "Limited Access" key.',
    18: 'This key is paused. Unpause it in Torn → Settings → API Keys.',
  };

  // viaServer: when the app runs from the Pi, the Pi holds the key and fetches on our behalf.
  async function fetchCompany(key, { viaServer = false } = {}) {
    if (!viaServer && !KEY_PATTERN.test(key || '')) throw new Error('Add a valid 16-character Torn API key in Settings first.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS + 2000);
    const url = viaServer ? 'api/torn/company' : `${API_URL}?selections=${SELECTIONS}&comment=TornCompanyManager&key=${encodeURIComponent(key)}`;
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'Torn did not respond in time. Try again.' : 'Could not reach Torn. Check your internet connection.');
    } finally {
      clearTimeout(timer);
    }
    if (viaServer && (res.status === 502 || res.status === 503)) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'The Pi could not get data from Torn.');
    }
    if (res.status === 429) throw new Error(ERROR_HELP[5]);
    if (!res.ok) throw new Error(`Torn returned an error (HTTP ${res.status}). Try again later.`);
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('Torn sent back something unexpected.'); }
    if (data.error) throw new Error(ERROR_HELP[data.error.code] || `Torn error: ${data.error.error || 'unknown'}`);
    if (!data.company || !data.company_employees || !data.company_detailed) throw new Error('Torn\'s reply was missing company data. Are you the director?');
    return data;
  }

  const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '');
  const parseDollars = (s) => Number(s.replace(/,/g, ''));
  const statsText = (e) => `MAN ${U.formatNumber(e.manual_labor)} / INT ${U.formatNumber(e.intelligence)} / END ${U.formatNumber(e.endurance)}`;

  function companySnapshot(data, fetchedAt) {
    const c = data.company, d = data.company_detailed;
    return {
      id: c.ID, name: c.name, rating: c.rating,
      employeesHired: c.employees_hired, employeesCapacity: c.employees_capacity,
      dailyIncome: c.daily_income, weeklyIncome: c.weekly_income, daysOld: c.days_old,
      funds: d.company_funds, trainsAvailable: d.trains_available, advertisingBudget: d.advertising_budget,
      popularity: d.popularity, efficiency: d.efficiency, environment: d.environment,
      lastActive: lastActiveMap(data.company_employees),
      effectiveness: effectivenessMap(data.company_employees),
      fetchedAt,
    };
  }

  // tornId -> { total, addiction }. Torn omits "addiction" when there is no penalty, so a
  // missing value means 0; it is negative otherwise. No numeric total = left out ("—").
  function effectivenessMap(employees) {
    const out = {};
    for (const [tornId, t] of Object.entries(employees || {})) {
      const eff = t && t.effectiveness;
      if (!eff || !Number.isFinite(eff.total)) continue;
      out[tornId] = { total: eff.total, addiction: Number.isFinite(eff.addiction) ? eff.addiction : 0 };
    }
    return out;
  }

  // tornId -> { at: epoch ms, status: 'Online' | 'Idle' | 'Offline' }. Employees with a missing
  // or malformed last_action are left out so the page shows "—" rather than a made-up time.
  function lastActiveMap(employees) {
    const out = {};
    for (const [tornId, t] of Object.entries(employees || {})) {
      const la = t && t.last_action;
      if (la && Number.isFinite(la.timestamp) && la.timestamp > 0) out[tornId] = { at: la.timestamp * 1000, status: String(la.status || 'Offline') };
    }
    return out;
  }

  /*
   * Setup spend = deposits − withdrawals − funds left. This only holds while the company has
   * never earned anything and the news still reaches back to the day it was founded; in any
   * other case the answer would be wrong, so we return null rather than guess.
   */
  function setupSpend(data) {
    const items = Object.values(data.news || {}).map((n) => ({ text: stripTags(n.news), ts: n.timestamp }));
    if (!items.some((n) => /started the .+ company/i.test(n.text))) return null;
    if (data.company.weekly_income || data.company.daily_income) return null;
    let deposits = 0, withdrawals = 0;
    const upgrades = [];
    for (const n of items) {
      let m;
      if ((m = /made a deposit of \$([\d,]+)/i.exec(n.text))) deposits += parseDollars(m[1]);
      else if ((m = /withdrawn \$([\d,]+)/i.exec(n.text))) withdrawals += parseDollars(m[1]);
      else if ((m = /upgraded the (.+?) to /i.exec(n.text))) upgrades.push(m[1]);
    }
    const amount = deposits - withdrawals - data.company_detailed.company_funds;
    if (!(amount > 0)) return null;
    const founded = U.toISODate(new Date(Math.min(...items.map((n) => n.ts)) * 1000));
    const kinds = [...new Set(upgrades)];
    return { amount, deposits, withdrawals, fundsLeft: data.company_detailed.company_funds, upgrades: upgrades.length, kinds, date: founded };
  }

  /*
   * Compares Torn's employee list with the app's records (matched by Torn ID) and returns
   * what could change. Nothing here is applied until the user ticks it.
   */
  function buildPlan(data, existing, opts) {
    const today = (opts && opts.today) || U.todayISO();
    const byTornId = new Map(existing.employees.map((e) => [e.tornId, e]));
    const tornIds = new Set(Object.keys(data.company_employees));
    const plan = { newEmployees: [], updates: [], gone: [], setup: null, positions: [] };

    for (const [tornId, t] of Object.entries(data.company_employees)) {
      const wage = Number.isInteger(t.wage) && t.wage >= 0 ? t.wage : 0;
      const stats = statsText(t);
      const e = byTornId.get(tornId);
      if (!e) {
        plan.newEmployees.push({
          tornId, name: String(t.name).slice(0, 60), position: t.position || 'Unassigned', wage, workingStats: stats,
          startDate: U.addDays(today, -(Number(t.days_in_company) || 0)),
        });
        continue;
      }
      const changes = {};
      if (t.position && t.position !== e.position) changes.position = { from: e.position, to: t.position };
      if (wage !== existing.currentSalary(e)) changes.wage = { from: existing.currentSalary(e), to: wage };
      if (stats !== e.workingStats) changes.workingStats = { from: e.workingStats, to: stats };
      if (e.status === 'left') changes.status = { from: 'left', to: 'active' };
      if (Object.keys(changes).length) plan.updates.push({ id: e.id, name: e.name, tornId, changes });
    }

    for (const e of existing.employees) {
      if (e.status !== 'left' && /^\d+$/.test(e.tornId) && !tornIds.has(e.tornId) && !e.isDemo) {
        plan.gone.push({ id: e.id, name: e.name, tornId: e.tornId });
      }
    }

    if (!existing.setupImported) plan.setup = setupSpend(data);
    const known = new Set(existing.positions);
    plan.positions = [...new Set(plan.newEmployees.map((n) => n.position).concat(plan.updates.filter((u) => u.changes.position).map((u) => u.changes.position.to)))].filter((p) => !known.has(p));
    return plan;
  }

  function isEmpty(plan) {
    return !plan.newEmployees.length && !plan.updates.length && !plan.gone.length && !plan.setup;
  }

  // ---------- Payments from "X sent you $N" events ----------
  // Only direct sends count. Faction gifts read "X gave $N to you from <faction>" and are
  // deliberately excluded by matching on "sent you".

  const EVENTS_URL = 'https://api.torn.com/user/?selections=events&comment=TornCompanyManager&key=';
  const isMoneyEvent = (html) => /\bsent you\b/i.test(stripTags(html));

  // Browser-side fetch for local (double-click) mode. On the Pi the server polls instead.
  async function fetchEvents(key) {
    if (!KEY_PATTERN.test(key || '')) throw new Error('No Torn API key saved.');
    const res = await fetch(EVENTS_URL + encodeURIComponent(key), { cache: 'no-store' });
    // Cloudflare answers with an HTML page, not JSON, so check the status before parsing.
    if (res.status === 429) throw new Error(ERROR_HELP[5]);
    if (!res.ok) throw new Error(`Torn returned an error (HTTP ${res.status}). Try again later.`);
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('Torn sent back something unexpected.'); }
    if (data.error) throw new Error(ERROR_HELP[data.error.code] || `Torn error: ${data.error.error}`);
    return data.events || {};
  }

  // -> { senderId, senderName, amount, message } or null if the text isn't understood.
  function parseMoneyEvent(html) {
    const link = /<a [^>]*XID=(\d+)[^>]*>([^<]*)<\/a>/i.exec(html || '');
    const text = stripTags(html).replace(/\s+/g, ' ').trim();
    const m = /\bsent you \$([\d,]+)\.?(.*)$/i.exec(text);
    if (!link || !m) return null;
    const message = m[2].trim()
      .replace(/^(with the message|with message|and the message|message)\s*:?\s*/i, '')
      .replace(/^["'“”]+|["'“”.]+$/g, '').trim();
    return { senderId: link[1], senderName: link[2].trim(), amount: parseDollars(m[1]), message };
  }

  // "train 1", "Train x2", "2 trains", "trains: 3" -> number of trains, else null.
  function trainCountFrom(message) {
    const s = String(message || '');
    const m = /\btrains?\s*[:#x×-]?\s*(\d{1,3})\b/i.exec(s) || /\b(\d{1,3})\s*x?\s*trains?\b/i.exec(s);
    const n = m ? Number(m[1]) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
  }

  /*
   * Decides what to do with one money event, given the current data.
   * Returns { action: 'pay' | 'trainAndPay' | 'review' | 'ignore', reason, ... }.
   *  - pay:          employee owes money; amount = trains × current price and ≤ what they owe
   *  - trainAndPay:  employee owes nothing; record the training and its payment together
   *  - review:       an employee sent money but something doesn't add up — a human checks it
   *  - ignore:       not one of our employees (personal transfers, etc.)
   */
  function classifyMoneyEvent(ev, data) {
    const p = parseMoneyEvent(ev.html);
    if (!p) return { action: 'review', reason: 'Could not read this message.' };
    const emp = data.employees.find((e) => e.tornId === p.senderId);
    if (!emp) return { action: 'ignore', reason: 'Sender is not an employee.', parsed: p };
    const base = { parsed: p, employeeId: emp.id };
    const count = trainCountFrom(p.message);
    if (!count) return { ...base, action: 'review', reason: `No number of trains in the message ("${p.message || 'no message'}").` };
    const price = data.settings.trainPrice;
    if (p.amount !== count * price) {
      return { ...base, action: 'review', count, reason: `${U.formatMoney(p.amount)} doesn't match ${count} × ${U.formatMoney(price)}.` };
    }
    const owed = C.ledgerForEmployee(data, emp.id).outstanding;
    if (owed === 0) return { ...base, action: 'trainAndPay', count, price };
    if (p.amount <= owed) return { ...base, action: 'pay', count };
    return { ...base, action: 'review', count, reason: `They owe ${U.formatMoney(owed)} but sent ${U.formatMoney(p.amount)}.` };
  }

  return {
    KEY_PATTERN, fetchCompany, buildPlan, companySnapshot, lastActiveMap, effectivenessMap, setupSpend, isEmpty, stripTags,
    EVENTS_URL, fetchEvents, isMoneyEvent, parseMoneyEvent, trainCountFrom, classifyMoneyEvent,
  };
});
