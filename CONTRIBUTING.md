# Contributing to WebTester

Thanks for helping make WebTester better! Bug reports, ideas, docs fixes and code are all welcome.

- **Found a bug?** [Open a bug report](https://github.com/prabhuakshay/webtester/issues/new?template=bug_report.yml). Steps to reproduce and the page URL (if public) help a lot.
- **Have an idea?** [Suggest a feature](https://github.com/prabhuakshay/webtester/issues/new?template=feature_request.yml).
- **Security issue?** Please don't open a public issue; see [SECURITY.md](SECURITY.md).

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Running from source

Requirements: **Node.js 22+** and **Windows 10/11** (the app is Electron-based and also starts on macOS and Linux for development, but releases target Windows).

```bash
git clone https://github.com/prabhuakshay/webtester.git
cd webtester
npm install
npm start
```

The app opens with a bundled demo page (`demo/`) that has a few deliberate bugs, useful for trying the console and layout checks.

### Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the app from source |
| `npm run check` | Syntax-check every JavaScript file (also runs in CI) |
| `npm run dist` | Build the Windows installer and portable `.exe` into `dist/` |
| `npm run dist:dir` | Build an unpacked app folder (faster, for testing packaging) |
| `npm run brand` | Re-render the app icon, `.ico` and brand images from the SVG sources |

## How it's built

There is no bundler or framework: plain HTML, CSS and JavaScript on top of Electron.

| Path | Role |
|---|---|
| `main.js` | Main process. Hosts each pane as a `<webview>` and drives it through the Chrome DevTools Protocol: device metrics, `prefers-color-scheme` and other media features, touch, user agent, network throttling, vision deficiency, and console/exception capture. Also screenshots, storage, folder watching and the app menu (keyboard shortcuts). |
| `preload-host.js` | The small, explicit bridge (`window.wt`) between the UI and the main process. |
| `preload-guest.js` | Runs inside every pane in an isolated world. Captures scroll, click, input and key events and replays those mirrored from other panes; draws the inspect and overflow overlays; runs the layout checks. |
| `renderer/` | The app UI: `app.js` (panes, layout, sync relay, menus, workspaces, screenshots), `console.js` (the unified console), `devices.js` (device library and presets), `icons.js`, `styles.css`. |
| `demo/` | The bundled demo site. |
| `build/` | App icon sources (`icon.svg`, `icon-small.svg`) and rendered `icon.png` / `icon.ico`. |
| `docs/` | README screenshots and brand assets. |

### Things worth knowing

- **Sync** relays DOM events between panes and finds the same element with a structural CSS selector. Replayed events are untrusted, so they never echo back; scroll replays use a short quiet window for the same reason.
- **Back/forward** use `goToOffset` rather than `goBack`: Chromium's history intervention skips entries left via synthetic clicks, which is how follower panes navigate.
- **Screenshots** use `webContents.capturePage()` with the pane briefly at 100% zoom; full-page shots scroll through the page and stitch. `Page.captureScreenshot` tiles its output inside `<webview>` guests whenever the pixel ratio is emulated.
- **Security**: the UI runs with `contextIsolation` and `sandbox`; panes run sandboxed with no Node access, and new windows are redirected into the panes.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep changes focused; match the surrounding code style (2-space indent, single quotes, semicolons).
3. Run `npm run check` and try your change in the app with `npm start`.
4. Describe what changed and how you tested it. Screenshots help for UI changes.

## Releasing (maintainers)

Releases are built and published by GitHub Actions when a version tag is pushed.

1. Update `version` in `package.json` and add an entry to [CHANGELOG.md](CHANGELOG.md).
2. Commit, then tag and push:
   ```bash
   git tag v1.2.3
   git push origin main --tags
   ```
3. The [Release workflow](.github/workflows/release.yml) checks that the tag matches `package.json`, builds the installer and portable `.exe` on Windows, and publishes them to GitHub Releases with SHA-256 checksums and generated release notes.

## Brand

The logo and colours are documented in [docs/brand](docs/brand/README.md). Edit the SVG sources and run `npm run brand` to regenerate the icon files.
