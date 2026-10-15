'use strict';

const { app, BrowserWindow, ipcMain, Menu, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Electron's dev-mode security banners would otherwise flood every pane's console.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const PARTITION = 'persist:webtester';
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = CHROME_UA;
if (process.env.WT_USER_DATA) {
  app.setPath('userData', process.env.WT_USER_DATA);
  app.setPath('pictures', path.join(process.env.WT_USER_DATA, 'pictures'));
}

// Throughput values are bytes/second, matching Chrome DevTools presets.
const NETWORK_PRESETS = {
  online: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  'fast-4g': { offline: false, latency: 165, downloadThroughput: 1012500, uploadThroughput: 168750 },
  'slow-4g': { offline: false, latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 },
  '3g': { offline: false, latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
};

const STORE_KEYS = new Set(['session', 'workspaces', 'devices']);

let win = null;
let watcher = null;
/** webContents id -> { wc, config, networkEnabled } for every pane */
const guests = new Map();

function hostSend(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'WebTester',
    backgroundColor: '#0f1115',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-host.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const host = win.webContents;
  host.on('will-attach-webview', (_event, prefs, params) => {
    prefs.preload = path.join(__dirname, 'preload-guest.js');
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    // Keep panes live (sync, live reload) while the app is in the background.
    prefs.backgroundThrottling = false;
    params.partition = PARTITION;
  });
  host.on('did-attach-webview', (_event, wc) => setupGuest(wc));
  host.on('will-navigate', (e) => e.preventDefault());
  host.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------------------
// Guests (panes) and the DevTools protocol
// ---------------------------------------------------------------------------

function cdp(id, method, params = {}) {
  const g = guests.get(id);
  if (!g || g.wc.isDestroyed() || !g.wc.debugger.isAttached()) {
    return Promise.reject(new Error('Pane is not available'));
  }
  return g.wc.debugger.sendCommand(method, params);
}

function enableDomains(id) {
  for (const m of ['Runtime.enable', 'Log.enable', 'Page.enable']) cdp(id, m).catch(() => {});
}

function setupGuest(wc) {
  const id = wc.id;
  const g = { wc, config: null, networkEnabled: false };
  guests.set(id, g);

  // New windows (target=_blank, window.open) are redirected into the panes.
  wc.setWindowOpenHandler(({ url }) => {
    hostSend('guest:open-url', { wcId: id, url });
    return { action: 'deny' };
  });

  try {
    wc.debugger.attach('1.3');
  } catch (err) {
    console.warn('[webtester] debugger attach failed:', err.message);
  }
  wc.debugger.on('message', (_e, method, params) => onCdpEvent(id, method, params));
  // Opening DevTools may kick our client off; re-attach and restore emulation.
  wc.debugger.on('detach', (_e, reason) => {
    if (process.env.WT_SELFTEST) console.warn(`[webtester] debugger detached from pane ${id}: ${reason}`);
    setTimeout(() => reattach(id), 300);
  });
  wc.on('devtools-closed', () => reattach(id));
  enableDomains(id);
  wc.once('destroyed', () => guests.delete(id));
}

function reattach(id) {
  const g = guests.get(id);
  if (!g || g.wc.isDestroyed() || g.wc.debugger.isAttached()) return;
  try {
    g.wc.debugger.attach('1.3');
  } catch {
    return;
  }
  g.networkEnabled = false;
  enableDomains(id);
  if (g.config) applyEmulation(id, g.config).catch(() => {});
}

async function applyEmulation(id, c) {
  const g = guests.get(id);
  if (!g) throw new Error('Unknown pane');
  g.config = c;
  const run = (m, p) => cdp(id, m, p).catch((err) => console.warn(`[webtester] ${m}: ${err.message}`));

  const w = Math.round(c.width);
  const h = Math.round(c.height);
  if (c.mobile || c.dpr) {
    await run('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: c.dpr || 0,
      mobile: !!c.mobile,
      screenWidth: w,
      screenHeight: h,
      screenOrientation: w > h ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
    });
  } else {
    await run('Emulation.clearDeviceMetricsOverride');
  }
  await run('Emulation.setScrollbarsHidden', { hidden: !!c.mobile });
  await run('Emulation.setTouchEmulationEnabled', { enabled: !!c.touch, maxTouchPoints: c.touch ? 5 : 1 });
  await run('Emulation.setEmitTouchEventsForMouse', { enabled: !!c.touch, configuration: c.mobile ? 'mobile' : 'desktop' });

  await run('Emulation.setEmulatedMedia', {
    media: c.print ? 'print' : '',
    features: [
      { name: 'prefers-color-scheme', value: c.colorScheme === 'light' ? 'light' : 'dark' },
      { name: 'prefers-reduced-motion', value: c.reducedMotion ? 'reduce' : 'no-preference' },
      { name: 'prefers-contrast', value: c.contrast || 'no-preference' },
      { name: 'forced-colors', value: c.forcedColors ? 'active' : 'none' },
    ],
  });
  await run('Emulation.setAutoDarkModeOverride', c.colorScheme === 'auto-dark' ? { enabled: true } : {});
  await run('Emulation.setEmulatedVisionDeficiency', { type: c.vision || 'none' });
  await run('Emulation.setUserAgentOverride', { userAgent: c.userAgent || CHROME_UA, platform: c.platform || 'Win32' });

  const net = NETWORK_PRESETS[c.network] || NETWORK_PRESETS.online;
  if (c.network && c.network !== 'online') {
    if (!g.networkEnabled) {
      await run('Network.enable');
      g.networkEnabled = true;
    }
    await run('Network.emulateNetworkConditions', net);
  } else if (g.networkEnabled) {
    await run('Network.emulateNetworkConditions', net);
    await run('Network.disable');
    g.networkEnabled = false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAINTED = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))';
const MAX_FULL_PAGE_CSS = 20000;

// Page.captureScreenshot misrenders <webview> guests whenever the emulated
// surface differs from the real one (emulated DPR, beyond-viewport capture):
// it tiles the visible surface. capturePage() is always faithful, so viewport
// shots use it directly and full-page shots scroll through and stitch.
async function capture(id, { fullPage = false } = {}) {
  const g = guests.get(id);
  if (!g || g.wc.isDestroyed()) throw new Error('Pane is not ready');
  const wc = g.wc;
  const shot = async () => (await wc.capturePage()).toPNG().toString('base64');
  const info = await wc.executeJavaScript(`(() => {
    const se = document.scrollingElement || document.documentElement;
    return { w: visualViewport.width, h: visualViewport.height, x: scrollX, y: scrollY,
      total: Math.max(se.scrollHeight, document.body ? document.body.scrollHeight : 0) };
  })()`);
  if (!fullPage) return { width: info.w, height: info.h, segments: [{ y: 0, data: await shot() }] };

  const total = Math.min(info.total, MAX_FULL_PAGE_CSS);
  const segments = [];
  let y = 0;
  try {
    for (let i = 0; i < 80; i++) {
      if (i === 1) {
        // Fixed/sticky elements (headers, chat bubbles) would repeat in every segment.
        await wc.executeJavaScript(`(() => {
          for (const el of document.querySelectorAll('body *')) {
            const p = getComputedStyle(el).position;
            if (p === 'fixed' || p === 'sticky') el.setAttribute('data-webtester-hide', '');
          }
          const st = document.createElement('style');
          st.id = '__webtester_capture';
          st.textContent = '[data-webtester-hide]{visibility:hidden!important}';
          document.documentElement.appendChild(st);
        })()`);
      }
      const top = await wc.executeJavaScript(`(() => { window.scrollTo({ top: ${y}, left: ${info.x}, behavior: 'instant' }); return ${PAINTED}.then(() => visualViewport.pageTop); })()`);
      await sleep(80);
      segments.push({ y: top, data: await shot() });
      if (top + info.h >= total - 1 || (i > 0 && top <= segments[i - 1].y)) break;
      y = top + info.h;
    }
  } finally {
    await wc.executeJavaScript(`(() => {
      document.getElementById('__webtester_capture')?.remove();
      document.querySelectorAll('[data-webtester-hide]').forEach((el) => el.removeAttribute('data-webtester-hide'));
      window.scrollTo({ top: ${info.y}, left: ${info.x}, behavior: 'instant' });
    })()`).catch(() => {});
  }
  return { width: info.w, height: total, segments };
}
// --- console capture --------------------------------------------------------

let consoleQueue = [];
let consoleTimer = null;
const CONSOLE_BATCH_MAX = 400;

function queueConsole(item) {
  consoleQueue.push(item);
  if (!consoleTimer) consoleTimer = setTimeout(flushConsole, 40);
}

function flushConsole() {
  consoleTimer = null;
  let batch = consoleQueue;
  consoleQueue = [];
  const logs = batch.filter((b) => !b.clear);
  if (logs.length > CONSOLE_BATCH_MAX) {
    const dropped = logs.length - CONSOLE_BATCH_MAX;
    const keep = new Set(logs.slice(-CONSOLE_BATCH_MAX));
    batch = batch.filter((b) => b.clear || keep.has(b));
    batch.push({ wcId: logs[0].wcId, level: 'warning', source: 'WebTester', text: `${dropped} console messages dropped (log flood)`, ts: Date.now() });
  }
  hostSend('guest:console', batch);
}

function fmtPreview(p) {
  const isArr = p.subtype === 'array';
  const props = (p.properties || []).map((x) => {
    const v = x.type === 'string' ? JSON.stringify(x.value) : x.value ?? x.subtype ?? x.type;
    return isArr ? v : `${x.name}: ${v}`;
  });
  const body = props.join(', ') + (p.overflow ? ', …' : '');
  if (isArr) return `[${body}]`;
  const name = p.description && p.description !== 'Object' ? `${p.description} ` : '';
  return `${name}{${body}}`;
}

function fmtRemote(o) {
  if (!o) return '';
  if (o.type === 'string') return o.value;
  if (o.type === 'undefined') return 'undefined';
  if (o.unserializableValue) return o.unserializableValue;
  if (o.subtype === 'null') return 'null';
  if (o.type !== 'object' && o.type !== 'function' && 'value' in o) return String(o.value);
  if (o.subtype === 'error') return o.description || 'Error';
  if (o.preview && o.type === 'object' && o.subtype !== 'node') return fmtPreview(o.preview);
  return o.description || o.className || o.type;
}

function formatArgs(args) {
  if (!args.length) return '';
  const out = [];
  let i = 0;
  if (args[0].type === 'string' && /%[sdifoOc]/.test(args[0].value)) {
    i = 1;
    out.push(args[0].value.replace(/%([sdifoOc%])/g, (m, f) => {
      if (f === '%') return '%';
      if (i >= args.length) return m;
      const a = args[i++];
      if (f === 'c') return '';
      if (f === 'd' || f === 'i') return a.type === 'number' ? String(Math.trunc(a.value)) : 'NaN';
      if (f === 'f') return a.type === 'number' ? String(a.value) : 'NaN';
      return fmtRemote(a);
    }));
  }
  for (; i < args.length; i++) out.push(fmtRemote(args[i]));
  return out.join(' ');
}

function formatStack(st) {
  const frames = st?.callFrames;
  if (!frames || !frames.length) return null;
  return frames
    .slice(0, 15)
    .map((f) => `    at ${f.functionName || '(anonymous)'} (${f.url || '<anonymous>'}:${f.lineNumber + 1}:${f.columnNumber + 1})`)
    .join('\n');
}

const CONSOLE_LEVELS = { error: 'error', assert: 'error', warning: 'warning', info: 'info', debug: 'debug', log: 'log', trace: 'log', dir: 'log', table: 'log' };
const LOG_LEVELS = { verbose: 'debug', info: 'info', warning: 'warning', error: 'error' };

function onCdpEvent(id, method, p) {
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      if (!(p.type in CONSOLE_LEVELS)) return;
      const level = CONSOLE_LEVELS[p.type];
      const frame = p.stackTrace?.callFrames?.[0];
      queueConsole({
        wcId: id,
        level,
        source: 'console',
        text: formatArgs(p.args || []) || (p.type === 'assert' ? 'Assertion failed' : ''),
        url: frame?.url || null,
        line: frame ? frame.lineNumber + 1 : null,
        stack: level === 'error' || p.type === 'trace' ? formatStack(p.stackTrace) : null,
        ts: Date.now(),
      });
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = p.exceptionDetails || {};
      const ex = d.exception || {};
      const desc = ex.description || (ex.value !== undefined ? String(ex.value) : '') || d.text || 'Uncaught error';
      const [first, ...rest] = String(desc).split('\n');
      const prefix = d.text && /^Uncaught/.test(d.text) ? d.text : 'Uncaught';
      queueConsole({
        wcId: id,
        level: 'error',
        source: 'exception',
        text: `${prefix} ${first}`,
        url: d.url || d.stackTrace?.callFrames?.[0]?.url || null,
        line: d.lineNumber != null ? d.lineNumber + 1 : null,
        stack: rest.length ? rest.join('\n') : formatStack(d.stackTrace),
        ts: Date.now(),
      });
      break;
    }
    case 'Log.entryAdded': {
      const e = p.entry || {};
      queueConsole({
        wcId: id,
        level: LOG_LEVELS[e.level] || 'info',
        source: e.source || 'browser',
        text: e.text || '',
        url: e.url || null,
        line: e.lineNumber != null ? e.lineNumber + 1 : null,
        stack: formatStack(e.stackTrace),
        ts: Date.now(),
      });
      break;
    }
    case 'Runtime.executionContextsCleared':
      queueConsole({ wcId: id, clear: true });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Storage, files, folder watching
// ---------------------------------------------------------------------------

const storePath = (k) => path.join(app.getPath('userData'), `${k}.json`);

function readStore(k) {
  if (!STORE_KEYS.has(k)) throw new Error(`Unknown store key: ${k}`);
  try {
    return JSON.parse(fs.readFileSync(storePath(k), 'utf8'));
  } catch {
    return null;
  }
}

function writeStore(k, v) {
  if (!STORE_KEYS.has(k)) throw new Error(`Unknown store key: ${k}`);
  const p = storePath(k);
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 2));
  fs.renameSync(`${p}.tmp`, p);
  return true;
}

const shotsDir = () => path.join(app.getPath('pictures'), 'WebTester');

function stopWatch() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

function startWatch(dir) {
  stopWatch();
  if (!dir || !fs.existsSync(dir)) return false;
  let timer = null;
  let lastFile = '';
  watcher = fs.watch(dir, { recursive: true }, (_evt, file) => {
    if (!file || /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(file)) return;
    lastFile = file;
    clearTimeout(timer);
    timer = setTimeout(() => hostSend('watch:changed', { dir, file: lastFile }), 250);
  });
  watcher.on('error', (err) => {
    hostSend('watch:error', err.message);
    stopWatch();
  });
  return true;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!win || e.sender !== win.webContents) throw new Error('Forbidden');
    return fn(...args);
  });
}

handle('app:info', () => ({
  demoUrl: pathToFileURL(path.join(__dirname, 'demo', 'index.html')).href,
  chrome: process.versions.chrome,
  electron: process.versions.electron,
  version: app.getVersion(),
  shotsDir: shotsDir(),
  platform: process.platform,
}));
handle('pane:configure', (id, cfg) => applyEmulation(id, cfg));
handle('pane:capture', (id, opts) => capture(id, opts));
handle('pane:mouse-move', (id, x, y) => cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }).catch(() => {}));
handle('store:get', (k) => readStore(k));
handle('store:set', (k, v) => writeStore(k, v));
handle('file:save-image', async ({ data, name }) => {
  const dir = shotsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const safe = String(name || 'screenshot').replace(/[^\w.\- @()]+/g, '_').slice(0, 140);
  const file = path.join(dir, `${safe}.png`);
  await fs.promises.writeFile(file, typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data));
  return file;
});
handle('file:show', (p) => shell.showItemInFolder(p));
handle('file:open-shots', async () => {
  await fs.promises.mkdir(shotsDir(), { recursive: true });
  return shell.openPath(shotsDir());
});
handle('file:open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open a local HTML file',
    properties: ['openFile'],
    filters: [{ name: 'Web pages', extensions: ['html', 'htm', 'svg', 'xhtml'] }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? null : pathToFileURL(r.filePaths[0]).href;
});
handle('watch:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Watch a folder for changes', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
handle('watch:start', (dir) => startWatch(dir));
handle('watch:stop', () => stopWatch());
handle('session:clear', async () => {
  const s = session.fromPartition(PARTITION);
  await s.clearStorageData();
  await s.clearCache();
  return true;
});

// ---------------------------------------------------------------------------
// Menu (accelerators work even when a pane has focus)
// ---------------------------------------------------------------------------

function buildMenu() {
  const cmd = (name) => () => hostSend('menu', name);
  const item = (label, accelerator, name, extra = {}) => ({ label, accelerator, click: cmd(name), ...extra });
  const template = [
    {
      label: 'File',
      submenu: [
        item('Focus Address Bar', 'CmdOrCtrl+L', 'focus-url'),
        item('Open Local File…', 'CmdOrCtrl+O', 'open-file'),
        item('Watch Folder for Live Reload…', undefined, 'watch-folder'),
        { type: 'separator' },
        item('Save Workspace…', 'CmdOrCtrl+S', 'save-workspace'),
        item('Workspaces…', 'CmdOrCtrl+Shift+O', 'workspaces'),
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        item('Reload All Panes', 'CmdOrCtrl+R', 'reload'),
        item('Reload All Panes', 'F5', 'reload', { visible: false, acceleratorWorksWhenHidden: true }),
        item('Hard Reload All Panes', 'CmdOrCtrl+Shift+R', 'hard-reload'),
        item('Back', 'Alt+Left', 'back'),
        item('Forward', 'Alt+Right', 'forward'),
        { type: 'separator' },
        item('Strip Layout', 'CmdOrCtrl+1', 'layout-strip'),
        item('Grid Layout', 'CmdOrCtrl+2', 'layout-grid'),
        item('Focus Layout', 'CmdOrCtrl+3', 'layout-focus'),
        { type: 'separator' },
        item('Zoom In', 'CmdOrCtrl+=', 'zoom-in'),
        item('Zoom Out', 'CmdOrCtrl+-', 'zoom-out'),
        item('Zoom to Fit', 'CmdOrCtrl+0', 'zoom-fit'),
        { type: 'separator' },
        item('Toggle Console', 'CmdOrCtrl+Shift+J', 'toggle-console'),
        { label: 'Toggle App DevTools', accelerator: 'CmdOrCtrl+Alt+I', click: () => win && win.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Test',
      submenu: [
        item('Add Device…', 'CmdOrCtrl+N', 'add-device'),
        item('Device Library…', 'CmdOrCtrl+Shift+N', 'device-library'),
        { type: 'separator' },
        item('All Panes Light', 'CmdOrCtrl+Shift+L', 'all-light'),
        item('All Panes Dark', 'CmdOrCtrl+Shift+D', 'all-dark'),
        item('Light + Dark Pairs', 'CmdOrCtrl+Shift+P', 'pair-themes'),
        { type: 'separator' },
        item('Toggle Sync', 'CmdOrCtrl+Shift+X', 'toggle-sync'),
        item('Inspect Elements Across Panes', 'CmdOrCtrl+Shift+C', 'toggle-inspect'),
        item('Toggle Debug Outlines', 'CmdOrCtrl+Shift+B', 'toggle-outlines'),
        item('Toggle Overflow Markers', 'CmdOrCtrl+Shift+F', 'toggle-overflow'),
        { type: 'separator' },
        item('Screenshot All Panes', 'CmdOrCtrl+Shift+S', 'shot-sheet'),
      ],
    },
    {
      label: 'Help',
      submenu: [item('Keyboard Shortcuts', 'F1', 'shortcuts'), item('About WebTester', undefined, 'about')],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Allow self-signed certificates for local development hosts only.
app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || /\.(localhost|local|test)$/.test(host)) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  // Development-only hook for automated smoke tests.
  if (!app.isPackaged && process.env.WT_SELFTEST) require(process.env.WT_SELFTEST)({ app, win, guests, cdp });
});

app.on('window-all-closed', () => {
  stopWatch();
  app.quit();
});
