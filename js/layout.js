/*
 * Rearrangeable dashboard layout: ONE grid holding every box (number cards and panels), so
 * any box can sit beside any other and gaps get filled.
 *
 * Saved in settings as { items: [{ id, span }] } — span = columns out of 4. Older saves in
 * the { cards, blocks } shape are converted. ids the saved layout doesn't know (a box added
 * in a later version) are appended; ids no longer rendered are dropped.
 *
 * Packing: the grid uses tiny 2px rows and `grid-auto-flow: dense`; each box spans as many
 * rows as its real height needs (measured with ResizeObserver). That lets short boxes stack
 * beside tall ones instead of leaving holes — a CSS-grid "masonry".
 */
(function (DMB) {
  'use strict';

  const COLS = 4;
  const ROW_PX = 2;   // must match grid-auto-rows in CSS
  const GAP_PX = 18;  // vertical spacing, applied as margin-bottom on each item

  const DEFAULT_ITEMS = [
    { id: 'active', span: 1 }, { id: 'dailySalary', span: 1 }, { id: 'trainsSold', span: 1 }, { id: 'trainRevenue', span: 1 },
    { id: 'outstanding', span: 1 }, { id: 'totalSalary', span: 1 }, { id: 'netProfit', span: 1 }, { id: 'trainPrice', span: 1 },
    { id: 'torn', span: 4 }, { id: 'financial', span: 2 }, { id: 'training', span: 2 },
    { id: 'owing', span: 4 }, { id: 'overview', span: 4 }, { id: 'activity', span: 4 },
  ];
  const MIN_SPAN = (kind) => (kind === 'card' ? 1 : 2);

  // Older layout shape -> items. Panel "outstanding" was renamed "owing" so it can't clash
  // with the "outstanding" number card now that both live in one list.
  function fromLegacy(saved) {
    if (!saved || !Array.isArray(saved.cards)) return null;
    const items = saved.cards.map((id) => ({ id, span: 1 }));
    (saved.blocks || []).forEach((b) => b && items.push({ id: b.id === 'outstanding' ? 'owing' : b.id, span: b.wide ? 4 : 2 }));
    return items;
  }

  // available: { id: 'card' | 'block' }
  function resolve(saved, available) {
    const raw = (saved && Array.isArray(saved.items) ? saved.items : fromLegacy(saved)) || [];
    const items = [];
    for (const it of raw) {
      if (!it || !available[it.id] || items.some((x) => x.id === it.id)) continue;
      const span = Math.min(COLS, Math.max(MIN_SPAN(available[it.id]), Number(it.span) || 1));
      // col = pinned start column (1-4); omitted = let the grid place it.
      const col = Number.isInteger(it.col) && it.col >= 1 && it.col + span - 1 <= COLS ? it.col : undefined;
      items.push(col ? { id: it.id, span, col } : { id: it.id, span });
    }
    DEFAULT_ITEMS.forEach((d) => {
      if (available[d.id] && !items.some((x) => x.id === d.id)) {
        // A box new to this layout goes back to its default neighbour position.
        const at = DEFAULT_ITEMS.indexOf(d);
        const prev = DEFAULT_ITEMS.slice(0, at).reverse().find((p) => items.some((x) => x.id === p.id));
        const idx = prev ? items.findIndex((x) => x.id === prev.id) + 1 : 0;
        items.splice(idx, 0, { ...d });
      }
    });
    return items;
  }

  const SIZE_LABEL = { 1: '¼', 2: '½', 3: '¾', 4: 'Full' };
  function nextSpan(span, kind) {
    const min = MIN_SPAN(kind);
    return span >= COLS ? min : span + 1;
  }

  // ---------- Masonry sizing ----------

  let observer = null;
  function pack(container) {
    if (observer) observer.disconnect();
    const size = (item) => {
      const inner = item.firstElementChild;
      if (!inner) return;
      const h = inner.getBoundingClientRect().height;
      item.style.gridRowEnd = `span ${Math.max(1, Math.ceil((h + GAP_PX) / ROW_PX))}`;
    };
    observer = new ResizeObserver((entries) => entries.forEach((e) => size(e.target.parentElement)));
    [...container.children].forEach((item) => { size(item); observer.observe(item.firstElementChild); });
  }

  // ---------- Grid geometry ----------

  function gridMetrics(grid) {
    const cs = getComputedStyle(grid);
    const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
    const gap = parseFloat(cs.columnGap) || 0;
    const r = grid.getBoundingClientRect();
    const colW = (r.width - gap * (cols - 1)) / cols;
    return { cols, gap, colW, left: r.left };
  }

  // Column (1-based) a box starts in, judged from where it is on screen.
  function currentCol(grid, item) {
    const m = gridMetrics(grid);
    return Math.max(1, Math.min(m.cols, Math.round((item.getBoundingClientRect().left - m.left) / (m.colW + m.gap)) + 1));
  }

  // Column a box of `span` would start in if dropped with its middle at clientX.
  function colAtPoint(grid, clientX, span) {
    const m = gridMetrics(grid);
    const s = Math.min(span, m.cols);
    const startX = clientX - (s * m.colW + (s - 1) * m.gap) / 2;
    const col = Math.round((startX - m.left) / (m.colW + m.gap)) + 1;
    return Math.max(1, Math.min(m.cols - s + 1, col));
  }

  // ---------- Drag and drop (mouse, pen and touch) ----------

  /*
   * In arrange mode a box can be grabbed anywhere except its buttons. A see-through copy
   * follows the pointer and a gold outline previews where it will land; nothing moves until
   * release, so boxes don't jump about under the pointer.
   *
   * onDrop(id, { col, refId, where }) — col: start column; refId/where: put the box
   * 'before'/'after' that box in the order (null refId = end of the list).
   * Listeners sit on window: they keep working wherever the pointer goes.
   */
  function makeDraggable(grid, getSpan, onDrop) {
    grid.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, a, input, select, textarea')) return;
      const item = e.target.closest('[data-item]');
      if (!item || item.parentElement !== grid) return;
      const pid = e.pointerId;
      const startX = e.clientX, startY = e.clientY;
      const rect = item.getBoundingClientRect();
      const offX = startX - rect.left, offY = startY - rect.top;
      let ghost = null, marker = null, drop = null;

      const begin = () => {
        ghost = item.cloneNode(true);
        ghost.className += ' drag-ghost';
        Object.assign(ghost.style, { width: rect.width + 'px', height: rect.height + 'px' });
        document.body.appendChild(ghost);
        marker = document.createElement('div');
        marker.className = 'drop-marker';
        document.body.appendChild(marker);
        item.classList.add('dragging');
        document.body.classList.add('is-dragging');
      };

      const move = (ev) => {
        if (ev.pointerId !== pid) return;
        if (!ghost) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return; // a click, not a drag
          begin();
        }
        ev.preventDefault();
        ghost.style.transform = `translate(${ev.clientX - offX}px, ${ev.clientY - offY}px)`;

        const span = Math.min(getSpan(item.dataset.item), gridMetrics(grid).cols);
        const col = colAtPoint(grid, ev.clientX, span);
        // The box whose row band the pointer is in decides the order position.
        const others = [...grid.children].filter((c) => c !== item);
        let refId = null, where = 'after', refRect = null;
        for (const o of others) {
          const r = o.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) { refId = o.dataset.item; where = 'before'; refRect = r; break; }
          refId = o.dataset.item; where = 'after'; refRect = r;
        }
        drop = { col, refId, where };

        const m = gridMetrics(grid);
        const x = m.left + (col - 1) * (m.colW + m.gap);
        const w = span * m.colW + (span - 1) * m.gap;
        const y = refRect ? (where === 'before' ? refRect.top : refRect.bottom) : grid.getBoundingClientRect().top;
        Object.assign(marker.style, { left: x + 'px', top: (y - 6) + 'px', width: w + 'px' });
      };

      const end = (ev) => {
        if (ev.pointerId !== pid) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        if (!ghost) return;
        ghost.remove(); marker.remove();
        item.classList.remove('dragging');
        document.body.classList.remove('is-dragging');
        if (ev.type === 'pointerup' && drop) onDrop(item.dataset.item, drop);
      };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
  }

  /*
   * ↑ / ↓ arrows: find the nearest box visually above / below (overlapping horizontally) and
   * move in front of / after it, so "up" means up on screen even when boxes of different
   * sizes share a row. (← / → change the box's start column instead; see the dashboard.)
   */
  function moveTarget(container, item, dir) {
    const items = [...container.children];
    const r = item.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    let best = null, bestDist = Infinity;
    for (const other of items) {
      if (other === item) continue;
      const o = other.getBoundingClientRect();
      const overlaps = o.left < r.right - 4 && o.right > r.left + 4;
      const isAbove = o.bottom <= r.top + 4, isBelow = o.top >= r.bottom - 4;
      if ((dir === 'up' && !isAbove) || (dir === 'down' && !isBelow)) continue;
      const dy = dir === 'up' ? r.top - o.bottom : o.top - r.bottom;
      const dist = dy * 10 + (overlaps ? 0 : 5000) + Math.abs(o.left + o.width / 2 - cx);
      if (dist < bestDist) { bestDist = dist; best = other; }
    }
    return best ? { ref: best, where: dir === 'up' ? 'before' : 'after' } : null;
  }

  function ids(container) { return [...container.children].map((c) => c.dataset.item).filter(Boolean); }

  function editBar(label, span) {
    const ui = DMB.ui;
    const arrow = (dir, name, cls) => `<button type="button" class="icon-btn ${cls}" data-move="${dir}" aria-label="Move ${label} ${name}" title="Move ${name}">${ui.icon('back')}</button>`;
    return `<div class="edit-bar">
      <button type="button" class="edit-handle" data-drag aria-label="Drag to move ${label}" title="Drag to move">⠿</button>
      <span class="edit-label">${DMB.util.escapeHtml(label)}</span>
      ${arrow('up', 'up', 'rot-up')}${arrow('down', 'down', 'rot-down')}${arrow('left', 'left', '')}${arrow('right', 'right', 'flip')}
      <button type="button" class="btn btn-sm btn-ghost edit-size" data-size title="Change width">${SIZE_LABEL[span]}</button>
    </div>`;
  }

  DMB.layout = { DEFAULT_ITEMS, resolve, nextSpan, pack, makeDraggable, moveTarget, currentCol, gridMetrics, editBar, ids };
})(window.DMB = window.DMB || {});
