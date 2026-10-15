# Security Policy

## Supported versions

Security fixes are made for the latest release. Please update to the newest version before reporting.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report it privately through GitHub instead: go to the repository's **Security** tab and choose
**[Report a vulnerability](https://github.com/prabhuakshay/webtester/security/advisories/new)**.

Include what you found, steps to reproduce, and the impact you expect. You'll get an acknowledgement
within a few days, and a fix or mitigation plan as soon as the issue is confirmed. Reporters are credited
in the release notes unless they'd rather not be.

## Scope

WebTester loads arbitrary websites, so the boundaries that matter most are:

- A web page shown in a pane must not be able to run code outside its own sandboxed pane, access your files,
  or reach the app's internal interfaces.
- Pages must not be able to open new app windows or navigate the app's own interface.

Issues in Chromium or Electron themselves should be reported upstream; we'll ship their fixes by updating
Electron.
