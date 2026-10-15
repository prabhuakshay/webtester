'use strict';

// Renders every brand asset from the SVG sources.
// Usage: npm run brand
//
//   build/icon.png               512 px app icon (electron-builder, window icon)
//   build/icon.ico               16–256 px Windows icon; 16–48 px use the small-size cut
//   docs/brand/lockup-light.png  logo + wordmark for light backgrounds
//   docs/brand/lockup-dark.png   logo + wordmark for dark backgrounds
//   docs/brand/social-preview.png  1280×640 GitHub social card
//   docs/brand/brand-board.png   overview of the identity
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ICON = read('build/icon.svg');
const ICON_SMALL = read('build/icon-small.svg');
const MARK = read('docs/brand/logo-mark.svg');
const BLACK = read('docs/brand/logo-symbol-black.svg');
const WHITE = read('docs/brand/logo-symbol-white.svg');

const COLORS = {
  indigo: '#4263EB',
  violet: '#7048E8',
  ink: '#111827',
  paper: '#FFFFFF',
  indigoOnDark: '#91A7FF',
};
const FONT = "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif";

// Inline SVGs may repeat gradient ids; give each instance unique ids.
let uid = 0;
const sized = (svg, size) => {
  const n = uid++;
  return svg
    .replace(/<\?xml[^>]*>/, '')
    .replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)
    .replace(/id="(\w+)"/g, `id="$1_${n}"`)
    .replace(/url\(#(\w+)\)/g, `url(#$1_${n})`)
    .replace(/aria-labelledby="(\w+)"/g, `aria-labelledby="$1_${n}"`);
};

const page = (body, css = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent}
  body{font-family:${FONT}}
  ${css}</style></head><body>${body}</body></html>`;

let win;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webtester-brand-'));

async function render(html, width, height) {
  const file = path.join(tmp, `r${uid++}.html`);
  fs.writeFileSync(file, html);
  win.setContentSize(width, height);
  await win.loadFile(file);
  await new Promise((r) => setTimeout(r, 350));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  return img.resize({ width, height, quality: 'best' }).toPNG();
}

const out = (p, buf) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), buf);
  console.log(`wrote ${p}`);
};

// ICO with embedded PNG entries (supported since Windows Vista).
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

const lockup = (dark) => page(`
  <div class="lockup">${sized(ICON, 112)}<div class="word"><span class="w">Web</span><span class="t">Tester</span></div></div>`, `
  .lockup{display:flex;align-items:center;gap:26px;padding:20px 28px}
  .word{font-weight:700;font-size:92px;letter-spacing:-0.025em;line-height:1}
  .w{color:${dark ? COLORS.paper : COLORS.ink}} .t{color:${dark ? COLORS.indigoOnDark : COLORS.indigo}}`);

function socialPreview() {
  const shot = path.join(root, 'docs', 'screenshots', 'hero.png');
  const img = fs.existsSync(shot) ? `<img class="shot" src="${pathToFileURL(shot).href}">` : '';
  return page(`
  <div class="card">
    <div class="left">
      <div class="brand">${sized(ICON, 96)}<div class="word">Web<span>Tester</span></div></div>
      <h1>Test every screen<br>at once.</h1>
      <p>Phones, tablets and desktops side by side. Light and dark mode. Synced scrolling and clicks. Every error in one place.</p>
      <div class="pill">Free · Open source · Windows</div>
    </div>
    ${img}
  </div>`, `
  body{background:#0E1220}
  .card{position:relative;width:1280px;height:640px;overflow:hidden;color:#fff;
    background:radial-gradient(900px 500px at 0% 0%, rgba(76,110,245,.45), transparent 60%),
               radial-gradient(700px 500px at 100% 100%, rgba(112,72,232,.45), transparent 60%), #0E1220}
  .left{position:absolute;left:72px;top:70px;width:560px}
  .brand{display:flex;align-items:center;gap:20px}
  .word{font-weight:700;font-size:56px;letter-spacing:-0.025em}.word span{color:${COLORS.indigoOnDark}}
  h1{font-size:64px;line-height:1.05;letter-spacing:-0.03em;margin:44px 0 18px;font-weight:800}
  p{font-size:23px;line-height:1.45;color:#C3CAD9;margin:0 0 30px}
  .pill{display:inline-block;padding:10px 18px;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);font-size:18px;color:#E3E8F5}
  .shot{position:absolute;left:690px;top:96px;width:900px;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.12)}`);
}

function brandBoard() {
  const swatch = (name, hex, fg = '#fff') => `<div class="sw" style="background:${hex};color:${fg}"><b>${name}</b><span>${hex}</span></div>`;
  return page(`
  <div class="board">
    <h2>WebTester brand kit</h2>
    <div class="row">
      <div class="panel light">${sized(ICON, 180)}</div>
      <div class="panel light">${sized(MARK, 180)}</div>
      <div class="panel light">${sized(BLACK, 180)}</div>
      <div class="panel dark">${sized(WHITE, 180)}</div>
    </div>
    <div class="caps"><span>App icon (gradient)</span><span>Flat mark</span><span>One colour</span><span>Reversed</span></div>
    <div class="row sizes">
      <div class="panel light">${[128, 64, 48, 32].map((s) => sized(ICON, s)).join('')}${[24, 16].map((s) => sized(ICON_SMALL, s)).join('')}</div>
      <div class="panel dark">${[128, 64, 48, 32].map((s) => sized(ICON, s)).join('')}${[24, 16].map((s) => sized(ICON_SMALL, s)).join('')}</div>
    </div>
    <div class="row lock">
      <div class="panel light"><div class="lk">${sized(ICON, 64)}<div class="word"><span style="color:${COLORS.ink}">Web</span><span style="color:${COLORS.indigo}">Tester</span></div></div></div>
      <div class="panel dark"><div class="lk">${sized(ICON, 64)}<div class="word"><span style="color:#fff">Web</span><span style="color:${COLORS.indigoOnDark}">Tester</span></div></div></div>
    </div>
    <div class="row">${swatch('Indigo', COLORS.indigo)}${swatch('Violet', COLORS.violet)}${swatch('Ink', COLORS.ink)}${swatch('Indigo on dark', COLORS.indigoOnDark, '#111827')}${swatch('Paper', COLORS.paper, '#111827')}</div>
  </div>`, `
  body{background:#ECEEF2}
  .board{width:1400px;padding:40px;box-sizing:border-box;color:#111827}
  h2{margin:0 0 22px;font-size:30px;letter-spacing:-.01em}
  .row{display:flex;gap:18px;margin-bottom:12px}
  .panel{flex:1;display:flex;align-items:center;justify-content:center;gap:22px;padding:26px;border-radius:16px}
  .light{background:#fff}.dark{background:#141824}
  .caps{display:flex;gap:18px;margin:0 0 26px}.caps span{flex:1;text-align:center;color:#5d6778;font-size:15px}
  .sizes .panel{justify-content:center;align-items:flex-end}
  .lk{display:flex;align-items:center;gap:16px}.word{font-weight:700;font-size:52px;letter-spacing:-.025em}
  .sw{flex:1;height:110px;border-radius:14px;padding:16px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:flex-end;font-size:15px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
  .sw span{opacity:.8;font-family:Consolas,monospace}`);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  try {
    out('build/icon.png', await render(page(sized(ICON, 512)), 512, 512));

    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const entries = [];
    for (const size of sizes) {
      const src = size <= 48 ? ICON_SMALL : ICON;
      entries.push({ size, png: await render(page(`<div style="width:${size}px;height:${size}px">${sized(src, size)}</div>`), size, size) });
    }
    out('build/icon.ico', buildIco(entries));

    out('docs/brand/lockup-light.png', await render(lockup(false), 640, 152));
    out('docs/brand/lockup-dark.png', await render(lockup(true), 640, 152));
    out('docs/brand/social-preview.png', await render(socialPreview(), 1280, 640));
    win.setBackgroundColor('#ECEEF2');
    const board = brandBoard();
    win.setContentSize(1400, 1200);
    const file = path.join(tmp, 'board.html');
    fs.writeFileSync(file, board);
    await win.loadFile(file);
    const h = await win.webContents.executeJavaScript('document.querySelector(".board").offsetHeight');
    out('docs/brand/brand-board.png', await render(board, 1400, h));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  app.quit();
});
