/*
 * Reusable UI building blocks: icons, toasts, modal + confirm dialogs, form helpers,
 * badges and tables. Views compose these so every page looks and behaves the same.
 */
(function (DMB) {
  'use strict';
  const U = DMB.util;
  const esc = U.escapeHtml;

  // Inline SVG paths (24x24, stroke-based) so icons work offline with no icon font.
  const ICON_PATHS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    train: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    wallet: '<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    report: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
    back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    trend: '<path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><path d="M7 7h.01"/>',
    printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    userOff: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M17 8l5 5M22 8l-5 5"/>',
    userOn: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M17 11l2 2 4-4"/>',
  };

  function icon(name, cls) {
    return `<svg class="icon ${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
  }

  // ---------- Toasts ----------
  function toast(message, type) {
    const root = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = `toast toast-${type || 'success'}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `${icon(type === 'error' ? 'alert' : 'check')}<span>${esc(message)}</span>`;
    root.appendChild(el);
    setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 250); }, type === 'error' ? 6000 : 3200);
  }

  // ---------- Modal ----------
  let openModals = 0;

  /*
   * openModal({ title, body, footer, size, onMount }) -> { el, close }
   * onMount(el, close) wires up the form. Esc or clicking the backdrop closes it.
   */
  function openModal({ title, body, footer, size, onMount, onClose }) {
    const previousFocus = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal ${size ? 'modal-' + size : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header class="modal-header">
          <h2 id="modal-title">${esc(title)}</h2>
          <button type="button" class="icon-btn" data-close aria-label="Close">${icon('close')}</button>
        </header>
        <div class="modal-body">${body}</div>
        ${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}
      </div>`;
    document.body.appendChild(wrap);
    openModals += 1;
    document.body.classList.add('modal-open');

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      wrap.classList.add('leaving');
      setTimeout(() => wrap.remove(), 150);
      openModals -= 1;
      if (!openModals) document.body.classList.remove('modal-open');
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      if (onClose) onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape' && wrap === document.querySelector('.modal-backdrop:last-of-type')) close();
      if (e.key === 'Tab') trapFocus(e, wrap);
    }
    document.addEventListener('keydown', onKey);
    // Only close on a click that both starts and ends on the backdrop, so dragging a text
    // selection out of an input doesn't throw the form away.
    let downOnBackdrop = false;
    wrap.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === wrap; });
    wrap.addEventListener('click', (e) => { if (e.target === wrap && downOnBackdrop) close(); });
    wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));

    if (onMount) onMount(wrap, close);
    const first = wrap.querySelector('[autofocus], input:not([type=hidden]), select, textarea, .modal-footer .btn-primary');
    if (first) first.focus();
    return { el: wrap, close };
  }

  function trapFocus(e, wrap) {
    const f = [...wrap.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // Promise-based replacement for window.confirm(). Resolves true only on explicit confirm.
  // `typeToConfirm` forces the user to type a word for the most destructive actions.
  function confirmDialog({ title, message, confirmText, danger, typeToConfirm }) {
    return new Promise((resolve) => {
      let result = false;
      const typeField = typeToConfirm
        ? `<label class="field"><span>Type <strong>${esc(typeToConfirm)}</strong> to confirm</span><input type="text" data-type-confirm autocomplete="off"></label>`
        : '';
      openModal({
        title,
        size: 'sm',
        body: `<p class="confirm-message">${message}</p>${typeField}`,
        footer: `<button type="button" class="btn btn-ghost" data-close>Cancel</button>
                 <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok ${typeToConfirm ? 'disabled' : ''}>${esc(confirmText || 'Confirm')}</button>`,
        onMount(el, close) {
          const ok = el.querySelector('[data-ok]');
          const input = el.querySelector('[data-type-confirm]');
          if (input) input.addEventListener('input', () => { ok.disabled = input.value.trim() !== typeToConfirm; });
          ok.addEventListener('click', () => { result = true; close(); });
        },
        onClose() { resolve(result); },
      });
    });
  }

  // ---------- Forms ----------

  function readForm(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else if (el.type === 'checkbox') out[el.name] = el.checked;
      else out[el.name] = el.value;
    }
    return out;
  }

  function clearErrors(form) {
    form.querySelectorAll('.field-error').forEach((e) => e.remove());
    form.querySelectorAll('.has-error').forEach((e) => e.classList.remove('has-error'));
    form.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
    const banner = form.querySelector('.form-error');
    if (banner) banner.hidden = true;
  }

  // Shows field errors inline; errors without a matching field go in the form banner.
  function showErrors(form, fields) {
    clearErrors(form);
    const unplaced = [];
    for (const [name, msg] of Object.entries(fields)) {
      const input = name !== '_form' && form.querySelector(`[name="${name}"]`);
      const field = input && input.closest('.field');
      if (!field) { unplaced.push(msg); continue; }
      field.classList.add('has-error');
      input.setAttribute('aria-invalid', 'true');
      const p = document.createElement('p');
      p.className = 'field-error';
      p.textContent = msg;
      field.appendChild(p);
    }
    const banner = form.querySelector('.form-error');
    if (unplaced.length && banner) { banner.textContent = unplaced.join(' '); banner.hidden = false; }
    else if (unplaced.length) toast(unplaced.join(' '), 'error');
    const firstBad = form.querySelector('[aria-invalid="true"]');
    if (firstBad) firstBad.focus();
  }

  /*
   * Wires a form's submit to an async save. ValidationErrors are shown inline; anything else
   * is an unexpected failure (e.g. storage full) and is reported without closing the form.
   */
  function bindSubmit(form, save, { onSuccess } = {}) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]') || form.closest('.modal')?.querySelector('[type=submit]');
      if (btn) btn.disabled = true;
      try {
        const result = await save(readForm(form));
        clearErrors(form);
        if (onSuccess) onSuccess(result);
      } catch (err) {
        if (err instanceof DMB.services.ValidationError) showErrors(form, err.fields);
        else { console.error(err); showErrors(form, { _form: `Could not save: ${err.message || err}` }); }
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  // Runs a destructive service call and reports ValidationErrors as a toast.
  async function runAction(fn, successMessage) {
    try {
      await fn();
      if (successMessage) toast(successMessage);
      return true;
    } catch (err) {
      if (err instanceof DMB.services.ValidationError) toast(Object.values(err.fields).join(' '), 'error');
      else { console.error(err); toast(`Something went wrong: ${err.message || err}`, 'error'); }
      return false;
    }
  }

  function field({ label, name, type, value, required, hint, attrs, options, full, placeholder }) {
    const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
    const req = required ? '<span class="req" aria-hidden="true">*</span>' : '';
    let control;
    if (type === 'select') {
      control = `<select id="${id}" name="${name}" ${attrs || ''}>${options}</select>`;
    } else if (type === 'textarea') {
      control = `<textarea id="${id}" name="${name}" rows="3" ${placeholder ? `placeholder="${esc(placeholder)}"` : ''} ${attrs || ''}>${esc(value)}</textarea>`;
    } else {
      control = `<input id="${id}" name="${name}" type="${type || 'text'}" value="${esc(value)}" ${placeholder ? `placeholder="${esc(placeholder)}"` : ''} ${attrs || ''}>`;
    }
    return `<div class="field ${full ? 'field-full' : ''}"><label for="${id}">${esc(label)}${req}</label>${control}${hint ? `<p class="field-hint">${hint}</p>` : ''}</div>`;
  }

  function options(list, selected, { placeholder } = {}) {
    const items = list.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
    // Keep a value that's no longer in the list (e.g. a renamed position) selectable.
    if (selected && !items.some((o) => o.value === selected)) items.unshift({ value: selected, label: selected });
    const ph = placeholder ? `<option value="">${esc(placeholder)}</option>` : '';
    return ph + items.map((o) => `<option value="${esc(o.value)}" ${o.value === selected ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
  }

  function mapOptions(obj, selected, opts) {
    return options(Object.entries(obj).map(([value, label]) => ({ value, label })), selected, opts);
  }

  // Employee <select> grouped by status, with left staff last so they're still recordable.
  function employeeOptions(selected, { placeholder = 'Select employee…' } = {}) {
    const emps = DMB.db.all('employees').slice().sort((a, b) => a.name.localeCompare(b.name));
    const groups = [['active', 'Active'], ['inactive', 'Inactive'], ['left', 'Left']];
    let html = `<option value="">${esc(placeholder)}</option>`;
    for (const [status, label] of groups) {
      const list = emps.filter((e) => e.status === status);
      if (!list.length) continue;
      html += `<optgroup label="${label}">${list.map((e) => `<option value="${esc(e.id)}" ${e.id === selected ? 'selected' : ''}>${esc(e.name)} [${esc(e.tornId)}]</option>`).join('')}</optgroup>`;
    }
    return html;
  }

  // ---------- Display helpers ----------

  const BADGE_TONES = {
    active: 'green', inactive: 'amber', left: 'muted',
    paid: 'green', partial: 'amber', unpaid: 'red', free: 'blue',
    train: 'gold', other: 'blue', refund: 'red',
    director: 'purple',
  };

  function badge(key, label) {
    return `<span class="badge badge-${BADGE_TONES[key] || 'muted'}">${esc(label || key)}</span>`;
  }

  function statusBadge(status) { return badge(status, DMB.calc.STATUSES[status] || status); }
  function payStatusBadge(status) { return badge(status, DMB.calc.PAY_STATUS[status] || status); }
  function paymentTypeBadge(type) { return badge(type, DMB.calc.PAYMENT_TYPES[type] || type); }
  function trainTypeBadge(type) { return badge(type === 'paid' ? 'train' : type === 'free' ? 'free' : type, DMB.calc.TRAIN_TYPES[type] || type); }

  function money(n) { return U.formatMoney(n, DMB.db.settings().currency); }

  function employeeLink(id) {
    const e = DMB.db.get('employees', id);
    if (!e) return '<span class="muted">Unknown</span>';
    return `<a href="#/employees/${esc(e.id)}" class="emp-link">${esc(e.name)}</a>`;
  }

  function emptyState(title, text, actionHtml) {
    return `<div class="empty"><div class="empty-icon">${icon('train')}</div><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${actionHtml || ''}</div>`;
  }

  /*
   * table({ columns: [{ label, render(row), align, cls }], rows, empty, footer })
   * Wrapped in a scroll container so wide tables stay usable on narrow screens.
   */
  function table({ columns, rows, empty, footer, cls }) {
    if (!rows.length) return `<div class="table-empty">${esc(empty || 'Nothing to show yet.')}</div>`;
    const head = columns.map((c) => `<th class="${c.align === 'right' ? 'num' : ''} ${c.cls || ''}" scope="col">${esc(c.label)}</th>`).join('');
    const body = rows.map((r) => `<tr>${columns.map((c) => `<td class="${c.align === 'right' ? 'num' : ''} ${c.cls || ''}" data-label="${esc(c.label)}">${c.render(r)}</td>`).join('')}</tr>`).join('');
    const foot = footer ? `<tfoot><tr>${columns.map((c, i) => `<td class="${c.align === 'right' ? 'num' : ''}">${footer[i] == null ? '' : footer[i]}</td>`).join('')}</tr></tfoot>` : '';
    return `<div class="table-wrap"><table class="table ${cls || ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`;
  }

  function pageHeader(title, subtitle, actions) {
    return `<header class="page-header">
      <div><h1>${esc(title)}</h1>${subtitle ? `<p class="page-sub">${subtitle}</p>` : ''}</div>
      ${actions ? `<div class="page-actions">${actions}</div>` : ''}
    </header>`;
  }

  function panel(title, content, { actions, cls } = {}) {
    return `<section class="panel ${cls || ''}">
      <header class="panel-header"><h2>${esc(title)}</h2>${actions ? `<div class="panel-actions">${actions}</div>` : ''}</header>
      <div class="panel-body">${content}</div>
    </section>`;
  }

  function statCard({ label, value, sub, iconName, tone }) {
    return `<div class="stat-card ${tone ? 'tone-' + tone : ''}">
      <div class="stat-top"><span class="stat-label">${esc(label)}</span>${iconName ? `<span class="stat-icon">${icon(iconName)}</span>` : ''}</div>
      <div class="stat-value">${value}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
    </div>`;
  }

  // Horizontal bar list — a dependency-free "chart" that works offline and prints cleanly.
  function barList(items, { formatter } = {}) {
    const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
    const fmt = formatter || money;
    return `<div class="bar-list">${items.map((i) => `
      <div class="bar-row">
        <span class="bar-label">${esc(i.label)}</span>
        <span class="bar-track"><span class="bar-fill ${i.tone ? 'bar-' + i.tone : ''}" style="width:${(Math.abs(i.value) / max * 100).toFixed(1)}%"></span></span>
        <span class="bar-value">${fmt(i.value)}</span>
      </div>`).join('')}</div>`;
  }

  // Date-range picker shared by Training, Payments, Finances and Reports.
  function dateRangeControls(state, idPrefix) {
    const presets = U.DATE_PRESETS;
    return `
      <label class="toolbar-field"><span class="sr-only">Date range</span>
        <select data-filter="preset" id="${idPrefix}-preset">${options(Object.entries(presets).map(([value, label]) => ({ value, label })), state.preset)}</select>
      </label>
      <span class="custom-range" ${state.preset === 'custom' ? '' : 'hidden'}>
        <label class="toolbar-field"><span class="sr-only">From</span><input type="date" data-filter="from" value="${esc(state.from || '')}" aria-label="From date"></label>
        <span class="muted">to</span>
        <label class="toolbar-field"><span class="sr-only">To</span><input type="date" data-filter="to" value="${esc(state.to || '')}" aria-label="To date"></label>
      </span>`;
  }

  // Binds every [data-filter] input in `root` to `state`, calling `update` after each change.
  function bindFilters(root, state, update) {
    root.querySelectorAll('[data-filter]').forEach((el) => {
      const evt = el.tagName === 'SELECT' || el.type === 'date' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        state[el.dataset.filter] = el.value;
        if (el.dataset.filter === 'preset') {
          const custom = root.querySelector('.custom-range');
          if (custom) custom.hidden = el.value !== 'custom';
        }
        update();
      });
    });
  }

  function rangeOf(state) { return U.rangeFromPreset(state.preset, { from: state.from, to: state.to }); }

  function rangeLabel(range) {
    if (!range.from && !range.to) return 'All time';
    if (range.from === range.to) return U.formatDate(range.from);
    return `${range.from ? U.formatDate(range.from) : 'Start'} – ${range.to ? U.formatDate(range.to) : 'Today'}`;
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Simple CSV builder; quotes every cell and neutralises spreadsheet formula injection.
  function toCsv(header, rows) {
    const cell = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  }

  DMB.ui = {
    icon, toast, openModal, confirmDialog, readForm, clearErrors, showErrors, bindSubmit, runAction,
    field, options, mapOptions, employeeOptions, badge, statusBadge, payStatusBadge, paymentTypeBadge,
    trainTypeBadge, money, employeeLink, emptyState, table, pageHeader, panel, statCard, barList, dateRangeControls,
    bindFilters, rangeOf, rangeLabel, downloadFile, toCsv,
  };
})(window.DMB = window.DMB || {});
