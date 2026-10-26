const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  validateSearchQuery, validatePlaylistName, validateSettings, validateTrack,
  isTrustedSender, validPetFile
} = require('../src/main/validators');

test('IPC text inputs are bounded', () => {
  assert.equal(validateSearchQuery('  jazz  '), 'jazz');
  assert.equal(validatePlaylistName('  Evening  '), 'Evening');
  assert.throws(() => validateSearchQuery('x'.repeat(201)), /query/);
  assert.throws(() => validatePlaylistName('   '), /playlist name/);
});

test('settings preserve valid choices and reject invalid values', () => {
  const settings = validateSettings({
    style: 'forest', pet: 'builtin:cat', petPos: { x: 10, y: 20 },
    keybinds: { 'mute-toggle': 'KeyM', unknown: 'KeyZ' }, extra: 'discard'
  });
  assert.equal(settings.style, 'forest');
  assert.deepEqual(settings.petPos, { x: 10, y: 20 });
  assert.deepEqual(settings.keybinds, { 'mute-toggle': 'KeyM' });
  assert.equal(Object.hasOwn(settings, 'extra'), false);
  assert.throws(() => validateSettings({ appearance: 'danger' }), /appearance/);
  assert.throws(() => validateSettings({ opacity: 2 }), /opacity/);
});

test('local track must have been imported', () => {
  const filepath = path.resolve('sample.mp3');
  const local = { id: 'local:' + filepath, filepath, source: 'local', title: 'Track', artist: 'Artist', duration: 1 };
  assert.throws(() => validateTrack(local, new Set()), /not imported/);
  assert.equal(validateTrack(local, new Set([filepath])).filepath, filepath);
  assert.throws(() => validateTrack({ ...local, id: 'local:other.mp3' }, new Set([filepath])), /not imported/);
});

test('YouTube tracks and custom pet filenames are constrained', () => {
  const track = { id: 'yt:abc123_xyz0', source: 'youtube', title: 'Track', artist: 'Artist', duration: 1 };
  assert.equal(validateTrack(track, new Set()).id, track.id);
  assert.throws(() => validateTrack({ ...track, id: 'yt:bad' }, new Set()), /YouTube/);
  assert.equal(validPetFile('pet_123.gif'), true);
  assert.equal(validPetFile('../secret.gif'), false);
});

test('IPC only accepts the main application frame', () => {
  const frame = { url: 'file:///app/src/index.html' };
  const contents = { mainFrame: frame };
  const win = { isDestroyed: () => false, webContents: contents };
  assert.equal(isTrustedSender({ sender: contents, senderFrame: frame }, win, frame.url), true);
  assert.equal(isTrustedSender({ sender: contents, senderFrame: { url: frame.url } }, win, frame.url), false);
  assert.equal(isTrustedSender({ sender: contents, senderFrame: frame }, win, 'https://example.com'), false);
});
