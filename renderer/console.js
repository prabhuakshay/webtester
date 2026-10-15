'use strict';

/* global icon */
// Unified console: collects console output, uncaught exceptions and browser
// log entries from every pane. Identical messages are grouped across panes so
// you can see at a glance whether an error happens everywhere or only at one
// breakpoint / color scheme.
window.WTConsole = (() => {
  const MAX_ENTRIES = 5000;
  const MAX_ROWS = 800;
  const LEVEL_ICON = { error: 'error', warning: 'alert', info: 'info', log: 'info', debug: 'bug', nav: 'globe' };

  let entries = [];
  let seq = 0;
  let opts = { levels: { error: true, warning: true, info: true, debug: false }, pane: 'all', search: '', grouped: true, preserve: false };
  let hooks = { getPanes: () => [], onSelector: () => {}, onChange: () => {}, onOptions: () => {} };
  let root, listEl, emptyEl, paneSel, searchEl;
  const expanded = new Set();
  let renderQueued = false;
  let stickToBottom = true;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const levelGroup = (l) => (l === 'log' ? 'info' : l === 'nav' ? 'info' : l);

  function init(el, h, initialOpts) {
    root = el;
    hooks = { ...hooks, ...h };
    if (initialOpts) opts = { ...opts, ...initialOpts, levels: { ...opts.levels, ...(initialOpts.levels || {}) } };
    root.innerHTML = `
      <div class="con-bar">
        <span class="con-title">${icon('terminal', 14)} Console</span>
        <div class="con-levels">
          <button class="chip-btn lvl-error" data-level="error">${icon('error', 13)} Errors <b data-count="error">0</b></button>
          <button class="chip-btn lvl-warning" data-level="warning">${icon('alert', 13)} Warnings <b data-count="warning">0</b></button>
          <button class="chip-btn lvl-info" data-level="info">${icon('info', 13)} Info <b data-count="info">0</b></button>
          <button class="chip-btn lvl-debug" data-level="debug">${icon('bug', 13)} Verbose <b data-count="debug">0</b></button>
        </div>
        <select class="con-pane" title="Filter by pane"></select>
        <input class="con-search" type="search" placeholder="Filter messages" spellcheck="false">
        <label class="con-toggle" title="Merge identical messages from different panes"><input type="checkbox" data-opt="grouped"> Group panes</label>
        <label class="con-toggle" title="Keep messages when panes navigate"><input type="checkbox" data-opt="preserve"> Preserve log</label>
        <span class="spacer"></span>
        <button class="icon-btn" data-act="clear" title="Clear console">${icon('broom', 15)}</button>
        <button class="icon-btn" data-act="close" title="Close console (Ctrl+Shift+J)">${icon('x', 15)}</button>
      </div>
      <div class="con-list" tabindex="0"></div>
      <div class="con-empty">No messages yet. Errors, warnings and logs from every pane show up here.</div>`;
    listEl = root.querySelector('.con-list');
    emptyEl = root.querySelector('.con-empty');
    paneSel = root.querySelector('.con-pane');
    searchEl = root.querySelector('.con-search');

    root.querySelectorAll('[data-level]').forEach((b) => {
      b.addEventListener('click', () => {
        opts.levels[b.dataset.level] = !opts.levels[b.dataset.level];
        optionsChanged();
      });
    });
    root.querySelectorAll('[data-opt]').forEach((c) => {
      c.addEventListener('change', () => {
        opts[c.dataset.opt] = c.checked;
        optionsChanged();
      });
    });
    paneSel.addEventListener('change', () => {
      opts.pane = paneSel.value;
      optionsChanged();
    });
    searchEl.addEventListener('input', () => {
      opts.search = searchEl.value;
      schedule();
    });
    root.querySelector('[data-act="clear"]').addEventListener('click', clearAll);
    listEl.addEventListener('scroll', () => {
      stickToBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 30;
    });
    listEl.addEventListener('click', onListClick);
    syncControls();
    refreshPanes();
  }

  function optionsChanged() {
    syncControls();
    schedule();
    hooks.onOptions(getOptions());
  }

  function syncControls() {
    root.querySelectorAll('[data-level]').forEach((b) => b.classList.toggle('off', !opts.levels[b.dataset.level]));
    root.querySelectorAll('[data-opt]').forEach((c) => { c.checked = !!opts[c.dataset.opt]; });
    if (paneSel) paneSel.value = opts.pane;
  }

  function refreshPanes() {
    if (!paneSel) return;
    const panes = hooks.getPanes();
    paneSel.innerHTML = `<option value="all">All panes</option>${panes.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}`;
    if (opts.pane !== 'all' && !panes.some((p) => p.id === opts.pane)) opts.pane = 'all';
    paneSel.value = opts.pane;
    schedule();
  }

  function add(e) {
    entries.push({ ...e, id: ++seq });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES + 500);
    schedule();
    hooks.onChange();
  }

  function clearPane(paneId, url) {
    if (opts.preserve) {
      add({ paneId, level: 'nav', text: url ? `Navigated to ${url}` : 'Page reloaded', source: 'WebTester', ts: Date.now() });
      return;
    }
    const before = entries.length;
    entries = entries.filter((x) => x.paneId !== paneId);
    if (entries.length !== before) {
      schedule();
      hooks.onChange();
    }
  }

  function removePane(paneId) {
    entries = entries.filter((x) => x.paneId !== paneId);
    refreshPanes();
    hooks.onChange();
  }

  function clearAll() {
    entries = [];
    expanded.clear();
    schedule();
    hooks.onChange();
  }

  function totals(paneId) {
    const t = { error: 0, warning: 0, info: 0, debug: 0 };
    for (const e of entries) {
      if (paneId && e.paneId !== paneId) continue;
      if (e.level === 'nav') continue;
      t[levelGroup(e.level)]++;
    }
    return t;
  }

  function filterEntry(e) {
    if (e.level !== 'nav' && !opts.levels[levelGroup(e.level)]) return false;
    if (opts.pane !== 'all' && e.paneId !== opts.pane) return false;
    if (opts.search) {
      const q = opts.search.toLowerCase();
      if (!`${e.text} ${e.url || ''}`.toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function buildRows() {
    const visible = entries.filter(filterEntry);
    if (!opts.grouped) {
      return visible.map((e) => ({ ...e, key: `e${e.id}`, panes: new Map([[e.paneId, 1]]), count: 1 }));
    }
    const groups = new Map();
    for (const e of visible) {
      const key = e.level === 'nav' ? `n${e.id}` : `${e.level}\u0000${e.text}\u0000${e.url || ''}\u0000${e.line || ''}`;
      let g = groups.get(key);
      if (!g) {
        g = { ...e, key, panes: new Map(), count: 0 };
        groups.set(key, g);
      }
      g.count++;
      g.panes.set(e.paneId, (g.panes.get(e.paneId) || 0) + 1);
      g.ts = e.ts;
    }
    return Array.from(groups.values());
  }

  function shortSource(url, line) {
    if (!url) return '';
    let name = url;
    try {
      const u = new URL(url);
      name = u.pathname.split('/').filter(Boolean).pop() || u.host;
    } catch {
      name = url.split(/[\\/]/).pop();
    }
    return `${name}${line ? `:${line}` : ''}`;
  }

  function chipsHtml(row) {
    const panes = hooks.getPanes();
    const byId = new Map(panes.map((p) => [p.id, p]));
    if (opts.grouped && row.panes.size > 1 && row.panes.size === panes.length) {
      return `<span class="chip all" title="Happens in every pane">All ${panes.length} panes</span>`;
    }
    return Array.from(row.panes.keys())
      .map((id) => {
        const p = byId.get(id);
        if (!p) return '<span class="chip">closed pane</span>';
        return `<span class="chip" data-pane="${esc(id)}" style="--c:${p.color}" title="${esc(p.label)}">${esc(p.short)}</span>`;
      })
      .join('');
  }

  function rowHtml(row) {
    const [first, ...restLines] = String(row.text || '').split('\n');
    const details = [restLines.join('\n'), row.stack].filter(Boolean).join('\n');
    const hasMore = !!details || (row.selectors && row.selectors.length);
    const open = expanded.has(row.key);
    const time = new Date(row.ts || Date.now()).toLocaleTimeString([], { hour12: false });
    const sels = open && row.selectors
      ? `<div class="log-sels">${row.selectors.map((s) => `<button class="sel-link" data-pane="${esc(row.paneId)}" data-sel="${esc(s.selector)}">${esc(s.label)}${s.over ? ` <em>+${s.over}px</em>` : ''}</button>`).join('')}</div>`
      : '';
    return `<div class="log lvl-${row.level}${hasMore ? ' expandable' : ''}${open ? ' open' : ''}" data-key="${esc(row.key)}">
      <span class="log-ico">${icon(LEVEL_ICON[row.level] || 'info', 14)}</span>
      <div class="log-body">
        <div class="log-text">${hasMore ? `<span class="caret">${icon(open ? 'chevron' : 'right', 12)}</span>` : ''}${esc(first)}${row.source && row.source !== 'console' && row.source !== 'exception' ? ` <span class="log-srcType">${esc(row.source)}</span>` : ''}</div>
        ${open && details ? `<pre class="log-stack">${esc(details)}</pre>` : ''}
        ${sels}
      </div>
      <div class="log-meta">
        <span class="log-chips">${chipsHtml(row)}</span>
        ${row.count > 1 ? `<span class="log-count" title="${row.count} occurrences">${row.count}</span>` : ''}
        ${row.url ? `<span class="log-src" title="${esc(row.url)}${row.line ? `:${row.line}` : ''}">${esc(shortSource(row.url, row.line))}</span>` : ''}
        <span class="log-time">${time}</span>
      </div>
    </div>`;
  }

  function onListClick(e) {
    const sel = e.target.closest('.sel-link');
    if (sel) {
      hooks.onSelector(sel.dataset.pane, sel.dataset.sel);
      return;
    }
    const chip = e.target.closest('.chip[data-pane]');
    if (chip) {
      hooks.onSelector(chip.dataset.pane, null);
      return;
    }
    if (window.getSelection().toString()) return;
    const row = e.target.closest('.log.expandable');
    if (!row) return;
    const key = row.dataset.key;
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    schedule();
  }

  function schedule() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  function render() {
    renderQueued = false;
    if (!listEl) return;
    const t = totals(opts.pane === 'all' ? null : opts.pane);
    for (const [lvl, n] of Object.entries(t)) {
      const b = root.querySelector(`[data-count="${lvl}"]`);
      if (b) b.textContent = n;
    }
    if (root.hidden) return;
    const rows = buildRows().slice(-MAX_ROWS);
    listEl.innerHTML = rows.map(rowHtml).join('');
    emptyEl.hidden = rows.length > 0;
    if (stickToBottom) listEl.scrollTop = listEl.scrollHeight;
  }

  function setPaneFilter(paneId) {
    opts.pane = paneId || 'all';
    syncControls();
    schedule();
  }

  function getOptions() {
    return { levels: { ...opts.levels }, grouped: opts.grouped, preserve: opts.preserve };
  }

  return { init, add, clearPane, removePane, clearAll, totals, refreshPanes, render: schedule, setPaneFilter, getOptions };
})();
