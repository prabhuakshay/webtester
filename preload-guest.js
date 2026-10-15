'use strict';

// Runs inside every pane (isolated world). Captures user interactions and
// relays them to the host, replays interactions from other panes, draws
// overlays and runs layout checks.
const { ipcRenderer } = require('electron');

const send = (type, data = {}) => {
  try {
    ipcRenderer.sendToHost('wt', { type, ...data });
  } catch {
    /* host gone */
  }
};
const now = () => performance.now();

let cfg = { sync: {}, scrollMode: 'percent', outlines: false, overflowMarkers: true, inspect: false, mobile: false };
// Ignore our own scroll/hover events for a moment after replaying remote ones.
const quiet = { scroll: 0, hover: 0 };

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

function uniqueId(id) {
  try {
    return document.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
  } catch {
    return false;
  }
}

function cssPath(node) {
  let el = node && node.nodeType === 1 ? node : node && node.parentElement;
  if (!el) return null;
  const parts = [];
  while (el && el.nodeType === 1) {
    if (el === document.documentElement) { parts.unshift('html'); break; }
    if (el === document.body) { parts.unshift('body'); break; }
    if (el.id && uniqueId(el.id)) { parts.unshift(`#${CSS.escape(el.id)}`); break; }
    let part = CSS.escape(el.localName);
    const parent = el.parentElement;
    if (parent) {
      let index = 0;
      let count = 0;
      for (const c of parent.children) {
        if (c.localName === el.localName) {
          count++;
          if (c === el) index = count;
        }
      }
      if (count > 1) part += `:nth-of-type(${index})`;
    }
    parts.unshift(part);
    el = parent;
  }
  return parts.join(' > ');
}

function find(selector) {
  if (!selector) return null;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function describe(el) {
  let s = el.localName;
  if (el.id) s += `#${el.id}`;
  const cls = Array.from(el.classList).slice(0, 2);
  if (cls.length) s += `.${cls.join('.')}`;
  return s;
}

const isRendered = (el) => el && el.isConnected && el.getClientRects().length > 0;

// ---------------------------------------------------------------------------
// Activity (tells the host which pane the user is working in)
// ---------------------------------------------------------------------------

let lastActivity = 0;
function activity(e) {
  if (!e.isTrusted) return;
  const t = now();
  if (t - lastActivity < 400) return;
  lastActivity = t;
  send('activity');
}
addEventListener('pointerdown', activity, true);
addEventListener('keydown', activity, true);
addEventListener('wheel', activity, { capture: true, passive: true });

// ---------------------------------------------------------------------------
// Scroll sync
// ---------------------------------------------------------------------------

const docScroller = () => document.scrollingElement || document.documentElement;
const probeY = () => Math.min(120, innerHeight / 4);

function anchorAtProbe() {
  const y = probeY();
  for (const x of [innerWidth / 2, innerWidth / 4, (3 * innerWidth) / 4]) {
    let el = document.elementFromPoint(x, y);
    if (!el || el === document.body || el === document.documentElement) continue;
    let fixed = false;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const pos = getComputedStyle(a).position;
      if (pos === 'fixed' || pos === 'sticky') { fixed = true; break; }
    }
    if (fixed) continue;
    while (el.parentElement && el.parentElement !== document.body && el.getBoundingClientRect().height < 48) el = el.parentElement;
    const r = el.getBoundingClientRect();
    if (!r.height) continue;
    return { selector: cssPath(el), frac: (y - r.top) / r.height };
  }
  return null;
}

function scrollMessage(t) {
  const isDoc = !t || t === document || t === document.documentElement || t === document.body || t === docScroller();
  if (isDoc) {
    const se = docScroller();
    const maxY = se.scrollHeight - innerHeight;
    const maxX = se.scrollWidth - innerWidth;
    const msg = { selector: null, px: scrollX, py: scrollY, fx: maxX > 0 ? scrollX / maxX : 0, fy: maxY > 0 ? scrollY / maxY : 0 };
    if (cfg.scrollMode === 'anchor') msg.anchor = anchorAtProbe();
    return msg;
  }
  if (t.nodeType !== 1) return null;
  const maxY = t.scrollHeight - t.clientHeight;
  const maxX = t.scrollWidth - t.clientWidth;
  return { selector: cssPath(t), px: t.scrollLeft, py: t.scrollTop, fx: maxX > 0 ? t.scrollLeft / maxX : 0, fy: maxY > 0 ? t.scrollTop / maxY : 0 };
}

let scrollRaf = 0;
let scrollTarget = null;
addEventListener('scroll', (e) => {
  redrawOverlaysSoon();
  if (!cfg.sync.scroll || now() < quiet.scroll) return;
  scrollTarget = e.target;
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const msg = scrollMessage(scrollTarget);
    scrollTarget = null;
    if (msg) send('scroll', msg);
  });
}, { capture: true, passive: true });

function applyScroll(m) {
  quiet.scroll = now() + 200;
  if (m.selector) {
    const el = find(m.selector);
    if (!el) return;
    const maxY = el.scrollHeight - el.clientHeight;
    const maxX = el.scrollWidth - el.clientWidth;
    const top = cfg.scrollMode === 'pixels' ? m.py : m.fy * maxY;
    const left = cfg.scrollMode === 'pixels' ? m.px : m.fx * maxX;
    el.scrollTo({ top, left, behavior: 'instant' });
    return;
  }
  const se = docScroller();
  const maxY = se.scrollHeight - innerHeight;
  const maxX = se.scrollWidth - innerWidth;
  let top = m.fy * maxY;
  let left = m.fx * maxX;
  if (cfg.scrollMode === 'pixels') {
    top = m.py;
    left = m.px;
  } else if (cfg.scrollMode === 'anchor' && m.anchor && m.fy > 0.002 && m.fy < 0.998) {
    const el = find(m.anchor.selector);
    if (isRendered(el)) {
      const r = el.getBoundingClientRect();
      top = scrollY + r.top + m.anchor.frac * r.height - probeY();
    }
  }
  window.scrollTo({ top, left, behavior: 'instant' });
}

// ---------------------------------------------------------------------------
// Click / input / key sync
// ---------------------------------------------------------------------------

addEventListener('click', (e) => {
  if (!e.isTrusted || !cfg.sync.click) return;
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const selector = cssPath(e.target);
  if (selector) send('click', { selector });
}, true);

function applyClick(m) {
  const el = find(m.selector);
  // Skip elements hidden at this breakpoint (e.g. a mobile-only hamburger).
  if (!isRendered(el)) return;
  const r = el.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
  const ptr = { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
  try {
    el.dispatchEvent(new PointerEvent('pointerdown', ptr));
    el.dispatchEvent(new MouseEvent('mousedown', base));
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', ptr));
    el.dispatchEvent(new MouseEvent('mouseup', base));
  } catch {
    /* ignore */
  }
  el.click();
}

function onInput(e) {
  if (!e.isTrusted || !cfg.sync.input) return;
  const el = e.target;
  if (!el || el.nodeType !== 1) return;
  const selector = cssPath(el);
  if (!selector) return;
  if (el.isContentEditable) {
    send('input', { selector, editable: true, html: el.innerHTML });
    return;
  }
  if (!('value' in el) || el.type === 'file') return;
  send('input', { selector, value: el.value, checked: !!el.checked, kind: e.type });
}
addEventListener('input', onInput, true);
addEventListener('change', onInput, true);

function nativeValueSetter(el) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, 'value').set;
}

function applyInput(m) {
  const el = find(m.selector);
  if (!el) return;
  if (m.editable) {
    if (el.isContentEditable && el.innerHTML !== m.html) {
      el.innerHTML = m.html;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return;
  }
  if (el.type === 'checkbox' || el.type === 'radio') {
    if (el.checked !== m.checked) el.click();
    return;
  }
  if (el.value !== m.value) {
    try {
      nativeValueSetter(el).call(el, m.value);
    } catch {
      el.value = m.value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (m.kind === 'change') el.dispatchEvent(new Event('change', { bubbles: true }));
}

const SYNC_KEYS = new Set(['Enter', 'Escape', 'ArrowUp', 'ArrowDown']);
addEventListener('keydown', (e) => {
  if (!e.isTrusted || !cfg.sync.input || !SYNC_KEYS.has(e.key)) return;
  send('key', { selector: cssPath(e.target), key: e.key, code: e.code });
}, true);

const NO_SUBMIT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'color', 'range']);
function applyKey(m) {
  const el = find(m.selector) || document.activeElement || document.body;
  if (!el) return;
  const init = { key: m.key, code: m.code, bubbles: true, cancelable: true, composed: true };
  const notCancelled = el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  if (m.key === 'Enter' && notCancelled && el instanceof HTMLInputElement && el.form && !NO_SUBMIT.has(el.type)) {
    try {
      el.form.requestSubmit();
    } catch {
      /* invalid form */
    }
  }
}

// ---------------------------------------------------------------------------
// Hover sync + cross-pane inspect
// ---------------------------------------------------------------------------

let lastHoverSel = null;
let hoverTimer = 0;
let lastInspectSel = null;

addEventListener('mouseover', (e) => {
  if (!e.isTrusted) return;
  if (cfg.inspect) inspectHover(e.target);
  if (!cfg.sync.hover || now() < quiet.hover) return;
  const selector = cssPath(e.target);
  if (!selector || selector === lastHoverSel) return;
  lastHoverSel = selector;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => send('hover', { selector }), 40);
}, true);

document.addEventListener('mouseleave', () => {
  lastHoverSel = null;
  if (cfg.inspect && lastInspectSel) {
    lastInspectSel = null;
    highlight.el = null;
    drawHighlight();
    send('unhighlight');
  }
});

function applyHover(m) {
  const el = find(m.selector);
  if (!isRendered(el)) return;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return;
  quiet.hover = now() + 400;
  send('hover-point', { x, y });
}

function inspectHover(target) {
  if (!target || target.nodeType !== 1) return;
  const selector = cssPath(target);
  if (selector === lastInspectSel) return;
  lastInspectSel = selector;
  highlight.el = target;
  highlight.until = 0;
  drawHighlight();
  send('highlight', { selector });
}

// ---------------------------------------------------------------------------
// Overlay layer (closed shadow root, never intercepts pointer events)
// ---------------------------------------------------------------------------

let layerHost = null;
let layerRoot = null;

function layer() {
  if (layerHost && layerHost.isConnected) return layerRoot;
  if (!document.documentElement) return null;
  layerHost = document.createElement('webtester-overlay');
  layerHost.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict;';
  layerRoot = layerHost.attachShadow({ mode: 'closed' });
  layerRoot.innerHTML = `<style>
    .box{position:fixed;box-sizing:border-box;pointer-events:none}
    .hl{background:rgba(91,140,255,.16);outline:2px solid #5b8cff;outline-offset:-1px}
    .of{outline:2px dashed #ff4d6a;outline-offset:-2px;background:rgba(255,77,106,.10)}
    .tag{position:fixed;font:600 11px/1.5 ui-monospace,Consolas,monospace;padding:1px 6px;border-radius:4px;white-space:nowrap;color:#fff;pointer-events:none;max-width:90vw;overflow:hidden;text-overflow:ellipsis}
    .tag.hl{background:#2f5fe0;outline:none}
    .tag.of{background:#e0244a;outline:none}
  </style><div id="hl"></div><div id="of"></div>`;
  document.documentElement.appendChild(layerHost);
  return layerRoot;
}

function boxHtml(r, cls, label) {
  const tagTop = r.top > 22 ? r.top - 20 : r.bottom + 2;
  const left = Math.max(0, Math.min(r.left, innerWidth - 60));
  return `<div class="box ${cls}" style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px"></div>`
    + (label ? `<div class="tag ${cls}" style="left:${left}px;top:${tagTop}px">${label}</div>` : '');
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const highlight = { el: null, until: 0 };
let highlightTimer = 0;

function drawHighlight() {
  const root = layer();
  if (!root) return;
  const c = root.getElementById('hl');
  const el = highlight.el;
  if (!isRendered(el)) {
    c.innerHTML = '';
    return;
  }
  const r = el.getBoundingClientRect();
  c.innerHTML = boxHtml(r, 'hl', escHtml(`${describe(el)}  ${Math.round(r.width)} × ${Math.round(r.height)}`));
}

function setRemoteHighlight(selector, { scroll = false, duration = 0 } = {}) {
  const el = find(selector);
  highlight.el = el;
  if (el && scroll) {
    quiet.scroll = now() + 300;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  }
  drawHighlight();
  clearTimeout(highlightTimer);
  if (duration) {
    highlightTimer = setTimeout(() => {
      highlight.el = null;
      drawHighlight();
    }, duration);
  }
}

let overlayRaf = 0;
function redrawOverlaysSoon() {
  if (overlayRaf || (!highlight.el && !overflow.culprits.length)) return;
  overlayRaf = requestAnimationFrame(() => {
    overlayRaf = 0;
    drawHighlight();
    drawOverflow();
  });
}
addEventListener('resize', () => {
  redrawOverlaysSoon();
  scheduleChecks(300);
});

// ---------------------------------------------------------------------------
// Debug outlines
// ---------------------------------------------------------------------------

function applyOutlines() {
  let st = document.getElementById('__webtester_outlines');
  if (cfg.outlines) {
    if (!st && document.documentElement) {
      st = document.createElement('style');
      st.id = '__webtester_outlines';
      st.textContent = '*:not(webtester-overlay){outline:1px solid rgba(255,0,110,.45)!important;outline-offset:-1px!important}';
      (document.head || document.documentElement).appendChild(st);
    }
  } else if (st) {
    st.remove();
  }
}

// ---------------------------------------------------------------------------
// Layout checks: horizontal overflow + missing viewport meta
// ---------------------------------------------------------------------------

const overflow = { culprits: [] };
let checkTimer = 0;
let lastReport = '';

function scheduleChecks(delay = 600) {
  if (checkTimer) return;
  checkTimer = setTimeout(() => {
    checkTimer = 0;
    runChecks();
  }, delay);
}

function clippedByAncestor(el, vw) {
  for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.position === 'fixed') return a;
    if (cs.overflowX !== 'visible') {
      const r = a.getBoundingClientRect();
      if (r.right + scrollX <= vw + 1) return a;
    }
  }
  return null;
}

function findCulprits(vw) {
  const out = [];
  const all = document.body.getElementsByTagName('*');
  const max = Math.min(all.length, 8000);
  let clipper = null;
  for (let i = 0; i < max; i++) {
    const el = all[i];
    if (el === layerHost) continue;
    if (out.length && out[out.length - 1].contains(el)) continue;
    if (clipper && clipper.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right + scrollX <= vw + 1) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.display === 'none') continue;
    const c = clippedByAncestor(el, vw);
    if (c) {
      clipper = c;
      continue;
    }
    out.push(el);
    if (out.length >= 40) break;
  }
  return out;
}

function runChecks() {
  const de = document.documentElement;
  if (!de || !document.body) return;
  const vw = de.clientWidth;
  const sw = Math.max(de.scrollWidth, document.body.scrollWidth);
  const overflowPx = Math.max(0, sw - vw);
  overflow.culprits = overflowPx > 0 ? findCulprits(vw) : [];
  drawOverflow();

  const report = {
    overflowPx,
    viewport: vw,
    culprits: overflow.culprits.slice(0, 12).map((el) => {
      const r = el.getBoundingClientRect();
      return { selector: cssPath(el), label: describe(el), over: Math.round(r.right + scrollX - vw) };
    }),
    noViewportMeta: !document.querySelector('meta[name="viewport" i]'),
  };
  const key = JSON.stringify(report);
  if (key !== lastReport) {
    lastReport = key;
    send('checks', report);
  }
}

function drawOverflow() {
  if (!overflow.culprits.length && !layerRoot) return;
  const root = layer();
  if (!root) return;
  const c = root.getElementById('of');
  if (!cfg.overflowMarkers || !overflow.culprits.length) {
    c.innerHTML = '';
    return;
  }
  const vw = document.documentElement.clientWidth;
  c.innerHTML = overflow.culprits
    .filter((el) => el.isConnected)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return boxHtml(r, 'of', escHtml(`${describe(el)} overflows +${Math.round(r.right + scrollX - vw)}px`));
    })
    .join('');
}

addEventListener('DOMContentLoaded', () => {
  applyOutlines();
  scheduleChecks(250);
  new MutationObserver(() => scheduleChecks(800)).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
});
addEventListener('load', () => scheduleChecks(300));
addEventListener('load', (e) => {
  if (e.target && e.target.tagName === 'IMG') scheduleChecks(600);
}, true);

// ---------------------------------------------------------------------------
// Messages from the host
// ---------------------------------------------------------------------------

ipcRenderer.on('wt:config', (_e, c) => {
  cfg = c;
  applyOutlines();
  drawOverflow();
  if (!cfg.inspect && lastInspectSel) {
    lastInspectSel = null;
    highlight.el = null;
    drawHighlight();
  }
});

ipcRenderer.on('wt:apply', (_e, m) => {
  try {
    switch (m.type) {
      case 'scroll': applyScroll(m); break;
      case 'click': applyClick(m); break;
      case 'input': applyInput(m); break;
      case 'key': applyKey(m); break;
      case 'hover': applyHover(m); break;
      default: break;
    }
  } catch (err) {
    // Never let replay errors surface as page errors.
  }
});

ipcRenderer.on('wt:highlight', (_e, m) => setRemoteHighlight(m.selector, m));
ipcRenderer.on('wt:unhighlight', () => {
  highlight.el = null;
  drawHighlight();
});
// Hide WebTester overlays while the host takes a screenshot.
ipcRenderer.on('wt:capture', (_e, m) => {
  if (layerHost) layerHost.style.display = m.on ? 'none' : '';
});
ipcRenderer.on('wt:recheck', () => {
  lastReport = '';
  runChecks();
});

send('hello');
