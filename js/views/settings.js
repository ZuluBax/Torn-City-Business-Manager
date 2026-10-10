(function (DMB) {
  'use strict';
  const U = DMB.util, C = DMB.calc, db = DMB.db, S = DMB.services, ui = DMB.ui, B = DMB.backup;
  const esc = U.escapeHtml;

  const LISTS = [
    { key: 'positions', title: 'Employee positions', noun: 'position', usage: (v) => db.all('employees').filter((e) => e.position === v).length, usageLabel: 'employee' },
    { key: 'expenseCategories', title: 'Expense categories', noun: 'category', usage: (v) => db.all('expenses').filter((e) => e.category === v).length, usageLabel: 'expense' },
    { key: 'incomeCategories', title: 'Income categories', noun: 'category', usage: (v) => db.all('income').filter((e) => e.category === v).length, usageLabel: 'entry' },
  ];

  function listEditor(cfg) {
    const items = db.settings()[cfg.key];
    return `<div class="list-editor" data-list="${cfg.key}">
      <ul class="chip-list">${items.map((v, i) => {
        const n = cfg.usage(v);
        return `<li class="chip"><span>${esc(v)}</span>${n ? `<span class="chip-count" title="In use">${n}</span>` : ''}
          <button type="button" class="chip-remove" data-remove="${i}" aria-label="Remove ${esc(v)}">${ui.icon('close')}</button></li>`;
      }).join('')}</ul>
      <form class="inline-add" data-add novalidate>
        <div class="field"><label class="sr-only" for="add-${cfg.key}">New ${cfg.noun}</label><input id="add-${cfg.key}" name="value" placeholder="Add ${cfg.noun}…" maxlength="40" autocomplete="off"></div>
        <button type="submit" class="btn btn-ghost btn-sm">${ui.icon('plus')} Add</button>
      </form>
    </div>`;
  }

  function render(el) {
    const s = db.settings();
    const counts = ['employees', 'training', 'payments', 'expenses', 'income'].map((k) => `${db.all(k).length} ${k}`).join(' · ');
    const demo = B.hasDemo();
    const onPi = db.mode === 'server';

    el.innerHTML = `
      ${ui.pageHeader('Settings', 'Company details, lists, appearance and backups.')}
      <div class="grid-2">
        ${ui.panel('Company & training', `
          <form id="company-form" class="form-grid" novalidate>
            <p class="form-error" role="alert" hidden></p>
            ${ui.field({ label: 'Company name', name: 'companyName', value: s.companyName, required: true, attrs: 'maxlength="60"' })}
            ${ui.field({ label: 'Currency symbol', name: 'currency', value: s.currency, required: true, attrs: 'maxlength="3"' })}
            ${ui.field({ label: 'Default train price', name: 'trainPrice', value: String(s.trainPrice), required: true, full: true, attrs: 'inputmode="numeric" autocomplete="off"', hint: 'Used for new training records only. Past records keep the price they were recorded with.' })}
            <div class="field-full form-actions"><button type="submit" class="btn btn-primary">Save</button></div>
          </form>`)}
        ${ui.panel('Appearance', `
          <div class="segmented" role="radiogroup" aria-label="Theme">
            <label><input type="radio" name="theme" value="dark" ${s.theme !== 'light' ? 'checked' : ''}><span>Dark</span></label>
            <label><input type="radio" name="theme" value="light" ${s.theme === 'light' ? 'checked' : ''}><span>Light</span></label>
          </div>
          <h3 class="subhead">Dashboard banner</h3>
          ${s.banner
            ? `<img src="${esc(s.banner)}" alt="Current banner" class="banner-img banner-preview">`
            : '<p class="small muted">No banner yet. Torn company banners are 400×100. Larger images (e.g. 1200×300) look sharper.</p>'}
          <div class="button-row">
            <label class="btn btn-ghost btn-sm file-btn">${ui.icon('upload')} ${s.banner ? 'Replace banner' : 'Upload banner'}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-act="banner" hidden></label>
            ${s.banner ? '<button type="button" class="btn btn-ghost btn-sm btn-danger-ghost" data-act="banner-remove">Remove</button>' : ''}
          </div>
          <h3 class="subhead">Employee statuses</h3>
          <p class="muted small">Statuses are fixed because the app's maths depends on them:</p>
          <ul class="plain-list small">
            <li>${ui.statusBadge('active')} Working now. Salary is counted.</li>
            <li>${ui.statusBadge('inactive')} Still employed but not active. Salary is still counted until an end date is set.</li>
            <li>${ui.statusBadge('left')} Has left. Salary stops on their end date. History is kept.</li>
          </ul>`)}
      </div>

      <div class="grid-3">
        ${LISTS.map((cfg) => ui.panel(cfg.title, listEditor(cfg))).join('')}
      </div>

      ${ui.panel('Job limits', `
        <p class="muted small">The most people you want in each job. Job suggestions on the Employees page give a full job to the strongest people, and point everyone else at their next-best job. Leave a box empty for no limit. Use 0 to never suggest that job.</p>
        <form id="limits-form" class="form-grid form-grid-limits" novalidate>
          <p class="form-error" role="alert" hidden></p>
          ${DMB.jobs.JOBS.map((j) => ui.field({ label: j.name, name: j.name, value: s.jobLimits && s.jobLimits[j.name] != null ? String(s.jobLimits[j.name]) : '', placeholder: 'No limit', attrs: 'inputmode="numeric" autocomplete="off" maxlength="2"' })).join('')}
          <div class="field-full form-actions"><button type="submit" class="btn btn-primary">Save limits</button></div>
        </form>`)}

      ${ui.panel('Torn API', `
        <p class="muted small">Used when you press <strong>Import from Torn</strong>. The app reads your company (employees, wages, funds, trains available, company news) and shows you a preview before saving anything. Use a <strong>Limited Access</strong> key. ${onPi
          ? 'The key is kept on the Pi (never sent back to browsers or put in backups). The Pi also refreshes company funds, trains available and staff activity every 15 minutes.'
          : 'The key stays in this browser and is never put in backup files.'}</p>
        <form id="torn-form" class="inline-add" novalidate>
          <div class="field"><label class="sr-only" for="torn-key">Torn API key</label>
            <input id="torn-key" name="tornApiKey" type="password" value="${esc(s.tornApiKey || '')}" placeholder="${db.hasTornKey() ? 'Key saved — type a new one to replace it' : '16-character API key'}" maxlength="16" autocomplete="off" spellcheck="false"></div>
          <button type="button" class="btn btn-ghost btn-sm" data-act="key-toggle">${ui.icon('eye')} Show</button>
          <button type="submit" class="btn btn-ghost btn-sm">Save key</button>
          ${db.hasTornKey() ? '<button type="button" class="btn btn-ghost btn-sm btn-danger-ghost" data-act="key-remove">Remove key</button>' : ''}
        </form>
        <div class="button-row">
          <button type="button" class="btn btn-primary" data-act="torn-import" ${db.hasTornKey() ? '' : 'disabled'}>${ui.icon('download')} Import from Torn</button>
        </div>
        ${s.tornLastSync ? `<p class="small muted">Last import: ${esc(U.formatDateTime(s.tornLastSync))}</p>` : ''}`)}

      ${ui.panel('Backup & data', `
        ${onPi
          ? '<p class="muted">Your data is stored on the Pi and shared by every device that opens this address. The Pi saves a backup copy every night (5 days kept). Exporting a backup file now and then is still a good idea in case the Pi\'s SD card fails.</p>'
          : '<p class="muted">Your data lives inside this browser on this PC. <strong>Export a backup regularly</strong> — clearing browser data, or opening the app in a different browser, will not show it.</p>'}
        <p class="small muted">Currently stored: ${counts}.</p>
        <div class="button-row">
          <button type="button" class="btn btn-primary" data-act="export">${ui.icon('download')} Export backup</button>
          <label class="btn btn-ghost file-btn">${ui.icon('upload')} Import backup<input type="file" accept=".json,application/json" data-act="import" hidden></label>
        </div>
        <h3 class="subhead">Demo data</h3>
        <p class="small muted">Adds a few clearly-labelled <code>[DEMO]</code> records so you can try things out. They can be removed at any time without touching your real data.</p>
        <div class="button-row">
          <button type="button" class="btn btn-ghost" data-act="demo-load" ${demo ? 'disabled' : ''}>Load demo data</button>
          <button type="button" class="btn btn-ghost" data-act="demo-remove" ${demo ? '' : 'disabled'}>Remove demo data</button>
        </div>
        <h3 class="subhead danger-text">Danger zone</h3>
        <div class="button-row">
          <button type="button" class="btn btn-danger" data-act="reset">${ui.icon('trash')} Reset all data</button>
        </div>`, { cls: 'panel-backup' })}
    `;

    ui.bindSubmit(el.querySelector('#company-form'), (data) => S.saveSettings(data), { onSuccess() { ui.toast('Settings saved'); } });
    ui.bindSubmit(el.querySelector('#limits-form'), (data) => S.saveSettings({ jobLimits: data }), { onSuccess() { ui.toast('Job limits saved'); } });

    el.querySelectorAll('input[name=theme]').forEach((r) => r.addEventListener('change', () => ui.runAction(() => S.saveSettings({ theme: r.value }))));

    for (const cfg of LISTS) {
      const root = el.querySelector(`[data-list="${cfg.key}"]`);
      const addForm = root.querySelector('[data-add]');
      addForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = addForm.elements.value.value.trim();
        if (!value) return;
        try {
          await S.saveSettings({ [cfg.key]: [...db.settings()[cfg.key], value] });
          ui.toast(`Added "${value}"`);
        } catch (err) {
          if (err instanceof S.ValidationError) ui.showErrors(addForm, { value: Object.values(err.fields)[0] });
          else ui.toast(err.message, 'error');
        }
      });
      root.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
        const list = db.settings()[cfg.key];
        const value = list[Number(b.dataset.remove)];
        const n = cfg.usage(value);
        if (n) {
          const ok = await ui.confirmDialog({
            title: `Remove "${value}"?`,
            message: `${n} ${cfg.usageLabel}${n === 1 ? '' : 's'} still use this ${cfg.noun}. They will keep it, but it won't be offered for new records.`,
            confirmText: 'Remove',
          });
          if (!ok) return;
        }
        ui.runAction(() => S.saveSettings({ [cfg.key]: list.filter((x) => x !== value) }), `Removed "${value}"`);
      }));
    }

    el.querySelector('[data-act=banner]').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { ui.toast('Choose a PNG, JPEG, WebP or GIF image.', 'error'); return; }
      if (file.size > 500 * 1024) { ui.toast('That image is over 500 KB. Use a smaller one.', 'error'); return; }
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Could not read the image.'));
        r.readAsDataURL(file);
      }).catch((err) => { ui.toast(err.message, 'error'); return null; });
      if (dataUrl) ui.runAction(() => S.saveSettings({ banner: dataUrl }), 'Banner saved');
    });
    const bannerRemove = el.querySelector('[data-act=banner-remove]');
    if (bannerRemove) bannerRemove.addEventListener('click', () => ui.runAction(() => S.saveSettings({ banner: '' }), 'Banner removed'));

    const tornForm = el.querySelector('#torn-form');
    // Saving an empty box must not silently delete a saved key (on the Pi the box always
    // starts empty), so removal has its own button.
    ui.bindSubmit(tornForm, (d) => {
      if (!d.tornApiKey.trim()) throw new S.ValidationError({ tornApiKey: 'Type the 16-character key to save it.' });
      return S.saveSettings({ tornApiKey: d.tornApiKey });
    }, { onSuccess() { ui.toast('Torn API key saved'); } });
    const removeKey = el.querySelector('[data-act=key-remove]');
    if (removeKey) removeKey.addEventListener('click', async () => {
      const ok = await ui.confirmDialog({ title: 'Remove Torn API key?', message: 'Import from Torn and the automatic refresh will stop until you add a key again.', confirmText: 'Remove key', danger: true });
      if (ok) ui.runAction(() => S.saveSettings({ tornApiKey: '' }), 'Torn API key removed');
    });
    el.querySelector('[data-act=key-toggle]').addEventListener('click', (e) => {
      const input = tornForm.elements.tornApiKey;
      input.type = input.type === 'password' ? 'text' : 'password';
      e.currentTarget.lastChild.textContent = input.type === 'password' ? ' Show' : ' Hide';
    });
    el.querySelector('[data-act=torn-import]').addEventListener('click', () => DMB.forms.tornImport());

    el.querySelector('[data-act=export]').addEventListener('click', () => {
      try { ui.toast(`Saved ${B.exportBackup()} to your Downloads`); } catch (e) { ui.toast(`Export failed: ${e.message}`, 'error'); }
    });

    el.querySelector('[data-act=import]').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      let backup;
      try { backup = await B.parseBackupFile(file); } catch (err) { ui.toast(`Import failed: ${err.message}`, 'error'); return; }
      const d = backup.data;
      const ok = await ui.confirmDialog({
        title: 'Replace all data with this backup?',
        message: `Backup from <strong>${esc(U.formatDateTime(backup.exportedAt))}</strong> contains ${d.employees.length} employees, ${d.training.length} training records and ${d.payments.length} payments.<br><br>
                  <strong>Everything currently in the app will be replaced.</strong> Export a backup first if you might need the current data.`,
        confirmText: 'Replace data', danger: true,
      });
      if (!ok) return;
      ui.runAction(async () => { await B.restore(backup); DMB.app.applyTheme(); }, 'Backup imported');
    });

    el.querySelector('[data-act=demo-load]').addEventListener('click', () => ui.runAction(() => B.loadDemo(), 'Demo data loaded'));
    el.querySelector('[data-act=demo-remove]').addEventListener('click', async () => {
      const ok = await ui.confirmDialog({ title: 'Remove demo data?', message: 'All records marked [DEMO] will be deleted. Your real records are not affected.', confirmText: 'Remove demo data', danger: true });
      if (ok) ui.runAction(() => B.removeDemo(), 'Demo data removed');
    });

    el.querySelector('[data-act=reset]').addEventListener('click', async () => {
      const ok = await ui.confirmDialog({
        title: 'Reset all data?',
        message: 'This permanently deletes <strong>every</strong> employee, training record, payment, income, expense and setting. It cannot be undone.<br><br>Export a backup first if you might need anything.',
        confirmText: 'Delete everything', danger: true, typeToConfirm: 'RESET',
      });
      if (ok) ui.runAction(async () => { await B.resetAll(); DMB.app.applyTheme(); }, 'All data reset');
    });
  }

  DMB.views = DMB.views || {};
  DMB.views.settings = { title: 'Settings', render };
})(window.DMB = window.DMB || {});
