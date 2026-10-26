const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const roots = ['src', 'src_mobile', 'scripts', 'tests', path.join('landing', 'js')];
const files = ['app.js', 'preload.js'];

function collect(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (entry.isFile() && file.endsWith('.js')) files.push(file);
  }
}
roots.forEach(collect);

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = 1;
}
if (!process.exitCode) console.log('Syntax OK: ' + files.length + ' JavaScript files');
