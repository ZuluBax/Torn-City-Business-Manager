/*
 * Shared formatting and date helpers. Pure functions only — no DOM, no data access —
 * so the same file is loaded by the browser and by the Node unit tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DMB = root.DMB || {}; root.DMB.util = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const pad = (n) => String(n).padStart(2, '0');

  // ---------- Dates ----------
  // Business dates are stored as 'YYYY-MM-DD' strings. Never pass them to new Date(str):
  // that parses as UTC midnight and shows the previous day in negative-offset timezones.

  function isISODate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function toISODate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function todayISO() { return toISODate(new Date()); }

  function parseISODate(s) {
    if (!isISODate(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // Day number since 1970 computed in UTC so DST changes never produce 23/25-hour "days".
  function epochDay(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
  }

  function fromEpochDay(n) {
    const d = new Date(n * DAY_MS);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function addDays(iso, n) { return fromEpochDay(epochDay(iso) + n); }

  function daysInclusive(fromIso, toIso) {
    const n = epochDay(toIso) - epochDay(fromIso) + 1;
    return n > 0 ? n : 0;
  }

  function inRange(iso, range) {
    if (!range) return true;
    if (range.from && iso < range.from) return false;
    if (range.to && iso > range.to) return false;
    return true;
  }

  function monthKey(iso) { return iso.slice(0, 7); }

  const DATE_PRESETS = {
    all: 'All time',
    today: 'Today',
    last7: 'Last 7 days',
    last30: 'Last 30 days',
    thisMonth: 'This month',
    lastMonth: 'Last month',
    custom: 'Custom range',
  };

  // Returns {from, to} (either may be null = open-ended) for a preset name.
  function rangeFromPreset(preset, custom, today) {
    const t = today || todayISO();
    const [y, m] = t.split('-').map(Number);
    switch (preset) {
      case 'today': return { from: t, to: t };
      case 'last7': return { from: addDays(t, -6), to: t };
      case 'last30': return { from: addDays(t, -29), to: t };
      case 'thisMonth': return { from: `${y}-${pad(m)}-01`, to: t };
      case 'lastMonth': {
        const first = new Date(y, m - 2, 1);
        const last = new Date(y, m - 1, 0);
        return { from: toISODate(first), to: toISODate(last) };
      }
      case 'custom': return {
        from: custom && isISODate(custom.from) ? custom.from : null,
        to: custom && isISODate(custom.to) ? custom.to : null,
      };
      default: return { from: null, to: null };
    }
  }

  // ---------- Formatting ----------

  function formatMoney(n, currency) {
    const sym = currency == null ? '$' : currency;
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    const abs = Math.abs(Math.round(n)).toLocaleString('en-US');
    return (n < 0 ? '-' : '') + sym + abs;
  }

  function formatNumber(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return n.toLocaleString('en-US');
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function formatDate(iso) {
    if (!isISODate(iso)) return '—';
    const [y, m, d] = iso.split('-');
    return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
  }

  function formatMonth(key) {
    const [y, m] = key.split('-');
    return `${MONTHS[Number(m) - 1]} ${y}`;
  }

  function formatDateTime(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return '—';
    return `${formatDate(toISODate(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Accepts "420000", "$420,000", "420k", "1.5m", "2b". Torn amounts are whole dollars,
  // so plain decimals are rejected rather than silently rounded.
  function parseMoney(input) {
    if (typeof input === 'number') return Number.isInteger(input) ? input : NaN;
    if (typeof input !== 'string') return NaN;
    const s = input.trim().toLowerCase().replace(/[$,\s]/g, '');
    if (s === '') return NaN;
    const match = /^(-?\d+(?:\.\d+)?)([kmb]?)$/.exec(s);
    if (!match) return NaN;
    const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9 }[match[2]];
    const value = Number(match[1]) * mult;
    if (match[2] === '' && !Number.isInteger(value)) return NaN;
    return Math.round(value);
  }

  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // "Duke's Music Box" -> "dukes-music-box", for file names.
  function slugify(s) {
    const slug = String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return slug || 'company';
  }

  // 45000 -> "45s", 3h5m -> "3h 05m", 4d2h -> "4d 2h". Compact elapsed time for activity timers.
  function formatElapsed(ms) {
    if (!(ms >= 0)) return '—';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d) return `${d}d ${h % 24}h`;
    if (h) return `${h}h ${pad(m % 60)}m`;
    if (m) return `${m}m`;
    return `${s}s`;
  }

  function sum(list, fn) { return list.reduce((acc, x) => acc + (fn ? fn(x) : x), 0); }

  return {
    isISODate, toISODate, todayISO, parseISODate, epochDay, fromEpochDay, addDays,
    daysInclusive, inRange, monthKey, DATE_PRESETS, rangeFromPreset,
    formatMoney, formatNumber, formatDate, formatMonth, formatDateTime, formatElapsed, parseMoney,
    escapeHtml, uid, sum, slugify,
  };
});
