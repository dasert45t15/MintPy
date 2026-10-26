const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { defaultSettings, validateSettings, isRecord } = require('./validators');

const SCHEMA_VERSION = 2;

function defaultData() {
  return { schemaVersion: SCHEMA_VERSION, favorites: [], history: [], playback: { queue: [], currentIndex: -1 }, playlists: [], library: { folders: [], tracks: [] }, settings: defaultSettings() };
}

function normalizeSettings(raw) {
  const settings = defaultSettings();
  if (!isRecord(raw)) return settings;
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(settings, key)) continue;
    try { settings[key] = validateSettings({ [key]: value })[key]; } catch {}
  }
  return settings;
}

function normalizeData(raw) {
  if (!isRecord(raw)) throw new TypeError('Data must be an object');
  const version = raw.schemaVersion == null ? 0 : raw.schemaVersion;
  if (![0, 1, SCHEMA_VERSION].includes(version)) {
    const error = new Error('Unsupported data schema version: ' + version);
    error.code = 'UNSUPPORTED_SCHEMA';
    throw error;
  }
  const library = isRecord(raw.library) ? raw.library : {};
  const validTrack = track => isRecord(track) && typeof track.id === 'string';
  return {
    schemaVersion: SCHEMA_VERSION,
    favorites: Array.isArray(raw.favorites) ? raw.favorites.filter(validTrack) : [],
    history: Array.isArray(raw.history) ? raw.history.filter(validTrack).slice(0, 500) : [],
    playback: (() => {
      const playback = isRecord(raw.playback) ? raw.playback : {};
      const queue = Array.isArray(playback.queue) ? playback.queue.filter(validTrack).slice(0, 1000) : [];
      const index = Number.isInteger(playback.currentIndex) && playback.currentIndex >= -1 && playback.currentIndex < queue.length ? playback.currentIndex : -1;
      return { queue, currentIndex: index };
    })(),
    playlists: Array.isArray(raw.playlists) ? raw.playlists
      .filter(playlist => isRecord(playlist) && typeof playlist.id === 'string' && typeof playlist.name === 'string')
      .map(playlist => ({ id: playlist.id, name: playlist.name, tracks: Array.isArray(playlist.tracks) ? playlist.tracks.filter(validTrack) : [] })) : [],
    library: {
      folders: Array.isArray(library.folders) ? library.folders.filter(folder => typeof folder === 'string') : [],
      tracks: Array.isArray(library.tracks) ? library.tracks.filter(validTrack) : []
    },
    settings: normalizeSettings(raw.settings)
  };
}

function createDataStore(filePath, logger = console) {
  let cache = null;
  let readOnly = false;

  function backup(reason) {
    const suffix = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    const backupPath = filePath + '.' + reason + '-' + suffix + '.bak';
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  }

  function write(data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
  }

  function loadData() {
    if (cache) return cache;
    if (!fs.existsSync(filePath)) return (cache = defaultData());
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      try { logger.warn('Data file is invalid; backup: ' + backup('corrupt')); }
      catch (backupError) { readOnly = true; logger.error('Cannot back up invalid data:', backupError); }
      logger.error('Cannot read data:', error);
      return (cache = defaultData());
    }
    try {
      const migrated = normalizeData(raw);
      if (raw.schemaVersion !== SCHEMA_VERSION) {
        logger.info('Migrating data schema to version ' + SCHEMA_VERSION + '; backup: ' + backup('v' + (raw.schemaVersion ?? 0)));
        write(migrated);
      }
      return (cache = migrated);
    } catch (error) {
      readOnly = true;
      logger.error('Cannot migrate data; original file preserved:', error);
      return (cache = defaultData());
    }
  }

  function saveData(data) {
    if (readOnly) throw new Error('Data file is read-only because loading or backup failed');
    const normalized = normalizeData({ ...data, schemaVersion: SCHEMA_VERSION });
    write(normalized);
    cache = normalized;
    return true;
  }

  return { loadData, saveData };
}

module.exports = { SCHEMA_VERSION, defaultData, normalizeData, createDataStore };
