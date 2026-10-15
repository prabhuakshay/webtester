'use strict';

// Syntax-checks every JavaScript file shipped with the app.
// Usage: npm run check
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dirs = ['.', 'renderer', 'scripts'];
const files = dirs.flatMap((d) =>
  fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)));

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log(`ok    ${file}`);
  } else {
    failed++;
    console.error(`FAIL  ${file}\n${r.stderr}`);
  }
}
if (failed) {
  console.error(`\n${failed} file(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} files passed.`);
