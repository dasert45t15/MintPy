const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SCHEMA_VERSION, createDataStore } = require('../src/main/data-store');

const logger = { info() {}, warn() {}, error() {} };

function fixture(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintpy-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mintpy-data.json');
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return { dir, file, store: createDataStore(file, logger) };
}

test('legacy data migrates with a backup and keeps the library', t => {
  const legacy = {
    favorites: [{ id: 'yt:abc123_xyz0' }], playlists: [],
    library: { folders: ['C:\\Music'], tracks: [{ id: 'local:C:\\Music\\song.mp3' }] },
    settings: { style: 'forest', opacity: 0.8 }
  };
  const { dir, file, store } = fixture(t, JSON.stringify(legacy));
  const data = store.loadData();
  assert.equal(data.schemaVersion, SCHEMA_VERSION);
  assert.equal(data.library.tracks.length, 1);
  assert.equal(data.settings.style, 'forest');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, SCHEMA_VERSION);
  assert.equal(fs.readdirSync(dir).some(name => name.includes('.v0-') && name.endsWith('.bak')), true);
});

test('corrupt data is backed up before a new store is saved', t => {
  const { dir, file, store } = fixture(t, '{broken');
  const data = store.loadData();
  assert.deepEqual(data.favorites, []);
  const backup = fs.readdirSync(dir).find(name => name.includes('.corrupt-') && name.endsWith('.bak'));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), '{broken');
  data.settings.style = 'lofi';
  store.saveData(data);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settings.style, 'lofi');
});

test('future schema is preserved and cannot be overwritten', t => {
  const original = JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, favorites: ['future'] });
  const { file, store } = fixture(t, original);
  store.loadData();
  assert.throws(() => store.saveData({ favorites: [] }), /read-only/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('new data saves with a schema version', t => {
  const { file, store } = fixture(t);
  const data = store.loadData();
  data.settings.pet = 'builtin:duck';
  assert.equal(store.saveData(data), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settings.pet, 'builtin:duck');
});

test('malformed saved entries cannot break library and playlist readers', t => {
  const raw = { schemaVersion: SCHEMA_VERSION, favorites: [null, { id: 'yt:abc123_xyz0' }],
    playlists: [null, { id: 'pl_1', name: 'Good', tracks: null }],
    library: { folders: [null, 'C:\\Music'], tracks: [null, { id: 'local:sample' }] } };
  const { store } = fixture(t, JSON.stringify(raw));
  const data = store.loadData();
  assert.equal(data.favorites.length, 1);
  assert.equal(data.playlists[0].tracks.length, 0);
  assert.deepEqual(data.library.folders, ['C:\\Music']);
  assert.equal(data.library.tracks.length, 1);
});
