'use strict';

/* global icon, logo, WT_DEVICES, WTConsole */
(async () => {
  const wt = window.wt;
  const { DEVICES, CATEGORIES, PRESETS, UA, UA_LABELS, PLATFORM } = WT_DEVICES;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => `p${Math.random().toString(36).slice(2, 9)}`;
  const now = () => performance.now();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
  };

  const PANE_COLORS = ['#5b8cff', '#f5a524', '#38c98a', '#f0506e', '#a26bf5', '#22b8cf', '#ff7a45', '#9bd23c', '#e86bd6', '#8a9bb4'];
  const PAD = 18;
  const GAP = 20;
  const HEAD_H = 34;
  const MIN_PANE_W = 260;
  const THUMB_W = 230;
  const ZOOM_STEPS = [0.1, 0.15, 0.2, 0.25, 0.33, 0.4, 0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1];
  const NETWORK_LABELS = { online: 'No throttling', 'fast-4g': 'Fast 4G', 'slow-4g': 'Slow 4G', '3g': '3G (slow)', offline: 'Offline' };
  const VISION_LABELS = {
    none: 'None',
    blurredVision: 'Blurred vision',
    reducedContrast: 'Reduced contrast',
    achromatopsia: 'Achromatopsia (no color)',
    deuteranopia: 'Deuteranopia (no green)',
    protanopia: 'Protanopia (no red)',
    tritanopia: 'Tritanopia (no blue)',
  };
  const SCHEME_LABELS = { light: 'Light', dark: 'Dark', 'auto-dark': 'Forced dark (Chrome auto-dark)' };

  const info = await wt.appInfo();
  const saved = await wt.storeGet('session');

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let customDevices = (await wt.storeGet('devices')) || [];
  let workspaces = (await wt.storeGet('workspaces')) || [];
  const allDevices = () => [...DEVICES, ...customDevices.map((d) => ({ ...d, cat: 'custom' }))];
  const deviceById = (id) => allDevices().find((d) => d.id === id);

  function paneFromDevice(dev, overrides = {}) {
    const mobileCat = dev.cat === 'phone' || dev.cat === 'tablet' || (dev.cat === 'custom' && (dev.kind === 'phone' || dev.kind === 'tablet'));
    return {
      id: uid(),
      deviceId: dev.id,
      name: dev.name,
      width: dev.w,
      height: dev.h,
      dpr: dev.dpr ?? 0,
      mobile: dev.mobile ?? mobileCat,
      touch: dev.touch ?? mobileCat,
      ua: dev.ua || 'default',
      uaCustom: dev.uaCustom || '',
      colorScheme: 'light',
      reducedMotion: false,
      contrast: 'no-preference',
      forcedColors: false,
      print: false,
      vision: 'none',
      network: 'online',
      rotated: false,
      sync: true,
      color: null,
      ...overrides,
    };
  }

  const defaultPanes = () => [
    paneFromDevice(deviceById('iphone-15'), { colorScheme: 'light' }),
    paneFromDevice(deviceById('iphone-15'), { colorScheme: 'dark' }),
    paneFromDevice(deviceById('ipad-air-11'), { colorScheme: 'light' }),
    paneFromDevice(deviceById('laptop-1440'), { colorScheme: 'dark' }),
  ];

  const state = {
    url: info.demoUrl,
    layout: 'strip',
    zoom: 'fit',
    focusedId: null,
    activeId: null,
    sync: { enabled: true, scroll: true, click: true, input: true, nav: true, hover: false, scrollMode: 'percent' },
    overlays: { outlines: false, overflow: true, inspect: false },
    console: { open: true, height: 240, opts: null },
    watchDir: null,
  };

  /** @type {Pane[]} */
  let panes = [];
  let effectiveScale = 1;

  const ws = $('#workspace');
  const canvas = $('#canvas');
  const urlInput = $('#url');
  const consoleEl = $('#console');
  const resizer = $('#console-resizer');

  // -------------------------------------------------------------------------
  // Pane
  // -------------------------------------------------------------------------

  const syncOn = (p) => state.sync.enabled && p.cfg.sync;
  const paneByWc = (id) => panes.find((p) => p.wcId === id);
  const paneById = (id) => panes.find((p) => p.cfg.id === id);
  const activePane = () => paneById(state.activeId) || panes[0];

  function resolveConfig(c) {
    const uaKey = c.ua || 'default';
    return {
      width: c.rotated ? c.height : c.width,
      height: c.rotated ? c.width : c.height,
      dpr: Number(c.dpr) || 0,
      mobile: !!c.mobile,
      touch: !!c.touch,
      userAgent: uaKey === 'custom' ? c.uaCustom || '' : UA[uaKey] || '',
      platform: uaKey === 'custom' ? 'Win32' : PLATFORM[uaKey] || 'Win32',
      colorScheme: c.colorScheme,
      reducedMotion: !!c.reducedMotion,
      contrast: c.contrast || 'no-preference',
      forcedColors: !!c.forcedColors,
      print: !!c.print,
      vision: c.vision || 'none',
      network: c.network || 'online',
    };
  }

  class Pane {
    constructor(cfg) {
      this.cfg = cfg;
      this.wcId = null;
      this.ready = false;
      this.url = '';
      this.title = '';
      this.errors = 0;
      this.warnings = 0;
      this.checks = null;
      this.loading = false;
      this.suppressNavUntil = 0;
      this.pendingUrl = null;
      this.appliedUa = null;
      this.scale = 1;
      this.build();
    }

    get vw() { return this.cfg.rotated ? this.cfg.height : this.cfg.width; }
    get vh() { return this.cfg.rotated ? this.cfg.width : this.cfg.height; }
    get color() { return this.cfg.color || '#8a9bb4'; }

    label() {
      return `${this.cfg.name} · ${this.vw}×${this.vh} · ${this.cfg.colorScheme === 'light' ? 'light' : 'dark'}`;
    }

    short() {
      const n = this.cfg.name.length > 16 ? `${this.cfg.name.slice(0, 15)}…` : this.cfg.name;
      return `${n} ${this.cfg.colorScheme === 'light' ? '☀' : '☾'}`;
    }

    build() {
      const el = document.createElement('div');
      el.className = 'pane';
      el.dataset.id = this.cfg.id;
      el.innerHTML = `
        <div class="pane-head">
          <span class="pane-dot"></span>
          <span class="pane-title"><span class="pane-name"></span><span class="pane-size"></span></span>
          <span class="pane-badges">
            <button class="badge badge-err" data-act="console" title="Errors on this page — click to view" hidden></button>
            <button class="badge badge-warn" data-act="console" title="Warnings on this page — click to view" hidden></button>
            <button class="badge badge-of" data-act="overflow" title="Horizontal overflow — click to view culprits" hidden></button>
            <span class="pane-tags"></span>
            <span class="spinner" hidden></span>
          </span>
          <span class="pane-actions">
            <button class="pbtn" data-act="theme"></button>
            <button class="pbtn" data-act="rotate" title="Rotate">${icon('rotate', 15)}</button>
            <button class="pbtn" data-act="sync"></button>
            <button class="pbtn" data-act="shot" title="Screenshot · Shift+click for full page">${icon('camera', 15)}</button>
            <button class="pbtn" data-act="devtools" title="Open DevTools for this pane">${icon('code', 15)}</button>
            <button class="pbtn" data-act="menu" title="Pane options">${icon('more', 15)}</button>
          </span>
        </div>
        <div class="pane-view">
          <div class="pane-scaler"></div>
          <div class="pane-msg" hidden></div>
        </div>`;
      this.el = el;
      this.headEl = $('.pane-head', el);
      this.viewEl = $('.pane-view', el);
      this.scalerEl = $('.pane-scaler', el);
      this.msgEl = $('.pane-msg', el);

      const wv = document.createElement('webview');
      wv.setAttribute('partition', 'persist:webtester');
      wv.setAttribute('allowpopups', '');
      wv.setAttribute('src', 'about:blank');
      this.wv = wv;
      this.bindWebview();
      this.scalerEl.appendChild(wv);

      this.headEl.addEventListener('click', (e) => this.onHeadClick(e));
      this.viewEl.addEventListener('pointerdown', () => {
        if (this.el.classList.contains('thumb')) setFocused(this);
      }, true);
      this.updateHead();
    }

    bindWebview() {
      const wv = this.wv;
      wv.addEventListener('dom-ready', () => {
        if (!this.wcId) this.init();
      });
      wv.addEventListener('did-start-loading', () => this.setLoading(true));
      wv.addEventListener('did-stop-loading', () => this.setLoading(false));
      wv.addEventListener('did-start-navigation', (e) => {
        if (e.isMainFrame && !e.isInPlace) this.hideMsg();
      });
      wv.addEventListener('did-navigate', (e) => onPaneNavigated(this, e.url, false));
      wv.addEventListener('did-navigate-in-page', (e) => {
        if (e.isMainFrame) onPaneNavigated(this, e.url, true);
      });
      wv.addEventListener('did-fail-load', (e) => {
        if (!e.isMainFrame || e.errorCode === -3) return;
        this.showMsg(`<h4>Couldn't load this page</h4><code>${esc(e.errorDescription || `Error ${e.errorCode}`)}</code><div class="hint">${esc(e.validatedURL)}</div><button class="btn" data-msg="retry">Retry</button>`);
        WTConsole.add({ paneId: this.cfg.id, level: 'error', source: 'network', text: `Failed to load ${e.validatedURL}: ${e.errorDescription} (${e.errorCode})`, ts: Date.now() });
        this.errors++;
        this.updateBadges();
        updateConsoleButton();
      });
      wv.addEventListener('render-process-gone', (e) => {
        this.showMsg(`<h4>This pane crashed</h4><div class="hint">${esc(e.details?.reason || '')}</div><button class="btn" data-msg="retry">Reload</button>`);
      });
      wv.addEventListener('page-title-updated', (e) => {
        this.title = e.title;
        if (this === activePane()) document.title = `${e.title} — WebTester`;
      });
      wv.addEventListener('ipc-message', (e) => {
        if (e.channel === 'wt') onGuestMessage(this, e.args[0] || {});
      });
      wv.addEventListener('focus', () => {
        closeMenus();
        setActive(this);
      });
      this.msgEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-msg="retry"]')) {
          this.hideMsg();
          if (this.url && this.url !== 'about:blank') this.load(this.url);
          else this.load(state.url);
        }
      });
    }

    async init() {
      this.wcId = this.wv.getWebContentsId();
      await this.applyConfig(false);
      this.ready = true;
      const url = this.pendingUrl || state.url;
      this.pendingUrl = null;
      if (url) this.load(url);
    }

    load(url) {
      if (!this.ready) {
        this.pendingUrl = url;
        return;
      }
      this.suppressNavUntil = now() + 4000;
      this.hideMsg();
      this.wv.loadURL(url).catch(() => {});
    }

    async applyConfig(reloadOnUaChange = true) {
      if (!this.wcId) return;
      const r = resolveConfig(this.cfg);
      try {
        await wt.configurePane(this.wcId, r);
      } catch (err) {
        console.warn('configurePane failed', err);
      }
      const uaChanged = this.appliedUa !== null && this.appliedUa !== r.userAgent;
      this.appliedUa = r.userAgent;
      if (uaChanged && reloadOnUaChange && this.ready) {
        this.suppressNavUntil = now() + 4000;
        this.wv.reload();
      }
      sendGuestConfig(this);
      this.updateHead();
    }

    setLoading(v) {
      this.loading = v;
      $('.spinner', this.el).hidden = !v;
      if (this === activePane()) updateNavButtons();
    }

    showMsg(html) {
      this.msgEl.innerHTML = html;
      this.msgEl.hidden = false;
    }

    hideMsg() {
      this.msgEl.hidden = true;
    }

    updateHead() {
      const c = this.cfg;
      this.el.style.setProperty('--dot', this.color);
      this.el.classList.toggle('dark', c.colorScheme !== 'light');
      $('.pane-name', this.el).textContent = c.name;
      $('.pane-size', this.el).textContent = `${this.vw}×${this.vh}${c.dpr ? ` @${+c.dpr}x` : ''}${this.scale < 0.999 ? ` · ${Math.round(this.scale * 100)}%` : ''}`;
      $('.pane-title', this.el).title = this.label();
      const theme = $('[data-act="theme"]', this.el);
      theme.innerHTML = icon(c.colorScheme === 'light' ? 'sun' : c.colorScheme === 'dark' ? 'moon' : 'contrast', 15);
      theme.title = `${SCHEME_LABELS[c.colorScheme]} — click to toggle light/dark`;
      theme.classList.toggle('on', c.colorScheme !== 'light');
      const sync = $('[data-act="sync"]', this.el);
      sync.innerHTML = icon(c.sync ? 'link' : 'unlink', 15);
      sync.title = c.sync ? 'Synced with other panes — click to detach' : 'Detached — click to sync with other panes';
      sync.classList.toggle('off', !c.sync);
      $('[data-act="rotate"]', this.el).hidden = !c.mobile && !c.touch;

      const tags = [];
      if (c.network && c.network !== 'online') tags.push(NETWORK_LABELS[c.network]);
      if (c.vision && c.vision !== 'none') tags.push(VISION_LABELS[c.vision].split(' (')[0]);
      if (c.print) tags.push('Print');
      if (c.reducedMotion) tags.push('Reduced motion');
      if (c.forcedColors) tags.push('Forced colors');
      if (c.contrast && c.contrast !== 'no-preference') tags.push(`Contrast: ${c.contrast}`);
      if (c.colorScheme === 'auto-dark') tags.push('Auto-dark');
      $('.pane-tags', this.el).innerHTML = tags.map((t) => `<span class="badge badge-tag">${esc(t)}</span>`).join('');
      this.updateBadges();
    }

    updateBadges() {
      const err = $('.badge-err', this.el);
      const warn = $('.badge-warn', this.el);
      const of = $('.badge-of', this.el);
      err.hidden = !this.errors;
      err.innerHTML = `${icon('error', 11)}${this.errors}`;
      warn.hidden = !this.warnings;
      warn.innerHTML = `${icon('alert', 11)}${this.warnings}`;
      const ofPx = this.checks?.overflowPx || 0;
      of.hidden = !ofPx;
      of.innerHTML = `${icon('overflow', 11)}+${ofPx}px`;
    }

    onHeadClick(e) {
      const b = e.target.closest('[data-act]');
      if (!b) {
        setActive(this);
        if (state.layout === 'focus') setFocused(this);
        return;
      }
      switch (b.dataset.act) {
        case 'theme':
          this.cfg.colorScheme = this.cfg.colorScheme === 'light' ? 'dark' : 'light';
          this.applyConfig();
          paneListChanged();
          break;
        case 'rotate':
          this.cfg.rotated = !this.cfg.rotated;
          this.applyConfig();
          layout();
          saveSoon();
          break;
        case 'sync':
          this.cfg.sync = !this.cfg.sync;
          sendGuestConfig(this);
          this.updateHead();
          saveSoon();
          break;
        case 'shot':
          screenshotPane(this, e.shiftKey);
          break;
        case 'devtools':
          this.wv.openDevTools();
          break;
        case 'menu':
          paneMenu(this, b);
          break;
        case 'console':
          openConsole(this.cfg.id);
          break;
        case 'overflow':
          if (!state.overlays.overflow) toggleOverlay('overflow');
          openConsole(this.cfg.id);
          break;
        default:
          break;
      }
    }

    destroy() {
      this.el.remove();
    }
  }

  // -------------------------------------------------------------------------
  // Pane collection
  // -------------------------------------------------------------------------

  function nextColor() {
    const used = new Set(panes.map((p) => p.cfg.color));
    return PANE_COLORS.find((c) => !used.has(c)) || PANE_COLORS[panes.length % PANE_COLORS.length];
  }

  function addPane(cfg, { index = panes.length, url } = {}) {
    if (!cfg.color) cfg.color = nextColor();
    const p = new Pane(cfg);
    p.pendingUrl = url || currentUrl();
    panes.splice(index, 0, p);
    canvas.appendChild(p.el);
    paneListChanged();
    layout();
    return p;
  }

  function removePane(p) {
    panes = panes.filter((x) => x !== p);
    p.destroy();
    WTConsole.removePane(p.cfg.id);
    if (state.focusedId === p.cfg.id) state.focusedId = null;
    if (state.activeId === p.cfg.id) state.activeId = panes[0]?.cfg.id || null;
    paneListChanged();
    layout();
    updateConsoleButton();
  }

  /** Replace the pane list, reusing panes whose id matches (no reload). */
  const currentUrl = () => {
    const u = activePane()?.url;
    return u && u !== 'about:blank' ? u : state.url;
  };

  function setPanes(cfgs, { undoLabel } = {}) {
    const before = panes.map((p) => clone(p.cfg));
    const url = currentUrl();
    const keep = new Map(panes.map((p) => [p.cfg.id, p]));
    const next = [];
    for (const cfg of cfgs) {
      const existing = keep.get(cfg.id);
      if (existing) {
        keep.delete(cfg.id);
        const changed = JSON.stringify(existing.cfg) !== JSON.stringify(cfg);
        existing.cfg = cfg;
        if (changed) existing.applyConfig();
        next.push(existing);
      } else {
        next.push(null);
      }
    }
    for (const p of keep.values()) {
      p.destroy();
      WTConsole.removePane(p.cfg.id);
    }
    panes = next.filter(Boolean);
    cfgs.forEach((cfg, i) => {
      if (next[i]) return;
      if (!cfg.color) cfg.color = nextColor();
      const p = new Pane(cfg);
      p.pendingUrl = url;
      panes.splice(i, 0, p);
      canvas.appendChild(p.el);
    });
    if (!paneById(state.focusedId)) state.focusedId = null;
    if (!paneById(state.activeId)) state.activeId = panes[0]?.cfg.id || null;
    paneListChanged();
    layout();
    updateConsoleButton();
    if (undoLabel) {
      toast(undoLabel, { actions: [{ label: 'Undo', onClick: () => setPanes(before) }] });
    }
  }

  function paneListChanged() {
    for (const p of panes) p.updateHead();
    WTConsole.refreshPanes();
    $('#empty').hidden = panes.length > 0;
    saveSoon();
  }

  function setActive(p) {
    if (!p) return;
    if (state.activeId !== p.cfg.id) {
      state.activeId = p.cfg.id;
      for (const q of panes) q.el.classList.toggle('active', q === p && panes.length > 1);
      if (p.title) document.title = `${p.title} — WebTester`;
    }
    updateUrlBar();
    updateNavButtons();
  }

  function setFocused(p) {
    state.focusedId = p.cfg.id;
    setActive(p);
    layout();
    saveSoon();
  }

  function movePane(p, dir) {
    const i = panes.indexOf(p);
    const j = i + dir;
    if (j < 0 || j >= panes.length) return;
    [panes[i], panes[j]] = [panes[j], panes[i]];
    layout();
    paneListChanged();
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  // Panes narrower than this get a two-row header so the name stays visible.
  const NARROW_W = 430;
  const HEAD_H_NARROW = 60;
  const headH = (p, s, thumb = false) => (!thumb && Math.max(p.vw * s, MIN_PANE_W) < NARROW_W ? HEAD_H_NARROW : HEAD_H);

  function place(p, x, y, s, thumb) {
    p.scale = s;
    const w = p.vw * s;
    const h = p.vh * s;
    p.el.style.left = `${Math.round(x)}px`;
    p.el.style.top = `${Math.round(y)}px`;
    p.el.style.width = `${Math.round(thumb ? w : Math.max(w, MIN_PANE_W))}px`;
    p.el.classList.toggle('thumb', thumb);
    p.el.classList.toggle('narrow', headH(p, s, thumb) === HEAD_H_NARROW);
    p.viewEl.style.width = `${w}px`;
    p.viewEl.style.height = `${h}px`;
    p.scalerEl.style.width = `${p.vw}px`;
    p.scalerEl.style.height = `${p.vh}px`;
    p.scalerEl.style.transform = `scale(${s})`;
    p.updateHead();
  }

  function fitScale() {
    const fit = (head) => clamp(Math.min(...panes.map((p) => (ws.clientHeight - PAD * 2 - head - 12) / p.vh)), 0.08, 1);
    const s = fit(HEAD_H);
    return panes.some((p) => headH(p, s) === HEAD_H_NARROW) ? fit(HEAD_H_NARROW) : s;
  }

  function layout() {
    if (!panes.length) {
      canvas.style.width = '0px';
      canvas.style.height = '0px';
      updateZoomLabel();
      return;
    }
    const W = ws.clientWidth;
    const H = ws.clientHeight;
    let cw = 0;
    let ch = 0;
    if (state.layout === 'focus') {
      const f = paneById(state.focusedId) || activePane() || panes[0];
      const others = panes.filter((p) => p !== f);
      const side = others.length ? THUMB_W + GAP : 0;
      const availW = W - PAD * 2 - side - 12;
      const fitFor = (head) => clamp(Math.min(availW / f.vw, (H - PAD * 2 - head - 12) / f.vh), 0.08, 1);
      let s = state.zoom;
      if (s === 'fit') {
        s = fitFor(HEAD_H);
        if (headH(f, s) === HEAD_H_NARROW) s = fitFor(HEAD_H_NARROW);
      }
      effectiveScale = s;
      place(f, PAD, PAD, s, false);
      const fw = Math.max(f.vw * s, MIN_PANE_W);
      const x = PAD + fw + GAP;
      let y = PAD;
      for (const p of others) {
        const st = Math.min(THUMB_W / p.vw, 180 / p.vh, 1);
        place(p, x, y, st, true);
        y += p.vh * st + HEAD_H + 12;
      }
      cw = others.length ? x + THUMB_W + PAD : PAD + fw + PAD;
      ch = Math.max(PAD + f.vh * s + headH(f, s) + PAD, y + PAD);
    } else {
      const s = state.zoom === 'fit' ? fitScale() : state.zoom;
      effectiveScale = s;
      let x = PAD;
      let y = PAD;
      let rowH = 0;
      for (const p of panes) {
        const w = Math.max(p.vw * s, MIN_PANE_W);
        const h = p.vh * s + headH(p, s);
        if (state.layout === 'grid' && x > PAD && x + w > W - PAD) {
          x = PAD;
          y += rowH + GAP;
          rowH = 0;
        }
        place(p, x, y, s, false);
        x += w + GAP;
        rowH = Math.max(rowH, h);
        cw = Math.max(cw, x - GAP + PAD);
      }
      ch = y + rowH + PAD;
    }
    canvas.style.width = `${Math.ceil(cw)}px`;
    canvas.style.height = `${Math.ceil(ch)}px`;
    updateZoomLabel();
    $$('#layout-seg button').forEach((b) => b.classList.toggle('on', b.dataset.layout === state.layout));
  }

  let layoutRaf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(layoutRaf);
    layoutRaf = requestAnimationFrame(layout);
  }).observe(ws);

  function updateZoomLabel() {
    $('#btn-zoom .lbl').textContent = state.zoom === 'fit' ? `Fit · ${Math.round(effectiveScale * 100)}%` : `${Math.round(state.zoom * 100)}%`;
  }

  function setZoom(z) {
    state.zoom = z;
    layout();
    saveSoon();
  }

  function zoomStep(dir) {
    const cur = effectiveScale;
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > cur + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001);
    if (next) setZoom(next);
  }

  function setLayout(l) {
    state.layout = l;
    layout();
    saveSoon();
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  function normalizeUrl(input) {
    const s = input.trim();
    if (!s) return null;
    if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')) return `file:///${encodeURI(s.replace(/\\/g, '/'))}`;
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return s;
    if (/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|10\.\d+|192\.168\.|[\w-]+\.(local|test|localhost))(:\d+)?([/?#]|$)/i.test(s)) return `http://${s}`;
    if (/^[\w-]+(:\d+)([/?#]|$)/.test(s)) return `http://${s}`;
    if (/^[^\s/]+\.[^\s/]{2,}/.test(s)) return `https://${s}`;
    return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
  }

  function navigateAll(url) {
    state.url = url;
    urlInput.value = url;
    for (const p of panes) p.load(url);
    saveSoon();
  }

  function updateUrlBar() {
    const p = activePane();
    const url = p?.url && p.url !== 'about:blank' ? p.url : state.url;
    if (document.activeElement !== urlInput) urlInput.value = url || '';
    let ic = 'globe';
    if (/^https:/.test(url)) ic = 'lock';
    else if (/^file:/.test(url)) ic = 'file';
    $('#url-icon').innerHTML = icon(ic, 14);
  }

  function updateNavButtons() {
    const p = activePane();
    let back = false;
    let fwd = false;
    try {
      back = !!(p?.ready && p.wv.canGoToOffset(-1));
      fwd = !!(p?.ready && p.wv.canGoToOffset(1));
    } catch {
      /* webview not ready */
    }
    $('#btn-back').disabled = !back;
    $('#btn-forward').disabled = !fwd;
  }

  const navTargets = () => (state.sync.enabled && state.sync.nav ? panes : [activePane()].filter(Boolean));

  // goToOffset instead of goBack/goForward: Chromium's history intervention
  // makes goBack skip entries left via synthetic (replayed) clicks, which is
  // how follower panes navigate.
  function goOffset(offset) {
    for (const p of navTargets()) {
      if (p.ready && p.wv.canGoToOffset(offset)) {
        p.suppressNavUntil = now() + 4000;
        p.wv.goToOffset(offset);
      }
    }
  }
  const goBack = () => goOffset(-1);
  const goForward = () => goOffset(1);

  function reloadAll(hard = false) {
    for (const p of panes) {
      if (!p.ready) continue;
      p.suppressNavUntil = now() + 4000;
      p.hideMsg();
      if (hard) p.wv.reloadIgnoringCache();
      else p.wv.reload();
    }
  }

  let followTimer = null;
  function onPaneNavigated(p, url, inPage) {
    if (!url || url === 'about:blank') return;
    p.url = url;
    if (!p.historyCleared && !inPage) {
      // Drop the initial about:blank entry so Back never lands on a blank page.
      p.historyCleared = true;
      try {
        p.wv.clearHistory();
      } catch {
        /* ignore */
      }
    }
    if (!inPage) p.hideMsg();
    if (p === activePane()) {
      state.url = url;
      saveSoon();
      updateUrlBar();
      updateNavButtons();
    }
    if (!state.sync.nav || !syncOn(p) || now() < p.suppressNavUntil) return;
    // A user-driven navigation in this pane: bring the other panes along.
    state.url = url;
    saveSoon();
    clearTimeout(followTimer);
    followTimer = setTimeout(() => followNav(p, url, 0), 350);
  }

  function followNav(src, url, attempt) {
    const lagging = panes.filter((q) => q !== src && q.ready && syncOn(q) && q.url !== url);
    let retry = false;
    for (const q of lagging) {
      if (q.wv.isLoading() && attempt < 3) retry = true;
      else q.load(url);
    }
    if (retry) followTimer = setTimeout(() => followNav(src, url, attempt + 1), 700);
  }

  // -------------------------------------------------------------------------
  // Guest messages (sync relay, overlays, checks)
  // -------------------------------------------------------------------------

  function guestConfig(p) {
    const on = syncOn(p);
    return {
      sync: on ? { scroll: state.sync.scroll, click: state.sync.click, input: state.sync.input, hover: state.sync.hover } : {},
      scrollMode: state.sync.scrollMode,
      outlines: state.overlays.outlines,
      overflowMarkers: state.overlays.overflow,
      inspect: state.overlays.inspect,
      mobile: !!p.cfg.mobile,
    };
  }

  function sendGuest(p, channel, payload) {
    if (!p.wcId) return;
    try {
      p.wv.send(channel, payload);
    } catch {
      /* not ready */
    }
  }

  const sendGuestConfig = (p) => sendGuest(p, 'wt:config', guestConfig(p));
  const broadcastConfig = () => panes.forEach(sendGuestConfig);

  const SYNC_KIND = { scroll: 'scroll', click: 'click', input: 'input', key: 'input', hover: 'hover' };

  function onGuestMessage(p, msg) {
    switch (msg.type) {
      case 'hello':
        sendGuestConfig(p);
        break;
      case 'activity':
        setActive(p);
        break;
      case 'scroll':
      case 'click':
      case 'input':
      case 'key':
      case 'hover': {
        if (p.capturing) return;
        if (msg.type === 'click' || msg.type === 'key') setActive(p);
        if (!syncOn(p) || !state.sync[SYNC_KIND[msg.type]]) return;
        for (const q of panes) {
          if (q === p || !q.ready || !syncOn(q)) continue;
          if (msg.type === 'click' || msg.type === 'key') q.suppressNavUntil = now() + 1500;
          sendGuest(q, 'wt:apply', msg);
        }
        break;
      }
      case 'hover-point':
        wt.mouseMove(p.wcId, msg.x, msg.y);
        break;
      case 'highlight':
        for (const q of panes) if (q !== p) sendGuest(q, 'wt:highlight', { selector: msg.selector });
        break;
      case 'unhighlight':
        for (const q of panes) if (q !== p) sendGuest(q, 'wt:unhighlight', {});
        break;
      case 'checks':
        onChecks(p, msg);
        break;
      default:
        break;
    }
  }

  function onChecks(p, c) {
    const prev = p.checks;
    p.checks = c;
    p.updateBadges();
    if (c.overflowPx > 0 && (!prev || prev.overflowPx !== c.overflowPx)) {
      WTConsole.add({
        paneId: p.cfg.id,
        level: 'warning',
        source: 'WebTester',
        text: `Horizontal overflow: content is ${c.overflowPx}px wider than the ${c.viewport}px viewport (${c.culprits.length} element${c.culprits.length === 1 ? '' : 's'} sticking out)`,
        selectors: c.culprits,
        ts: Date.now(),
      });
      p.warnings++;
      p.updateBadges();
    }
    if (c.noViewportMeta && p.cfg.mobile && !(prev && prev.noViewportMeta)) {
      WTConsole.add({
        paneId: p.cfg.id,
        level: 'warning',
        source: 'WebTester',
        text: 'No <meta name="viewport"> tag: mobile browsers will render this page zoomed out at ~980px wide.',
        ts: Date.now(),
      });
      p.warnings++;
      p.updateBadges();
    }
    updateConsoleButton();
  }

  function highlightInPane(paneId, selector) {
    const p = paneById(paneId);
    if (!p) return;
    setActive(p);
    if (state.layout === 'focus') setFocused(p);
    p.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    if (selector) sendGuest(p, 'wt:highlight', { selector, scroll: true, duration: 3500 });
  }

  // -------------------------------------------------------------------------
  // Console wiring
  // -------------------------------------------------------------------------

  wt.on('guest:console', (items) => {
    const touched = new Set();
    for (const it of items) {
      const p = paneByWc(it.wcId);
      if (!p) continue;
      touched.add(p);
      if (it.clear) {
        p.errors = 0;
        p.warnings = 0;
        p.checks = null;
        WTConsole.clearPane(p.cfg.id);
        sendGuest(p, 'wt:recheck', {});
        continue;
      }
      if (it.level === 'error') p.errors++;
      else if (it.level === 'warning') p.warnings++;
      WTConsole.add({ ...it, paneId: p.cfg.id });
    }
    for (const p of touched) p.updateBadges();
    updateConsoleButton();
  });

  function updateConsoleButton() {
    const t = WTConsole.totals();
    const err = $('#btn-console .cnt.err');
    const warn = $('#btn-console .cnt.warn');
    err.hidden = !t.error;
    err.textContent = t.error;
    warn.hidden = !t.warning;
    warn.textContent = t.warning;
    $('#btn-console').classList.toggle('on', state.console.open);
  }

  function setConsoleOpen(open) {
    state.console.open = open;
    consoleEl.hidden = !open;
    resizer.hidden = !open;
    consoleEl.style.height = `${state.console.height}px`;
    if (open) WTConsole.render();
    updateConsoleButton();
    saveSoon();
  }

  function openConsole(paneId) {
    WTConsole.setPaneFilter(paneId || 'all');
    setConsoleOpen(true);
  }

  WTConsole.init(consoleEl, {
    getPanes: () => panes.map((p) => ({ id: p.cfg.id, label: p.label(), short: p.short(), color: p.color })),
    onSelector: (paneId, selector) => highlightInPane(paneId, selector),
    onChange: () => updateConsoleButton(),
    onOptions: (o) => {
      state.console.opts = o;
      saveSoon();
    },
  }, saved?.console?.opts);
  consoleEl.querySelector('[data-act="close"]').addEventListener('click', () => setConsoleOpen(false));

  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const shield = $('#drag-shield');
    shield.hidden = false;
    resizer.classList.add('drag');
    const startY = e.clientY;
    const startH = consoleEl.offsetHeight;
    const move = (ev) => {
      const h = clamp(startH + (startY - ev.clientY), 90, window.innerHeight - 200);
      state.console.height = h;
      consoleEl.style.height = `${h}px`;
    };
    const up = () => {
      shield.hidden = true;
      resizer.classList.remove('drag');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveSoon();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // -------------------------------------------------------------------------
  // Menus, toasts, modals
  // -------------------------------------------------------------------------

  let menuCleanup = null;

  function closeMenus() {
    if (menuCleanup) menuCleanup();
    menuCleanup = null;
    $('#menus').innerHTML = '';
  }

  /**
   * items: '-' | { header } | { label, icon, hint, checked, danger, disabled, keepOpen, onClick }
   * Items may also be a function returning the list (re-evaluated for keepOpen items).
   */
  function openMenu(anchor, itemsOrFn, { align = 'left' } = {}) {
    closeMenus();
    const getItems = typeof itemsOrFn === 'function' ? itemsOrFn : () => itemsOrFn;
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    const render = () => {
      menu.innerHTML = '';
      getItems().forEach((it) => {
        if (!it) return;
        if (it === '-') {
          menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
          return;
        }
        if (it.header) {
          menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-header', textContent: it.header }));
          return;
        }
        const b = document.createElement('button');
        b.className = `menu-item${it.danger ? ' danger' : ''}`;
        b.setAttribute('role', 'menuitem');
        b.disabled = !!it.disabled;
        const hasCheck = it.checked !== undefined;
        b.innerHTML = `${hasCheck ? `<span class="mi-check">${it.checked ? icon('check', 14) : ''}</span>` : ''}${it.icon ? `<span class="mi-icon">${icon(it.icon, 15)}</span>` : ''}<span class="mi-label">${esc(it.label)}</span>${it.hint ? `<span class="mi-hint">${esc(it.hint)}</span>` : ''}`;
        b.addEventListener('click', () => {
          if (it.keepOpen) {
            it.onClick();
            render();
          } else {
            closeMenus();
            it.onClick();
          }
        });
        menu.appendChild(b);
      });
    };
    render();
    $('#menus').appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = align === 'right' ? r.right - mw : r.left;
    left = clamp(left, 8, window.innerWidth - mw - 8);
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    const outside = (e) => {
      if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenus();
    };
    const key = (e) => {
      if (e.key === 'Escape') closeMenus();
    };
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
    document.addEventListener('keydown', key);
    window.addEventListener('blur', closeMenus);
    menuCleanup = () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('blur', closeMenus);
    };
    menu.querySelector('.menu-item:not(:disabled)')?.focus({ preventScroll: true });
  }

  function toast(message, { actions = [], type = '', timeout = 5000 } = {}) {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span class="t-msg">${esc(message)}</span>`;
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.addEventListener('click', () => {
        a.onClick();
        t.remove();
      });
      t.appendChild(b);
    }
    const x = document.createElement('button');
    x.innerHTML = icon('x', 13);
    x.title = 'Dismiss';
    x.addEventListener('click', () => t.remove());
    t.appendChild(x);
    $('#toasts').appendChild(t);
    if (timeout) setTimeout(() => t.remove(), timeout);
    return t;
  }

  function openModal({ title, body, footer = [], wide = false, onClose }) {
    closeMenus();
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close title="Close">${icon('x', 16)}</button></div>
      <div class="modal-body"></div>
      ${footer.length ? '<div class="modal-foot"></div>' : ''}
    </div>`;
    const bodyEl = $('.modal-body', back);
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else bodyEl.appendChild(body);
    const close = () => {
      back.remove();
      document.removeEventListener('keydown', key);
      if (onClose) onClose();
    };
    const key = (e) => {
      if (e.key === 'Escape') close();
    };
    for (const f of footer) {
      const b = document.createElement('button');
      b.className = `btn${f.primary ? ' primary' : ''}${f.danger ? ' danger' : ''}`;
      b.textContent = f.label;
      b.addEventListener('click', () => {
        if (f.onClick?.(close) !== false) close();
      });
      $('.modal-foot', back).appendChild(b);
    }
    back.addEventListener('pointerdown', (e) => {
      if (e.target === back) close();
    });
    $('[data-close]', back).addEventListener('click', close);
    document.addEventListener('keydown', key);
    $('#modals').appendChild(back);
    setTimeout(() => bodyEl.querySelector('input, select, textarea, button')?.focus());
    return { el: back, body: bodyEl, close };
  }

  // -------------------------------------------------------------------------
  // Device & preset menus
  // -------------------------------------------------------------------------

  function deviceMeta(d) {
    return `${d.w}×${d.h}`;
  }

  function addDeviceMenu(anchor) {
    const items = [];
    for (const cat of CATEGORIES) {
      const list = allDevices().filter((d) => d.cat === cat.id);
      if (!list.length) continue;
      items.push({ header: cat.label });
      for (const d of list) {
        items.push({ label: d.name, icon: cat.icon, hint: deviceMeta(d), onClick: () => addDeviceAndScroll(d) });
      }
    }
    items.push('-');
    items.push({ label: 'Custom size…', icon: 'ruler', onClick: () => openPaneSettings(null) });
    items.push({ label: 'Device library…', icon: 'sliders', hint: 'Ctrl+Shift+N', onClick: openDeviceLibrary });
    items.push('-', { header: 'Replace panes with a preset' });
    for (const pr of PRESETS) items.push({ label: pr.name, icon: 'grid', onClick: () => applyPreset(pr) });
    openMenu(anchor, items);
  }

  function addDeviceAndScroll(d, overrides = {}) {
    const p = addPane(paneFromDevice(d, overrides));
    setActive(p);
    requestAnimationFrame(() => p.el.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' }));
    return p;
  }

  function applyPreset(pr) {
    const cfgs = pr.panes
      .map(([id, scheme]) => {
        const d = deviceById(id);
        return d ? paneFromDevice(d, { colorScheme: scheme || 'light' }) : null;
      })
      .filter(Boolean);
    setPanes(cfgs, { undoLabel: `Switched to “${pr.name}”` });
  }

  function setAllSchemes(scheme) {
    for (const p of panes) {
      if (p.cfg.colorScheme !== scheme) {
        p.cfg.colorScheme = scheme;
        p.applyConfig();
      }
    }
    paneListChanged();
  }

  function pairThemes() {
    const groups = new Map();
    for (const p of panes) {
      const key = `${p.cfg.name}|${p.vw}x${p.vh}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const cfgs = [];
    for (const list of groups.values()) {
      const light = list.find((p) => p.cfg.colorScheme === 'light');
      const dark = list.find((p) => p.cfg.colorScheme !== 'light');
      const base = clone(list[0].cfg);
      cfgs.push(light ? clone(light.cfg) : { ...base, id: uid(), color: null, colorScheme: 'light' });
      cfgs.push(dark ? clone(dark.cfg) : { ...base, id: uid(), color: null, colorScheme: 'dark' });
    }
    setPanes(cfgs, { undoLabel: 'Every device now has a light and a dark pane' });
  }

  function paneMenu(p, anchor) {
    const c = p.cfg;
    const scheme = (s) => () => {
      c.colorScheme = s;
      p.applyConfig();
      paneListChanged();
    };
    const toggle = (key) => () => {
      c[key] = !c[key];
      p.applyConfig();
      saveSoon();
    };
    openMenu(anchor, () => [
      { label: 'Pane settings…', icon: 'sliders', onClick: () => openPaneSettings(p) },
      { label: 'Focus this pane', icon: 'maximize', onClick: () => { setLayout('focus'); setFocused(p); } },
      { label: 'Reload pane', icon: 'reload', onClick: () => { p.suppressNavUntil = now() + 4000; p.wv.reload(); } },
      '-',
      { header: 'Color scheme' },
      { label: 'Light', checked: c.colorScheme === 'light', onClick: scheme('light') },
      { label: 'Dark', checked: c.colorScheme === 'dark', onClick: scheme('dark') },
      { label: 'Forced dark (auto-dark)', checked: c.colorScheme === 'auto-dark', onClick: scheme('auto-dark') },
      '-',
      { header: 'Emulate' },
      { label: 'Reduced motion', checked: !!c.reducedMotion, keepOpen: true, onClick: toggle('reducedMotion') },
      { label: 'Print stylesheet', checked: !!c.print, keepOpen: true, onClick: toggle('print') },
      { label: 'Forced colors (high contrast)', checked: !!c.forcedColors, keepOpen: true, onClick: toggle('forcedColors') },
      { label: 'Touch input', checked: !!c.touch, keepOpen: true, onClick: toggle('touch') },
      '-',
      { label: 'Screenshot (viewport)', icon: 'camera', onClick: () => screenshotPane(p, false) },
      { label: 'Screenshot (full page)', icon: 'camera', onClick: () => screenshotPane(p, true) },
      { label: 'Open DevTools', icon: 'code', onClick: () => p.wv.openDevTools() },
      '-',
      { label: 'Duplicate', icon: 'copy', onClick: () => addPane({ ...clone(c), id: uid(), color: null }, { index: panes.indexOf(p) + 1 }) },
      {
        label: c.colorScheme === 'light' ? 'Duplicate as dark' : 'Duplicate as light',
        icon: c.colorScheme === 'light' ? 'moon' : 'sun',
        onClick: () => addPane({ ...clone(c), id: uid(), color: null, colorScheme: c.colorScheme === 'light' ? 'dark' : 'light' }, { index: panes.indexOf(p) + 1 }),
      },
      { label: 'Move left', icon: 'left', disabled: panes.indexOf(p) === 0, onClick: () => movePane(p, -1) },
      { label: 'Move right', icon: 'right', disabled: panes.indexOf(p) === panes.length - 1, onClick: () => movePane(p, 1) },
      '-',
      { label: 'Remove pane', icon: 'trash', danger: true, onClick: () => removePane(p) },
    ], { align: 'right' });
  }

  // -------------------------------------------------------------------------
  // Pane settings modal (also used for "custom size")
  // -------------------------------------------------------------------------

  const optionList = (obj, sel) => Object.entries(obj).map(([v, l]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');

  function openPaneSettings(p) {
    const base = p ? clone(p.cfg) : paneFromDevice({ id: 'custom', name: 'Custom', cat: 'desktop', w: 1200, h: 800, dpr: 0, ua: 'default' });
    const devOptions = CATEGORIES.map((cat) => {
      const list = allDevices().filter((d) => d.cat === cat.id);
      if (!list.length) return '';
      return `<optgroup label="${esc(cat.label)}">${list.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} — ${d.w}×${d.h}</option>`).join('')}</optgroup>`;
    }).join('');
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="section-title">Device</div>
      <div class="form-grid">
        <label class="field full"><span>Start from a device</span><select name="preset"><option value="">— keep current values —</option>${devOptions}</select></label>
        <label class="field full"><span>Pane name</span><input type="text" name="name" value="${esc(base.name)}"></label>
        <label class="field"><span>Width (CSS px)</span><input type="number" name="width" min="200" max="7680" value="${base.width}"></label>
        <label class="field"><span>Height (CSS px)</span><input type="number" name="height" min="200" max="4320" value="${base.height}"></label>
        <label class="field"><span>Device pixel ratio</span><select name="dpr">${optionList({ 0: 'Auto (this monitor)', 1: '1x', 1.5: '1.5x', 2: '2x', 2.625: '2.625x', 2.75: '2.75x', 3: '3x', 3.5: '3.5x', 4: '4x' }, String(+base.dpr))}</select></label>
        <label class="field"><span>User agent</span><select name="ua">${optionList(UA_LABELS, base.ua)}</select></label>
        <label class="field full" data-show="ua-custom"><span>Custom user agent string</span><textarea name="uaCustom">${esc(base.uaCustom)}</textarea></label>
        <div class="row full" style="gap:18px">
          <label class="check"><input type="checkbox" name="mobile"${base.mobile ? ' checked' : ''}> Mobile viewport (honors &lt;meta viewport&gt;, hides scrollbars)</label>
          <label class="check"><input type="checkbox" name="touch"${base.touch ? ' checked' : ''}> Touch input</label>
          <label class="check"><input type="checkbox" name="rotated"${base.rotated ? ' checked' : ''}> Landscape</label>
        </div>
      </div>
      <div class="section-title">Emulation</div>
      <div class="form-grid">
        <label class="field"><span>Color scheme</span><select name="colorScheme">${optionList(SCHEME_LABELS, base.colorScheme)}</select></label>
        <label class="field"><span>Network</span><select name="network">${optionList(NETWORK_LABELS, base.network)}</select></label>
        <label class="field"><span>Vision deficiency</span><select name="vision">${optionList(VISION_LABELS, base.vision)}</select></label>
        <label class="field"><span>prefers-contrast</span><select name="contrast">${optionList({ 'no-preference': 'No preference', more: 'More', less: 'Less' }, base.contrast)}</select></label>
        <div class="row full" style="gap:18px;flex-wrap:wrap">
          <label class="check"><input type="checkbox" name="reducedMotion"${base.reducedMotion ? ' checked' : ''}> prefers-reduced-motion</label>
          <label class="check"><input type="checkbox" name="forcedColors"${base.forcedColors ? ' checked' : ''}> Forced colors</label>
          <label class="check"><input type="checkbox" name="print"${base.print ? ' checked' : ''}> Print media</label>
          <label class="check"><input type="checkbox" name="sync"${base.sync ? ' checked' : ''}> Sync with other panes</label>
        </div>
      </div>`;
    const f = (n) => body.querySelector(`[name="${n}"]`);
    const showCustomUa = () => { body.querySelector('[data-show="ua-custom"]').hidden = f('ua').value !== 'custom'; };
    showCustomUa();
    f('ua').addEventListener('change', showCustomUa);
    f('preset').addEventListener('change', () => {
      const d = deviceById(f('preset').value);
      if (!d) return;
      const cfg = paneFromDevice(d);
      f('name').value = cfg.name;
      f('width').value = cfg.width;
      f('height').value = cfg.height;
      f('dpr').value = String(+cfg.dpr);
      f('ua').value = cfg.ua;
      f('mobile').checked = cfg.mobile;
      f('touch').checked = cfg.touch;
      showCustomUa();
    });

    openModal({
      title: p ? `Pane settings — ${p.cfg.name}` : 'Add a custom-size pane',
      body,
      footer: [
        { label: 'Cancel' },
        {
          label: p ? 'Apply' : 'Add pane',
          primary: true,
          onClick: () => {
            const next = {
              ...base,
              deviceId: f('preset').value || base.deviceId,
              name: f('name').value.trim() || 'Custom',
              width: clamp(parseInt(f('width').value, 10) || base.width, 200, 7680),
              height: clamp(parseInt(f('height').value, 10) || base.height, 200, 4320),
              dpr: parseFloat(f('dpr').value) || 0,
              ua: f('ua').value,
              uaCustom: f('uaCustom').value.trim(),
              mobile: f('mobile').checked,
              touch: f('touch').checked,
              rotated: f('rotated').checked,
              colorScheme: f('colorScheme').value,
              network: f('network').value,
              vision: f('vision').value,
              contrast: f('contrast').value,
              reducedMotion: f('reducedMotion').checked,
              forcedColors: f('forcedColors').checked,
              print: f('print').checked,
              sync: f('sync').checked,
            };
            if (p) {
              p.cfg = next;
              p.applyConfig();
              layout();
              paneListChanged();
            } else {
              const np = addPane(next);
              setActive(np);
            }
          },
        },
      ],
    });
  }

  // -------------------------------------------------------------------------
  // Device library modal
  // -------------------------------------------------------------------------

  function openDeviceLibrary() {
    const body = document.createElement('div');
    const render = () => {
      body.innerHTML = `${CATEGORIES.map((cat) => {
        const list = allDevices().filter((d) => d.cat === cat.id);
        if (!list.length) return '';
        return `<div class="section-title">${esc(cat.label)}</div><div class="dev-list">${list.map((d) => `
          <div class="dev-row">
            <span>${icon(cat.icon, 15)}</span>
            <span>${esc(d.name)}</span>
            <span class="muted">${d.w}×${d.h}</span>
            <span class="muted">${d.dpr ? `@${d.dpr}x` : 'auto'}</span>
            <span class="row">
              <button class="btn" data-add="${esc(d.id)}">Add</button>
              <button class="btn" data-add-dark="${esc(d.id)}" title="Add a light and a dark pane">${icon('contrast', 14)}</button>
              ${cat.id === 'custom' ? `<button class="icon-btn" data-del="${esc(d.id)}" title="Delete">${icon('trash', 14)}</button>` : ''}
            </span>
          </div>`).join('')}</div>`;
      }).join('')}
      <div class="section-title">Create a custom device</div>
      <div class="form-grid">
        <label class="field full"><span>Name</span><input type="text" name="cname" placeholder="e.g. Client kiosk"></label>
        <label class="field"><span>Width</span><input type="number" name="cw" value="1080" min="200" max="7680"></label>
        <label class="field"><span>Height</span><input type="number" name="ch" value="1920" min="200" max="4320"></label>
        <label class="field"><span>Type</span><select name="ckind">${optionList({ phone: 'Phone (mobile + touch)', tablet: 'Tablet (mobile + touch)', desktop: 'Desktop' }, 'desktop')}</select></label>
        <label class="field"><span>Pixel ratio</span><select name="cdpr">${optionList({ 0: 'Auto', 1: '1x', 2: '2x', 3: '3x' }, '0')}</select></label>
        <label class="field full"><span>User agent</span><select name="cua">${optionList(UA_LABELS, 'default')}</select></label>
        <div class="full"><button class="btn primary" data-create>Save device</button></div>
      </div>`;
    };
    render();
    body.addEventListener('click', async (e) => {
      const add = e.target.closest('[data-add]');
      const addPair = e.target.closest('[data-add-dark]');
      const del = e.target.closest('[data-del]');
      if (add) {
        addDeviceAndScroll(deviceById(add.dataset.add));
        toast(`Added ${deviceById(add.dataset.add).name}`, { timeout: 2000 });
      } else if (addPair) {
        const d = deviceById(addPair.dataset.addDark);
        addDeviceAndScroll(d, { colorScheme: 'light' });
        addDeviceAndScroll(d, { colorScheme: 'dark' });
        toast(`Added ${d.name} (light + dark)`, { timeout: 2000 });
      } else if (del) {
        customDevices = customDevices.filter((d) => d.id !== del.dataset.del);
        await wt.storeSet('devices', customDevices);
        render();
      } else if (e.target.closest('[data-create]')) {
        const g = (n) => body.querySelector(`[name="${n}"]`).value;
        const name = g('cname').trim();
        if (!name) {
          body.querySelector('[name="cname"]').focus();
          return;
        }
        const kind = g('ckind');
        customDevices.push({
          id: `custom-${Date.now().toString(36)}`,
          name,
          kind,
          w: clamp(parseInt(g('cw'), 10) || 1080, 200, 7680),
          h: clamp(parseInt(g('ch'), 10) || 1920, 200, 4320),
          dpr: parseFloat(g('cdpr')) || 0,
          ua: g('cua') === 'custom' ? 'default' : g('cua'),
          mobile: kind !== 'desktop',
          touch: kind !== 'desktop',
        });
        await wt.storeSet('devices', customDevices);
        render();
        toast(`Saved “${name}” to your devices`, { timeout: 2500 });
      }
    });
    openModal({ title: 'Device library', body, wide: true });
  }

  // -------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------

  function snapshot() {
    return {
      url: activePane()?.url && activePane().url !== 'about:blank' ? activePane().url : state.url,
      layout: state.layout,
      zoom: state.zoom,
      sync: { ...state.sync },
      overlays: { ...state.overlays },
      panes: panes.map((p) => clone(p.cfg)),
    };
  }

  function loadWorkspace(w) {
    state.layout = w.layout || 'strip';
    state.zoom = w.zoom || 'fit';
    state.sync = { ...state.sync, ...(w.sync || {}) };
    state.overlays = { ...state.overlays, ...(w.overlays || {}) };
    state.url = w.url || state.url;
    const cfgs = (w.panes || []).map((c) => ({ ...clone(c), id: uid() }));
    setPanes([]);
    setPanes(cfgs);
    navigateAll(state.url);
    refreshToolbar();
    broadcastConfig();
  }

  async function saveWorkspacePrompt() {
    const body = document.createElement('div');
    body.innerHTML = `<label class="field"><span>Workspace name</span><input type="text" name="wsname" placeholder="e.g. Checkout flow — mobile vs desktop"></label>
      <p class="hint">Saves the URL, panes, layout, zoom, sync and overlay settings.</p>`;
    const input = body.querySelector('input');
    const doSave = async () => {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return false;
      }
      const existing = workspaces.findIndex((w) => w.name === name);
      const entry = { name, savedAt: Date.now(), data: snapshot() };
      if (existing >= 0) workspaces[existing] = entry;
      else workspaces.push(entry);
      await wt.storeSet('workspaces', workspaces);
      toast(`Saved workspace “${name}”`, { timeout: 2500 });
      return true;
    };
    const m = openModal({
      title: 'Save workspace',
      body,
      footer: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: (close) => { doSave().then((ok) => ok && close()); return false; } }],
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSave().then((ok) => ok && m.close());
    });
  }

  function openWorkspaces() {
    const body = document.createElement('div');
    const render = () => {
      body.innerHTML = workspaces.length
        ? workspaces
          .slice()
          .sort((a, b) => b.savedAt - a.savedAt)
          .map((w) => `<div class="ws-row">
              <div class="grow"><div class="ws-name">${esc(w.name)}</div>
              <div class="ws-meta">${esc(w.data.url)} · ${w.data.panes.length} panes · ${new Date(w.savedAt).toLocaleString()}</div></div>
              <button class="btn primary" data-load="${esc(w.name)}">Open</button>
              <button class="icon-btn" data-del="${esc(w.name)}" title="Delete">${icon('trash', 15)}</button>
            </div>`)
          .join('')
        : '<p class="hint">No saved workspaces yet. Use “Save current…” to store this setup.</p>';
    };
    render();
    const m = openModal({
      title: 'Workspaces',
      body,
      wide: true,
      footer: [{ label: 'Save current…', onClick: () => { setTimeout(saveWorkspacePrompt); } }, { label: 'Close', primary: true }],
    });
    body.addEventListener('click', async (e) => {
      const load = e.target.closest('[data-load]');
      const del = e.target.closest('[data-del]');
      if (load) {
        const w = workspaces.find((x) => x.name === load.dataset.load);
        if (w) {
          loadWorkspace(w.data);
          m.close();
          toast(`Opened workspace “${w.name}”`, { timeout: 2500 });
        }
      } else if (del) {
        workspaces = workspaces.filter((x) => x.name !== del.dataset.del);
        await wt.storeSet('workspaces', workspaces);
        render();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Screenshots
  // -------------------------------------------------------------------------

  const loadImg = (src) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });

  const shotName = (p, full) => `${stamp()} ${p.cfg.name} ${p.vw}x${p.vh} ${p.cfg.colorScheme}${full ? ' full' : ''}`;
  const painted = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));

  /**
   * Capture a pane into a canvas. The pane is briefly shown at 100% zoom so
   * the guest rasterizes at full resolution; sync and overlays are paused so
   * a full-page scroll-through doesn't drag the other panes along.
   */
  async function capturePaneCanvas(p, fullPage) {
    if (!p.ready) throw new Error(`${p.cfg.name} is not ready`);
    p.capturing = true;
    sendGuest(p, 'wt:capture', { on: true });
    const prev = p.scalerEl.style.transform;
    p.scalerEl.style.transform = 'none';
    let r;
    try {
      await painted();
      r = await wt.capture(p.wcId, { fullPage });
    } finally {
      p.scalerEl.style.transform = prev;
      sendGuest(p, 'wt:capture', { on: false });
      setTimeout(() => { p.capturing = false; }, 300);
    }
    const imgs = await Promise.all(r.segments.map((seg) => loadImg(`data:image/png;base64,${seg.data}`)));
    const ratio = imgs[0].naturalWidth / r.width;
    const cssH = fullPage ? r.height : imgs[0].naturalHeight / ratio;
    const k = Math.min(ratio, 16000 / cssH);
    const cv = document.createElement('canvas');
    cv.width = Math.round(r.width * k);
    cv.height = Math.round(cssH * k);
    const ctx = cv.getContext('2d');
    r.segments.forEach((seg, i) => {
      const img = imgs[i];
      ctx.drawImage(img, 0, Math.round(seg.y * k), Math.round((img.naturalWidth / ratio) * k), Math.round((img.naturalHeight / ratio) * k));
    });
    return cv;
  }

  async function canvasBytes(cv) {
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function screenshotPane(p, fullPage, { silent = false } = {}) {
    if (!p.ready) return null;
    const t = !silent && fullPage ? toast(`Capturing full page of ${p.cfg.name}…`, { timeout: 0 }) : null;
    try {
      const cv = await capturePaneCanvas(p, fullPage);
      const file = await wt.saveImage(await canvasBytes(cv), shotName(p, fullPage));
      t?.remove();
      if (!silent) toast(`Saved ${fullPage ? 'full-page ' : ''}screenshot of ${p.cfg.name}`, { actions: [{ label: 'Show', onClick: () => wt.showInFolder(file) }] });
      return file;
    } catch (err) {
      t?.remove();
      toast(`Screenshot failed: ${err.message}`, { type: 'error' });
      return null;
    }
  }
  async function screenshotEach(fullPage) {
    const t = toast('Capturing panes…', { timeout: 0 });
    let last = null;
    for (const p of panes) last = (await screenshotPane(p, fullPage, { silent: true })) || last;
    t.remove();
    if (last) toast(`Saved ${panes.length} screenshots`, { actions: [{ label: 'Show', onClick: () => wt.showInFolder(last) }] });
  }

  async function screenshotSheet(fullPage) {
    const t = toast('Capturing all panes…', { timeout: 0 });
    try {
      const shots = [];
      for (const p of panes) {
        if (!p.ready) continue;
        try {
          shots.push({ p, img: await capturePaneCanvas(p, fullPage) });
        } catch {
          /* skip pane */
        }
      }
      if (!shots.length) throw new Error('No panes could be captured');
      const outer = 40;
      const gap = 40;
      const labelH = 56;
      const sizes = shots.map(({ p, img }) => {
        const w = p.vw;
        return { w, h: Math.min(img.height * (w / img.width), 14000) };
      });
      const W = outer * 2 + sizes.reduce((a, s) => a + s.w, 0) + gap * (shots.length - 1);
      const H = outer * 2 + labelH + Math.max(...sizes.map((s) => s.h));
      const k = clamp(Math.min(1.5, 16000 / H, 30000 / W, Math.sqrt(40e6 / (W * H))), 0.25, 1.5);
      const cv = document.createElement('canvas');
      cv.width = Math.round(W * k);
      cv.height = Math.round(H * k);
      const ctx = cv.getContext('2d');
      ctx.scale(k, k);
      ctx.fillStyle = '#16181e';
      ctx.fillRect(0, 0, W, H);
      let x = outer;
      shots.forEach(({ p, img }, i) => {
        const { w, h } = sizes[i];
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(x + 6, outer + 14, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#eef0f5';
        ctx.font = '600 20px system-ui, Segoe UI, sans-serif';
        ctx.fillText(p.cfg.name, x + 20, outer + 21, w - 20);
        ctx.fillStyle = '#8b93a5';
        ctx.font = '15px system-ui, Segoe UI, sans-serif';
        ctx.fillText(`${p.vw}×${p.vh} · ${SCHEME_LABELS[p.cfg.colorScheme]}${p.cfg.dpr ? ` · @${p.cfg.dpr}x` : ''}`, x, outer + 44, w);
        const sy = outer + labelH;
        ctx.fillStyle = '#2a2e38';
        ctx.fillRect(x - 1, sy - 1, w + 2, h + 2);
        const srcH = Math.min(img.height, h * (img.width / w));
        ctx.drawImage(img, 0, 0, img.width, srcH, x, sy, w, h);
        x += w + gap;
      });
      const data = await canvasBytes(cv);
      const host = (() => {
        try {
          return new URL(activePane()?.url || state.url).hostname || 'local';
        } catch {
          return 'page';
        }
      })();
      const file = await wt.saveImage(data, `${stamp()} ${host} sheet${fullPage ? ' full' : ''}`);
      t.remove();
      toast(`Saved combined screenshot (${shots.length} panes)`, { actions: [{ label: 'Show', onClick: () => wt.showInFolder(file) }] });
    } catch (err) {
      t.remove();
      toast(`Screenshot failed: ${err.message}`, { type: 'error' });
    }
  }

  function shotMenu(anchor) {
    openMenu(anchor, [
      { header: 'All panes' },
      { label: 'Combined sheet (viewport)', icon: 'grid', hint: 'Ctrl+Shift+S', onClick: () => screenshotSheet(false) },
      { label: 'Combined sheet (full page)', icon: 'grid', onClick: () => screenshotSheet(true) },
      { label: 'Separate files (viewport)', icon: 'copy', onClick: () => screenshotEach(false) },
      { label: 'Separate files (full page)', icon: 'copy', onClick: () => screenshotEach(true) },
      '-',
      { header: `Active pane — ${activePane()?.cfg.name || ''}` },
      { label: 'Viewport', icon: 'camera', disabled: !activePane(), onClick: () => screenshotPane(activePane(), false) },
      { label: 'Full page', icon: 'camera', disabled: !activePane(), onClick: () => screenshotPane(activePane(), true) },
      '-',
      { label: 'Open screenshots folder', icon: 'folder', onClick: () => wt.openShotsFolder() },
    ], { align: 'right' });
  }

  // -------------------------------------------------------------------------
  // Sync & overlay controls
  // -------------------------------------------------------------------------

  function toggleSync() {
    state.sync.enabled = !state.sync.enabled;
    broadcastConfig();
    refreshToolbar();
    for (const p of panes) p.updateHead();
    toast(state.sync.enabled ? 'Sync on — interactions are mirrored across panes' : 'Sync off — panes are independent', { timeout: 2000 });
    saveSoon();
  }

  function syncMenu(anchor) {
    const flip = (k) => () => {
      state.sync[k] = !state.sync[k];
      broadcastConfig();
      refreshToolbar();
      saveSoon();
    };
    const mode = (m) => () => {
      state.sync.scrollMode = m;
      broadcastConfig();
      saveSoon();
    };
    openMenu(anchor, () => [
      { label: 'Sync enabled', checked: state.sync.enabled, hint: 'Ctrl+Shift+X', keepOpen: true, onClick: () => { toggleSync(); } },
      '-',
      { header: 'Mirror between panes' },
      { label: 'Scrolling', checked: state.sync.scroll, keepOpen: true, onClick: flip('scroll') },
      { label: 'Clicks', checked: state.sync.click, keepOpen: true, onClick: flip('click') },
      { label: 'Typing & form fields', checked: state.sync.input, keepOpen: true, onClick: flip('input') },
      { label: 'Navigation', checked: state.sync.nav, keepOpen: true, onClick: flip('nav') },
      { label: 'Hover (mouse position)', checked: state.sync.hover, keepOpen: true, onClick: flip('hover') },
      '-',
      { header: 'Match scroll position by' },
      { label: 'Percentage of page', checked: state.sync.scrollMode === 'percent', keepOpen: true, onClick: mode('percent') },
      { label: 'Same element at top', checked: state.sync.scrollMode === 'anchor', keepOpen: true, onClick: mode('anchor') },
      { label: 'Exact pixel offset', checked: state.sync.scrollMode === 'pixels', keepOpen: true, onClick: mode('pixels') },
    ]);
  }

  function toggleOverlay(k) {
    state.overlays[k] = !state.overlays[k];
    broadcastConfig();
    refreshToolbar();
    saveSoon();
  }

  function overlaysMenu(anchor) {
    openMenu(anchor, () => [
      { label: 'Inspect elements across panes', icon: 'crosshair', checked: state.overlays.inspect, hint: 'Ctrl+Shift+C', keepOpen: true, onClick: () => toggleOverlay('inspect') },
      { label: 'Debug outlines on every element', icon: 'outline', checked: state.overlays.outlines, hint: 'Ctrl+Shift+B', keepOpen: true, onClick: () => toggleOverlay('outlines') },
      { label: 'Mark horizontal overflow', icon: 'overflow', checked: state.overlays.overflow, hint: 'Ctrl+Shift+F', keepOpen: true, onClick: () => toggleOverlay('overflow') },
      '-',
      { header: 'All panes' },
      { label: 'Reduced motion on all', icon: 'pause', onClick: () => setAllFlag('reducedMotion', true) },
      { label: 'Reduced motion off', icon: 'pause', onClick: () => setAllFlag('reducedMotion', false) },
      { label: 'Throttle all to Slow 4G', icon: 'wifi', onClick: () => setAllValue('network', 'slow-4g') },
      { label: 'Remove network throttling', icon: 'wifi', onClick: () => setAllValue('network', 'online') },
    ], { align: 'right' });
  }

  function setAllFlag(key, v) {
    setAllValue(key, v);
  }

  function setAllValue(key, v) {
    for (const p of panes) {
      p.cfg[key] = v;
      p.applyConfig();
    }
    saveSoon();
  }

  function zoomMenu(anchor) {
    openMenu(anchor, [
      { label: 'Fit to window', checked: state.zoom === 'fit', hint: 'Ctrl+0', onClick: () => setZoom('fit') },
      '-',
      ...[0.25, 0.33, 0.5, 0.67, 0.75, 1].map((z) => ({ label: `${Math.round(z * 100)}%`, checked: state.zoom === z, onClick: () => setZoom(z) })),
    ]);
  }

  // -------------------------------------------------------------------------
  // Folder watching & misc
  // -------------------------------------------------------------------------

  async function startWatching(dir, { quiet = false } = {}) {
    const ok = await wt.watchStart(dir);
    if (!ok) {
      state.watchDir = null;
      if (!quiet) toast(`Couldn't watch ${dir}`, { type: 'error' });
    } else {
      state.watchDir = dir;
      if (!quiet) toast(`Watching ${dir} — panes reload when files change`, { timeout: 3000 });
    }
    refreshWatchPill();
    saveSoon();
  }

  async function stopWatching() {
    await wt.watchStop();
    state.watchDir = null;
    refreshWatchPill();
    saveSoon();
  }

  function refreshWatchPill() {
    const pill = $('#watch-pill');
    pill.hidden = !state.watchDir;
    if (state.watchDir) {
      const name = state.watchDir.split(/[\\/]/).filter(Boolean).pop();
      pill.title = `Live reload: watching ${state.watchDir}`;
      pill.innerHTML = `${icon('eye', 12)}<span>${esc(name)}</span><button type="button" title="Stop watching">${icon('x', 12)}</button>`;
      pill.querySelector('button').addEventListener('click', stopWatching);
    }
  }

  wt.on('watch:changed', ({ file }) => {
    reloadAll(false);
    toast(`Reloaded: ${file} changed`, { timeout: 1500 });
  });
  wt.on('watch:error', (msg) => {
    state.watchDir = null;
    refreshWatchPill();
    toast(`Folder watch stopped: ${msg}`, { type: 'error' });
  });

  async function pickWatchFolder() {
    const dir = await wt.pickFolder();
    if (dir) startWatching(dir);
  }

  async function openLocalFile() {
    const url = await wt.openFileDialog();
    if (url) navigateAll(url);
  }

  async function clearSiteData() {
    await wt.clearSiteData();
    reloadAll(true);
    toast('Cleared cookies, storage and cache for all panes', { timeout: 2500 });
  }

  function showShortcuts() {
    const rows = [
      ['Focus address bar', 'Ctrl+L'],
      ['Reload all panes / hard reload', 'Ctrl+R · Ctrl+Shift+R'],
      ['Back / forward', 'Alt+← · Alt+→'],
      ['Add device / device library', 'Ctrl+N · Ctrl+Shift+N'],
      ['All light / all dark / light+dark pairs', 'Ctrl+Shift+L · D · P'],
      ['Toggle sync', 'Ctrl+Shift+X'],
      ['Inspect across panes', 'Ctrl+Shift+C'],
      ['Debug outlines / overflow markers', 'Ctrl+Shift+B · F'],
      ['Layouts: strip / grid / focus', 'Ctrl+1 · 2 · 3'],
      ['Zoom in / out / fit', 'Ctrl+= · Ctrl+- · Ctrl+0'],
      ['Toggle console', 'Ctrl+Shift+J'],
      ['Screenshot all panes', 'Ctrl+Shift+S'],
      ['Save workspace / open workspaces', 'Ctrl+S · Ctrl+Shift+O'],
      ['Open local file', 'Ctrl+O'],
      ['Full-page screenshot of a pane', 'Shift+click the camera'],
    ];
    openModal({
      title: 'Keyboard shortcuts',
      body: `<table class="kbd-table">${rows.map(([a, k]) => `<tr><td>${esc(a)}</td><td style="text-align:right">${k.split(' · ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</td></tr>`).join('')}</table>`,
    });
  }

  function moreMenu(anchor) {
    openMenu(anchor, [
      { label: 'Open local file…', icon: 'file', hint: 'Ctrl+O', onClick: openLocalFile },
      { label: state.watchDir ? 'Stop watching folder' : 'Watch folder for live reload…', icon: 'eye', onClick: () => (state.watchDir ? stopWatching() : pickWatchFolder()) },
      { label: 'Load demo page', icon: 'star', onClick: () => navigateAll(info.demoUrl) },
      '-',
      { label: 'Workspaces…', icon: 'folder', hint: 'Ctrl+Shift+O', onClick: openWorkspaces },
      { label: 'Save workspace…', icon: 'save', hint: 'Ctrl+S', onClick: saveWorkspacePrompt },
      { label: 'Device library…', icon: 'sliders', hint: 'Ctrl+Shift+N', onClick: openDeviceLibrary },
      '-',
      { label: 'Clear cookies & storage', icon: 'broom', onClick: clearSiteData },
      { label: 'Open screenshots folder', icon: 'camera', onClick: () => wt.openShotsFolder() },
      '-',
      { label: 'Keyboard shortcuts', icon: 'keyboard', hint: 'F1', onClick: showShortcuts },
      { label: `About WebTester ${info.version}`, icon: 'info', onClick: about },
    ], { align: 'right' });
  }

  function about() {
    openModal({
      title: 'About WebTester',
      body: `<div class="about-head">${logo(56)}<div class="word">Web<span>Tester</span></div></div>
        <p><b>Version ${esc(info.version)}</b>: test websites across devices, color schemes and conditions side by side.</p>
        <p class="hint">Electron ${esc(info.electron)} · Chromium ${esc(info.chrome)}</p>
        <p class="hint">Screenshots are saved to ${esc(info.shotsDir)}</p>`,
    });
  }

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------

  function refreshToolbar() {
    $('#btn-back').innerHTML = icon('back', 16);
    $('#btn-forward').innerHTML = icon('forward', 16);
    $('#btn-reload').innerHTML = icon('reload', 15);
    $('#btn-add .ico').innerHTML = icon('plus', 15);
    $('#btn-add .caret').innerHTML = icon('chevron', 13);
    $('[data-theme="light"]').innerHTML = icon('sun', 15);
    $('[data-theme="dark"]').innerHTML = icon('moon', 15);
    $('[data-theme="pair"]').innerHTML = icon('contrast', 15);
    const allLight = panes.length && panes.every((p) => p.cfg.colorScheme === 'light');
    const allDark = panes.length && panes.every((p) => p.cfg.colorScheme !== 'light');
    $('[data-theme="light"]').classList.toggle('on', !!allLight);
    $('[data-theme="dark"]').classList.toggle('on', !!allDark);
    $('[data-theme="pair"]').classList.toggle('on', !allLight && !allDark && panes.length > 0);
    $('#btn-sync .ico').innerHTML = icon(state.sync.enabled ? 'link' : 'unlink', 15);
    $('#btn-sync').classList.toggle('on', state.sync.enabled);
    $('#btn-sync-menu').innerHTML = icon('chevron', 13);
    $('#btn-overlays .ico').innerHTML = icon('layers', 15);
    $('#btn-overlays .caret').innerHTML = icon('chevron', 13);
    const anyOverlay = state.overlays.inspect || state.overlays.outlines;
    $('#btn-overlays').classList.toggle('on', anyOverlay);
    $('[data-layout="strip"]').innerHTML = icon('strip', 15);
    $('[data-layout="grid"]').innerHTML = icon('grid', 15);
    $('[data-layout="focus"]').innerHTML = icon('focus', 15);
    $$('#layout-seg button').forEach((b) => b.classList.toggle('on', b.dataset.layout === state.layout));
    $('#btn-zoom .caret').innerHTML = icon('chevron', 13);
    $('#btn-shot .ico').innerHTML = icon('camera', 15);
    $('#btn-shot .caret').innerHTML = icon('chevron', 13);
    $('#btn-console .ico').innerHTML = icon('terminal', 15);
    $('#btn-more').innerHTML = icon('more', 16);
    updateZoomLabel();
    updateConsoleButton();
  }

  $('#brand').innerHTML = logo(24);
  $('#brand').addEventListener('click', about);
  $('#btn-back').addEventListener('click', goBack);
  $('#btn-forward').addEventListener('click', goForward);
  $('#btn-reload').addEventListener('click', (e) => reloadAll(e.shiftKey));
  $('#url-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = normalizeUrl(urlInput.value);
    if (url) {
      navigateAll(url);
      urlInput.blur();
    }
  });
  urlInput.addEventListener('focus', () => urlInput.select());
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      updateUrlBar();
      urlInput.blur();
    }
  });
  $('#btn-add').addEventListener('click', (e) => addDeviceMenu(e.currentTarget));
  $('#btn-empty-add').addEventListener('click', (e) => addDeviceMenu(e.currentTarget));
  $('#theme-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    if (b.dataset.theme === 'pair') pairThemes();
    else setAllSchemes(b.dataset.theme);
  });
  $('#btn-sync').addEventListener('click', toggleSync);
  $('#btn-sync-menu').addEventListener('click', (e) => syncMenu(e.currentTarget));
  $('#btn-overlays').addEventListener('click', (e) => overlaysMenu(e.currentTarget));
  $('#layout-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-layout]');
    if (b) setLayout(b.dataset.layout);
  });
  $('#btn-zoom').addEventListener('click', (e) => zoomMenu(e.currentTarget));
  $('#btn-shot').addEventListener('click', (e) => shotMenu(e.currentTarget));
  $('#btn-console').addEventListener('click', () => setConsoleOpen(!state.console.open));
  $('#btn-more').addEventListener('click', (e) => moreMenu(e.currentTarget));

  // Ctrl+wheel over the workspace zooms.
  ws.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomStep(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // Application menu / keyboard shortcuts.
  const COMMANDS = {
    'focus-url': () => { urlInput.focus(); urlInput.select(); },
    'open-file': openLocalFile,
    'watch-folder': pickWatchFolder,
    'save-workspace': saveWorkspacePrompt,
    workspaces: openWorkspaces,
    reload: () => reloadAll(false),
    'hard-reload': () => reloadAll(true),
    back: goBack,
    forward: goForward,
    'layout-strip': () => setLayout('strip'),
    'layout-grid': () => setLayout('grid'),
    'layout-focus': () => setLayout('focus'),
    'zoom-in': () => zoomStep(1),
    'zoom-out': () => zoomStep(-1),
    'zoom-fit': () => setZoom('fit'),
    'toggle-console': () => setConsoleOpen(!state.console.open),
    'add-device': () => addDeviceMenu($('#btn-add')),
    'device-library': openDeviceLibrary,
    'all-light': () => setAllSchemes('light'),
    'all-dark': () => setAllSchemes('dark'),
    'pair-themes': pairThemes,
    'toggle-sync': toggleSync,
    'toggle-inspect': () => toggleOverlay('inspect'),
    'toggle-outlines': () => toggleOverlay('outlines'),
    'toggle-overflow': () => toggleOverlay('overflow'),
    'shot-sheet': () => screenshotSheet(false),
    shortcuts: showShortcuts,
    about,
  };
  wt.on('menu', (name) => COMMANDS[name]?.());

  // New windows / target=_blank links open in the panes instead.
  let lastOpen = { url: '', t: 0 };
  wt.on('guest:open-url', ({ wcId, url }) => {
    if (url === lastOpen.url && now() - lastOpen.t < 1500) return;
    lastOpen = { url, t: now() };
    const p = paneByWc(wcId);
    if (state.sync.enabled && state.sync.nav) navigateAll(url);
    else if (p) p.load(url);
  });

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  let saveTimer = null;
  function saveSoon() {
    refreshToolbar();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      wt.storeSet('session', {
        ...snapshot(),
        focusedId: state.focusedId,
        console: { open: state.console.open, height: state.console.height, opts: WTConsole.getOptions() },
        watchDir: state.watchDir,
      });
    }, 500);
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  if (saved) {
    state.url = saved.url || state.url;
    state.layout = saved.layout || state.layout;
    state.zoom = saved.zoom || state.zoom;
    state.sync = { ...state.sync, ...(saved.sync || {}) };
    state.overlays = { ...state.overlays, ...(saved.overlays || {}) };
    state.focusedId = saved.focusedId || null;
    if (saved.console) {
      state.console.open = !!saved.console.open;
      state.console.height = saved.console.height || state.console.height;
    }
  }
  const initialCfgs = saved?.panes?.length ? saved.panes : defaultPanes();
  for (const cfg of initialCfgs) addPane({ ...paneFromDevice({ id: 'x', name: 'Pane', cat: 'desktop', w: 1280, h: 800 }), ...cfg }, { url: state.url });
  state.activeId = panes[0]?.cfg.id || null;
  urlInput.value = state.url;
  refreshToolbar();
  setConsoleOpen(state.console.open);
  layout();
  updateUrlBar();
  if (saved?.watchDir) startWatching(saved.watchDir, { quiet: true });

  // Debug hook used by automated self-tests.
  window.__wt = {
    state,
    panes: () => panes.map((p) => ({ id: p.cfg.id, name: p.cfg.name, wcId: p.wcId, url: p.url, scale: p.scale, errors: p.errors, warnings: p.warnings, checks: p.checks, scheme: p.cfg.colorScheme })),
    consoleTotals: () => WTConsole.totals(),
    run: (name) => COMMANDS[name]?.(),
    navigateAll,
    applyPreset: (id) => applyPreset(PRESETS.find((p) => p.id === id)),
    patchPane: (i, patch) => {
      Object.assign(panes[i].cfg, patch);
      return panes[i].applyConfig();
    },
    capture: (i, fullPage) => capturePaneCanvas(panes[i], fullPage).then((cv) => `${cv.width}x${cv.height}`),
    highlightAll: (selector) => panes.forEach((p) => sendGuest(p, 'wt:highlight', { selector })),
    openSettings: (i) => openPaneSettings(panes[i]),
    openDevices: () => addDeviceMenu($('#btn-add')),
    closeOverlays: () => {
      closeMenus();
      $$('.modal-backdrop').forEach((m) => m.remove());
    },
    paneRects: () => panes.map((p) => ({ name: p.cfg.name, left: p.el.offsetLeft, top: p.el.offsetTop, w: p.el.offsetWidth, thumb: p.el.classList.contains('thumb') })),
    screenshotSheet,
  };
})();
