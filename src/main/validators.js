const path = require('path');

const STYLES = new Set(['zen', 'lofi', 'synthwave', 'aurora', 'ocean', 'forest']);
const ACCENTS = new Set(['blue-purple', 'green-teal', 'orange-red', 'pink-rose', 'cyan-lime', 'white-cold']);
const KEY_ACTIONS = new Set(['play-pause', 'seek-forward', 'seek-back', 'vol-up', 'vol-down', 'mute-toggle', 'next-track', 'prev-track']);
const PET_NAMES = '(?:cat|shiba|duck|panda|ghost)';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, name, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    throw new TypeError(name + ' must be a non-empty string of at most ' + max + ' characters');
  }
  return value;
}

function number(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(name + ' must be a number between ' + min + ' and ' + max);
  }
  return value;
}

function defaultSettings() {
  return {
    opacity: 1, auraIntensity: 0.35, compactMode: false, appearance: 'system',
    accentColor: 'blue-purple', customColor: '', cornerRadius: 30, keybinds: {},
    style: 'zen', pet: '', petSize: 96, petPos: null,
    volumeNormalize: false, eqBands: { low: 0, mid: 0, high: 0 }, crossfadeSeconds: 0,
    setupCompleted: false
  };
}

function validateSettings(raw) {
  if (!isRecord(raw)) throw new TypeError('settings must be an object');
  const result = defaultSettings();
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(result, key)) continue;
    if (key === 'opacity') result[key] = number(value, key, 0.05, 1);
    else if (key === 'auraIntensity') result[key] = number(value, key, 0, 1);
    else if (key === 'cornerRadius') result[key] = number(value, key, 0, 100);
    else if (key === 'petSize') result[key] = number(value, key, 40, 200);
    else if (key === 'crossfadeSeconds') result[key] = number(value, key, 0, 12);
    else if (key === 'setupCompleted') {
      if (typeof value !== 'boolean') throw new TypeError('setupCompleted must be boolean');
      result[key] = value;
    } else if (key === 'compactMode') {
      if (typeof value !== 'boolean') throw new TypeError('compactMode must be boolean');
      result[key] = value;
    } else if (key === 'volumeNormalize') {
      if (typeof value !== 'boolean') throw new TypeError('volumeNormalize must be boolean');
      result[key] = value;
    } else if (key === 'eqBands') {
      if (!isRecord(value)) throw new TypeError('eqBands must be an object');
      result[key] = { low: number(value.low ?? 0, 'eqBands.low', -12, 12), mid: number(value.mid ?? 0, 'eqBands.mid', -12, 12), high: number(value.high ?? 0, 'eqBands.high', -12, 12) };
    } else if (key === 'appearance') {
      if (!['system', 'light', 'dark'].includes(value)) throw new TypeError('Invalid appearance');
      result[key] = value;
    } else if (key === 'accentColor') {
      if (!ACCENTS.has(value)) throw new TypeError('Invalid accentColor');
      result[key] = value;
    } else if (key === 'style') {
      if (!STYLES.has(value)) throw new TypeError('Invalid style');
      result[key] = value;
    } else if (key === 'customColor') {
      if (typeof value !== 'string' || (value && !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value))) {
        throw new TypeError('Invalid customColor');
      }
      result[key] = value;
    } else if (key === 'pet') {
      if (typeof value !== 'string' || value.length > 110 ||
          (value && !new RegExp('^(?:builtin:' + PET_NAMES + '|gif:' + PET_NAMES + '\\.gif|custom:[A-Za-z0-9_.-]+\\.(?:png|gif|jpe?g|webp))$', 'i').test(value)) ||
          value.includes('..')) throw new TypeError('Invalid pet');
      result[key] = value;
    } else if (key === 'petPos') {
      if (value !== null && (!isRecord(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y) ||
          Math.abs(value.x) > 100000 || Math.abs(value.y) > 100000)) throw new TypeError('Invalid petPos');
      result[key] = value === null ? null : { x: value.x, y: value.y };
    } else if (key === 'keybinds') {
      if (!isRecord(value)) throw new TypeError('keybinds must be an object');
      const bindings = {};
      for (const [action, accelerator] of Object.entries(value)) {
        if (!KEY_ACTIONS.has(action)) continue;
        text(accelerator, 'keybind', 80, true);
        if (/[\x00-\x1f]/.test(accelerator)) throw new TypeError('Invalid keybind');
        bindings[action] = accelerator;
      }
      result[key] = bindings;
    }
  }
  return result;
}

function validateSearchQuery(query) {
  return text(query, 'query', 200).trim();
}

function validatePlaylistName(name) {
  return text(name, 'playlist name', 120).trim();
}

function validatePlaylistId(id) {
  return text(id, 'playlist id', 100);
}

function validateTrackId(id) {
  return text(id, 'track id', 4100);
}

function validateTrack(raw, allowedLocalFiles) {
  if (!isRecord(raw)) throw new TypeError('track must be an object');
  const id = validateTrackId(raw.id);
  const source = raw.source;
  if (source !== 'local' && source !== 'youtube') throw new TypeError('Invalid track source');
  const title = text(raw.title, 'track title', 512);
  const artist = text(raw.artist, 'track artist', 512);
  const album = raw.album == null ? '' : text(raw.album, 'track album', 512, true);
  const artwork = raw.artwork == null ? '' : text(raw.artwork, 'track artwork', 4096, true);
  const duration = number(raw.duration || 0, 'track duration', 0, 2592000);
  if (source === 'youtube') {
    if (!/^yt:(?:[A-Za-z0-9_-]{6,20}|ytsearch:.+)$/.test(id)) throw new TypeError('Invalid YouTube track id');
    return { id, title, artist, album, artwork, duration, source };
  }
  const filepath = text(raw.filepath, 'track filepath', 4096);
  const resolved = path.resolve(filepath);
  if (!id.startsWith('local:') || path.resolve(id.slice(6)) !== resolved || !allowedLocalFiles.has(resolved)) {
    throw new TypeError('Local track was not imported');
  }
  return { id, filepath: resolved, title, artist, album, artwork, duration, source };
}

function validPetFile(file) {
  return typeof file === 'string' && file.length <= 110 &&
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:png|gif|jpe?g|webp)$/i.test(file) && !file.includes('..') &&
    path.basename(file) === file;
}

function isTrustedSender(event, mainWindow, appUrl) {
  if (!mainWindow || mainWindow.isDestroyed() || !event || !event.senderFrame) return false;
  return event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    event.senderFrame.url === appUrl;
}

module.exports = {
  isRecord, defaultSettings, validateSettings, validateSearchQuery, validatePlaylistName,
  validatePlaylistId, validateTrackId, validateTrack, validPetFile, isTrustedSender
};
