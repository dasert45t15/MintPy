const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const utils = require('../shared/utils.js');

function readText(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function collectFiles(dir, extFilter) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, extFilter));
    else if (!extFilter || extFilter(full)) out.push(full);
  }
  return out;
}

test('version metadata is synchronized across package.json, shared/utils.js, and README.md', () => {
  assert.equal(utils.VERSION, pkg.version, 'shared/utils.js VERSION must match package.json version');
  const readme = readText('README.md');
  assert.ok(
    readme.includes(`version-${pkg.version}`),
    `README.md badge must mention current version ${pkg.version}`
  );
});

test('all HTML script and stylesheet imports resolve to existing non-empty files', () => {
  const entrypoints = ['src/index.html', 'src_mobile/index.html'];
  for (const htmlRel of entrypoints) {
    const htmlDir = path.dirname(path.join(ROOT, htmlRel));
    const html = readText(htmlRel);

    const refs = [
      ...[...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi)].map((m) => m[1]),
      ...[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]),
      ...[...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).filter(Boolean)
    ];

    assert.ok(refs.length >= 8, `${htmlRel} should load modular stylesheets and scripts`);
    for (const ref of refs) {
      if (/^https?:\/\//i.test(ref) || ref.startsWith('data:')) continue;
      const resolved = path.resolve(htmlDir, ref);
      assert.ok(fs.existsSync(resolved), `Missing referenced file "${ref}" in ${htmlRel} -> ${resolved}`);
      assert.ok(fs.statSync(resolved).size > 0, `Empty referenced file "${ref}" in ${htmlRel}`);
    }
  }
});

test('all CSS url(...) asset references exist on disk and !important creep is prevented', () => {
  const cssDirs = [path.join(ROOT, 'src', 'css'), path.join(ROOT, 'src_mobile', 'css')];
  let pcImportantCount = 0;

  for (const dir of cssDirs) {
    const cssFiles = collectFiles(dir, (f) => f.endsWith('.css'));
    assert.ok(cssFiles.length >= 4, `Expected modular CSS files inside ${dir}`);

    for (const cssFile of cssFiles) {
      const content = fs.readFileSync(cssFile, 'utf8');
      if (cssFile.includes(path.join('src', 'css'))) {
        const matches = content.match(/!important/g);
        pcImportantCount += matches ? matches.length : 0;
      }

      const urls = [...content.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((m) => m[1].trim());
      for (const u of urls) {
        if (/^(?:data:|https?:|cover:|#)/i.test(u)) continue;
        const resolved = path.resolve(path.dirname(cssFile), u);
        assert.ok(
          fs.existsSync(resolved),
          `Broken CSS asset url("${u}") in ${path.relative(ROOT, cssFile)} -> ${resolved}`
        );
      }
    }
  }

  assert.ok(
    pcImportantCount < 30,
    `Desktop CSS !important count (${pcImportantCount}) must stay below 30 to prevent specificity wars`
  );
});

test('native C++20 and standalone Android Java sources exist with zero hardcoded local drive paths', () => {
  const requiredFiles = [
    'native/CMakeLists.txt',
    'native/res/resource.rc',
    'native/src/main.cpp',
    'native/src/http_client.cpp',
    'native/src/audio_proxy.cpp',
    'native/src/data_store.cpp',
    'native/src/tag_scanner.cpp',
    'android/AndroidManifest.xml',
    'android/java/com/mintpy/app/MainActivity.java',
    'android/java/com/mintpy/app/PlaybackService.java',
    'android/java/com/mintpy/app/LocalAudioProxy.java'
  ];

  for (const rel of requiredFiles) {
    const full = path.join(ROOT, rel);
    assert.ok(fs.existsSync(full), `Missing core source file: ${rel}`);
    assert.ok(fs.statSync(full).size > 20, `Core source file is unexpectedly empty: ${rel}`);
  }

  const scanDirs = ['shared', 'src', 'src_mobile', 'native/src', 'native/include', 'native/res', 'android', 'scripts'];
  const hardcodedDriveRe = /[A-Za-z]:\\\\mintpy|[A-Za-z]:\\mintpy|C:\\Users\\/i;

  for (const relDir of scanDirs) {
    const files = collectFiles(path.join(ROOT, relDir), (f) => /\.(js|css|html|cpp|h|rc|java|xml|py|ps1|nsi)$/i.test(f));
    for (const file of files) {
      const txt = fs.readFileSync(file, 'utf8');
      assert.ok(
        !hardcodedDriveRe.test(txt),
        `Hardcoded machine-specific path found in ${path.relative(ROOT, file)}`
      );
    }
  }
});

test('legacy Electron dead files remain absent', () => {
  for (const dead of ['app.js', 'preload.js', 'src/main', 'src/mobile-bridge.js', 'src/styles.css', 'src_mobile/styles.css', 'landing']) {
    assert.ok(!fs.existsSync(path.join(ROOT, dead)), `Obsolete path should not exist: ${dead}`);
  }
});
