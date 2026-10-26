const { app, BrowserWindow, ipcMain, dialog, protocol, net, globalShortcut, Tray, Menu, nativeImage, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createAudioProxy } = require('./src/main/audio-proxy');
const { createDataStore, normalizeData } = require('./src/main/data-store');
const { importFromUrl } = require('./src/main/playlist-importer');
const { findBestYouTubeTrack } = require('./src/main/smart-resolver');
const { validateSettings, validateSearchQuery, validatePlaylistName, validatePlaylistId, validateTrackId, validateTrack, validPetFile, isTrustedSender } = require('./src/main/validators');
const discordRpc = require('./src/main/discord-rpc');
const { URL, pathToFileURL } = require('url');

// cover:// protocol serves album artwork cached on disk
protocol.registerSchemesAsPrivileged([
  { scheme: 'cover', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// Single instance: a second launch just focuses the existing window
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let mainWindow;
let tray = null;
let isQuitting = false;
const APP_URL = pathToFileURL(path.join(__dirname, 'src', 'index.html')).toString();
function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event, mainWindow, APP_URL)) throw new Error('Unauthorized IPC sender');
    return callback(event, ...args);
  });
}
function on(channel, callback) {
  ipcMain.on(channel, (event, ...args) => {
    if (isTrustedSender(event, mainWindow, APP_URL)) callback(event, ...args);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360, height: 860,
    minWidth: 980, minHeight: 680,
    frame: false, transparent: true,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'mintpy-logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      sandbox: true,
      backgroundThrottling: false,
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.webContents.on('will-navigate', (event, details) => {
    const destination = typeof details === 'string' ? details : details?.url;
    if (destination !== APP_URL) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('unresponsive', () => console.error('Window unresponsive'));
  mainWindow.webContents.on('crashed', () => console.error('Renderer crashed'));
  mainWindow.on('close', event => {
    if (isQuitting || !tray) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  if (!gotTheLock) return;
  protocol.handle('cover', (req) => {
    try {
      const u = new URL(req.url);
      const name = path.basename(decodeURIComponent(u.pathname));
      if (!/^[a-f0-9]{40}\.(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(name)) {
        return new Response('Bad request', { status: 400 });
      }
      const p = path.join(app.getPath('userData'), 'covers', name);
      return net.fetch(pathToFileURL(p).toString());
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });
  createWindow();
  createTray();
  registerMediaKeys();
  verifyYtDlp();
});

app.on('activate', showMainWindow);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { isQuitting = true; });

on('win-control', (_, action) => {
  if (!mainWindow) return;
  if (action === 'close') mainWindow.close();
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});

on('set-window-opacity', (_, value) => {
  const v = Number(value);
  if (Number.isFinite(v) && mainWindow) mainWindow.setOpacity(Math.min(1, Math.max(0.05, v)));
});

// Global mute hotkey - works even when another app has focus
function toElectronAccelerator(acc) {
  if (!acc || typeof acc !== 'string') return null;
  const parts = acc.split('+').map(part => {
    part = part.trim();
    if (/^Key([A-Za-z0-9])$/i.test(part)) return part.slice(3).toUpperCase();
    if (part === 'ArrowUp') return 'Up';
    if (part === 'ArrowDown') return 'Down';
    if (part === 'ArrowLeft') return 'Left';
    if (part === 'ArrowRight') return 'Right';
    if (part === 'Super') return 'Meta';
    return part;
  });
  return parts.filter(Boolean).join('+');
}

let registeredMuteAcc = null;
handle('set-global-mute', (_, rawAcc) => {
  if (rawAcc != null && (typeof rawAcc !== 'string' || rawAcc.length > 80 || /[\x00-\x1f]/.test(rawAcc))) throw new TypeError('Invalid accelerator');
  try {
    if (registeredMuteAcc) {
      try { globalShortcut.unregister(registeredMuteAcc); } catch {}
      registeredMuteAcc = null;
    }
    const acc = toElectronAccelerator(rawAcc);
    if (!acc) return { ok: true };
    const ok = globalShortcut.register(acc, () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('global-mute-triggered');
    });
    if (!ok) return { ok: false, error: `"${acc}" is taken by another application or OS` };
    registeredMuteAcc = acc;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
  try { discordRpc.destroy(); } catch {}
  tray?.destroy();
  tray = null;
});

function showMainWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendMediaCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media-command', command);
}

function registerMediaKeys() {
  for (const [key, command] of [['MediaPlayPause', 'play-pause'], ['MediaNextTrack', 'next-track'], ['MediaPreviousTrack', 'prev-track']]) {
    try { if (!globalShortcut.isRegistered(key)) globalShortcut.register(key, () => sendMediaCommand(command)); } catch (error) { console.warn('Media key registration failed:', key, error.message); }
  }
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'assets', 'mintpy-logo.png');
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) { console.warn('Tray icon unavailable:', iconPath); return; }
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('MintPy');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open MintPy', click: showMainWindow },
    { label: 'Play / Pause', click: () => sendMediaCommand('play-pause') },
    { label: 'Next track', click: () => sendMediaCommand('next-track') },
    { label: 'Previous track', click: () => sendMediaCommand('prev-track') },
    { type: 'separator' },
    { label: 'Exit', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

// Search tracks - use yt-dlp for reliable YouTube search
function getYtDlpPath() {
  const bundled = path.join(__dirname, 'bin', 'yt-dlp.exe');
  if (fs.existsSync(bundled)) return bundled;
  const resources = process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'yt-dlp.exe') : '';
  if (resources && fs.existsSync(resources)) return resources;
  return 'yt-dlp';
}

let ytDlpOk = false;
function verifyYtDlp() {
  const bin = getYtDlpPath();
  try {
    const out = require('child_process').execSync(`"${bin}" --version`, { stdio: 'pipe', timeout: 10000 });
    console.log('yt-dlp version:', out.toString().trim());
    ytDlpOk = true;
  } catch (e) {
    console.error('WARNING: yt-dlp not found at:', bin, e.message);
  }
}

handle('yt-dlp-status', () => ytDlpOk);

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else {
    child.kill('SIGKILL');
  }
}

function ytDlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(getYtDlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { killTree(child); reject(new Error('yt-dlp timed out')); }, timeoutMs || 30000);
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && stdout) resolve(stdout.trim());
      else reject(new Error(`yt-dlp exited code ${code}: ${stderr.slice(0, 200)}`));
    });
    child.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

handle('search-tracks', async (_, query) => {
  query = validateSearchQuery(query);
  try {
    // Request more than needed: live streams and unplayable entries get filtered out
    const json = await ytDlp(['--flat-playlist', '--dump-json', `ytsearch30:${query}`]);
    const lines = json.split('\n').filter(Boolean);
    const tracks = [];
    for (const line of lines) {
      let t;
      try { t = JSON.parse(line); } catch { continue; }
      // Skip live streams and premieres - they cannot be streamed as fixed audio tracks
      if (t.is_live || t.live_status === 'is_live' || t.live_status === 'is_upcoming') continue;
      const thumbs = t.thumbnails || [];
      const best = thumbs.reduce((a, b) => ((b.width || 0) > (a?.width || 0) ? b : a), null);
      tracks.push({
        id: `yt:${t.id}`,
        title: t.title,
        artist: t.channel || 'YouTube',
        artwork: best?.url || '',
        duration: t.duration || 0,
        source: 'youtube'
      });
      if (tracks.length >= 20) break;
    }
    return tracks;
  } catch (e) {
    console.error('Search error:', e);
    // Surface the failure to the renderer instead of returning an empty list,
    // so a broken yt-dlp doesn't look like "no results"
    throw new Error('Search failed: ' + (e.message || e));
  }
});

// Folder picker
handle('pick-folder', async () => {
  const opts = { properties: ['openDirectory'] };
  const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled) return null;
  const selectedPath = path.resolve(res.filePaths[0]);
  allowedLibraryRoots.add(selectedPath);
  return selectedPath;
});

// Directory scanning
const SKIP_DIRS = new Set([
  'System Volume Information', '$RECYCLE.BIN', 'Recovery', 'Boot', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
  'AppData', 'Local Settings', 'Application Data', 'node_modules', '.git', '.vs', 'bin', 'obj', 'dist', 'build', 'out',
]);
const SKIP_PREFIXES = ['.', '$', 'Microsoft.', 'Windows.'];
// Skip Windows Store app package paths (virtual folders like Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic)
const SKIP_CONTAINS = ['!Microsoft.', '!Windows.', 'Microsoft.ZuneMusic', 'Microsoft.Windows.Photos', 'Microsoft.WindowsCamera'];
const allowedLibraryRoots = new Set();
const allowedLocalFiles = new Set();

function shouldSkipDir(name) {
  if (name.length > 50) return true;
  if (SKIP_DIRS.has(name)) return true;
  for (const prefix of SKIP_PREFIXES) { if (name.startsWith(prefix)) return true; }
  for (const substr of SKIP_CONTAINS) { if (name.includes(substr)) return true; }
  return false;
}

const AUDIO_RE = /\.(mp3|flac|ogg|m4a|wav|aac|mp4)$/i;

async function saveCover(picture, sourceFile, coversDir) {
  try {
    if (!picture?.[0]?.data) return '';
    const extMap = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'image/bmp': '.bmp', 'image/tiff': '.tif'
    };
    const ext = extMap[picture[0].format] || '.jpg';
    const name = crypto.createHash('sha1').update(sourceFile).digest('hex') + ext;
    const dest = path.join(coversDir, name);
    if (!fs.existsSync(dest)) await fs.promises.writeFile(dest, Buffer.from(picture[0].data));
    return `cover://covers/${name}`;
  } catch { return ''; }
}

async function processAudioFile(full, filename, parseFileFn, coversDir) {
  let meta = null;
  if (parseFileFn) {
    try {
      const metadata = await parseFileFn(full, { native: true, duration: true });
      meta = {
        title: metadata.common.title,
        artist: metadata.common.artist || 'Unknown',
        album: metadata.common.album || 'Unknown',
        picture: metadata.common.picture,
        duration: metadata.format.duration || 0
      };
    } catch (e) {
      console.warn('Parse fail (using filename):', full, e.message);
    }
  }
  if (!meta) {
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
    const parts = nameWithoutExt.split(' - ');
    meta = {
      title: null,
      artist: parts.length > 1 ? parts[0] : 'Unknown',
      album: 'Unknown',
      picture: null,
      duration: 0
    };
    if (parts.length > 1) meta.title = parts.slice(1).join(' - ');
  }

  const artwork = await saveCover(meta.picture, full, coversDir);
  allowedLocalFiles.add(path.resolve(full));
  return {
    id: `local:${full}`,
    filepath: full,
    title: meta.title || filename.replace(/\.[^.]+$/, ''),
    artist: meta.artist,
    album: meta.album,
    artwork,
    duration: meta.duration || 0,
    source: 'local'
  };
}

handle('scan-folder', async (_, folderPath) => {
  if (typeof folderPath !== 'string' || folderPath.length > 4096) throw new TypeError('Invalid folder path');
  console.log('=== SCAN START ===');
  console.log('Folder:', folderPath);

  if (!folderPath) {
    console.log('No folder path provided');
    return [];
  }

  // Only folders previously picked via the native dialog may be scanned.
  const root = path.resolve(folderPath);
  if (!allowedLibraryRoots.has(root)) {
    console.warn('Scan rejected - folder was not picked via dialog:', root);
    return { error: 'Эта папка не была выбрана через диалог выбора. Используйте кнопку Import & Scan Folder.', tracks: [] };
  }

  // Check for Windows Store app virtual paths
  if (root.includes('!Microsoft.') || root.includes('!Windows.')) {
    console.log('Windows Store app folder detected - skipping');
    return { error: 'Это папка приложения Windows Store. Пожалуйста, выберите обычную папку с музыкальными файлами (например, C:\\Users\\You\\Music).', tracks: [] };
  }

  // music-metadata is ESM; dynamic import works from Electron's CommonJS main process.
  let parseFileFn = null;
  try {
    ({ parseFile: parseFileFn } = await import('music-metadata'));
  } catch (e) {
    console.error('Failed to init music-metadata:', e.message);
  }

  const coversDir = path.join(app.getPath('userData'), 'covers');
  fs.mkdirSync(coversDir, { recursive: true });

  const tracks = [];
  const stack = [{ path: root, depth: 0 }];
  let processed = 0;
  const send = (msg) => mainWindow?.webContents.send('scan-progress', msg);
  const MAX_DEPTH = 10;

  while (stack.length > 0) {
    const { path: dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      console.warn('Read dir fail:', dir, e.message);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) {
          try {
            const stats = await fs.promises.lstat(full);
            if (!stats.isSymbolicLink()) stack.push({ path: full, depth: depth + 1 });
          } catch {}
        }
        continue;
      }
      if (!AUDIO_RE.test(entry.name)) continue;

      const track = await processAudioFile(full, entry.name, parseFileFn, coversDir);
      if (track) tracks.push(track);
      processed++;
      if (processed % 10 === 0) send(`Found: ${tracks.length} tracks...`);
      // Yield to the event loop so IPC/UI stay responsive
      if (processed % 50 === 0) await new Promise(r => setImmediate(r));
    }
  }
  send('done');

  // Persist library (folders + track metadata without heavy payloads)
  try {
    const data = loadData();
    data.library = data.library || { folders: [], tracks: [] };
    if (!data.library.folders.includes(root)) data.library.folders.push(root);
    const byPath = new Map((data.library.tracks || []).map(t => [t.filepath, t]));
    tracks.forEach(t => byPath.set(t.filepath, t));
    data.library.tracks = [...byPath.values()];
    saveData(data);
  } catch (e) { console.error('Library persist error:', e.message); }

  console.log('=== SCAN COMPLETE: ' + tracks.length + ' tracks ===');
  return tracks;
});

const audioProxy = createAudioProxy({ allowedLocalFiles, ytDlp });
if (gotTheLock) audioProxy.start();

const { loadData, saveData } = createDataStore(path.join(app.getPath('userData'), 'mintpy-data.json'));

// Stream info for the renderer (proxy base + session token)
handle('get-stream-info', () => audioProxy.getStreamInfo());

// ========== Custom Pets ==========
const PETS_DIR = path.join(app.getPath('userData'), 'pets');
const PET_EXT_RE = /\.(png|gif|jpe?g|webp)$/i;

handle('pick-pet-image', async () => {
  const opts = {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'gif', 'jpg', 'jpeg', 'webp'] }]
  };
  const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  const src = res.filePaths[0];
  if (!PET_EXT_RE.test(src) || fs.statSync(src).size > 8 * 1024 * 1024) return null;
  fs.mkdirSync(PETS_DIR, { recursive: true });
  const dest = path.join(PETS_DIR, 'pet_' + Date.now() + path.extname(src).toLowerCase());
  fs.copyFileSync(src, dest);
  return path.basename(dest);
});

handle('get-custom-pets', () => {
  try {
    return fs.readdirSync(PETS_DIR).filter(validPetFile).map(f => ({
      id: 'custom:' + f,
      name: f.replace(/^pet_\d+/, 'Pet').replace(PET_EXT_RE, ''),
      file: f
    }));
  } catch { return []; }
});

handle('delete-custom-pet', (_, file) => {
  if (!validPetFile(file)) return false;
  try { fs.unlinkSync(path.join(PETS_DIR, file)); return true; } catch { return false; }
});

handle('get-pet-data-url', (_, file) => {
  if (!validPetFile(file)) return '';
  try {
    const p = path.join(PETS_DIR, file);
    if (fs.statSync(p).size > 8 * 1024 * 1024) return '';
    const ext = path.extname(file).toLowerCase();
    const mime = { '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch { return ''; }
});

// Persisted local library
handle('get-library', () => {
  const d = loadData();
  return { folders: [...d.library.folders], tracks: [...d.library.tracks] };
});

handle('get-missing-library-tracks', () => loadData().library.tracks.filter(track => track?.source === 'local' && track.filepath && !fs.existsSync(track.filepath)).map(track => ({ id: track.id, filepath: track.filepath, title: track.title })));

handle('remove-missing-library-tracks', (_, paths) => {
  if (!Array.isArray(paths) || paths.length > 10000 || paths.some(value => typeof value !== 'string' || value.length > 4096)) throw new TypeError('Invalid missing-track paths');
  const data = loadData();
  const missing = new Set(paths.map(value => path.resolve(value)).filter(file => !fs.existsSync(file) && data.library.tracks.some(track => track?.filepath && path.resolve(track.filepath) === file)));
  const removedIds = new Set(data.library.tracks.filter(track => track?.filepath && missing.has(path.resolve(track.filepath))).map(track => track.id));
  data.library.tracks = data.library.tracks.filter(track => !removedIds.has(track?.id));
  data.favorites = data.favorites.filter(track => !removedIds.has(track?.id));
  data.playlists.forEach(playlist => { playlist.tracks = playlist.tracks.filter(track => !removedIds.has(track?.id)); });
  const oldCurrent = data.playback.queue[data.playback.currentIndex];
  data.playback.queue = data.playback.queue.filter(track => !removedIds.has(track?.id));
  data.playback.currentIndex = oldCurrent && !removedIds.has(oldCurrent.id) ? data.playback.queue.findIndex(track => track.id === oldCurrent.id) : Math.min(data.playback.currentIndex, data.playback.queue.length - 1);
  if (!data.playback.queue.length) data.playback.currentIndex = -1;
  missing.forEach(file => allowedLocalFiles.delete(file));
  saveData(data);
  return { removed: removedIds.size, tracks: [...data.library.tracks] };
});

// Favorites
handle('get-favorites', () => [...loadData().favorites]);

handle('add-favorite', (_, track) => {
  track = validateTrack(track, allowedLocalFiles);
  const data = loadData();
  if (!data.favorites.some(t => t.id === track.id)) {
    data.favorites.unshift(track);
    saveData(data);
  }
  return [...data.favorites];
});

handle('remove-favorite', (_, trackId) => {
  trackId = validateTrackId(trackId);
  const data = loadData();
  data.favorites = data.favorites.filter(t => t.id !== trackId);
  saveData(data);
  return [...data.favorites];
});

// Playlists
handle('get-playlists', () => {
  return loadData().playlists.map(p => ({ id: p.id, name: p.name, trackCount: p.tracks.length }));
});

handle('create-playlist', (_, name) => {
  name = validatePlaylistName(name);
  const data = loadData();
  const pl = { id: 'pl_' + Date.now(), name, tracks: [] };
  data.playlists.push(pl);
  saveData(data);
  return { id: pl.id, name: pl.name, trackCount: 0 };
});

handle('delete-playlist', (_, playlistId) => {
  playlistId = validatePlaylistId(playlistId);
  const data = loadData();
  data.playlists = data.playlists.filter(p => p.id !== playlistId);
  saveData(data);
  return true;
});

handle('rename-playlist', (_, playlistId, newName) => {
  playlistId = validatePlaylistId(playlistId);
  newName = validatePlaylistName(newName);
  const data = loadData();
  const pl = data.playlists.find(p => p.id === playlistId);
  if (!pl) return false;
  pl.name = newName;
  saveData(data);
  return true;
});

handle('get-playlist-tracks', (_, playlistId) => {
  playlistId = validatePlaylistId(playlistId);
  const data = loadData();
  const pl = data.playlists.find(p => p.id === playlistId);
  return pl ? [...pl.tracks] : [];
});

handle('add-to-playlist', (_, playlistId, track) => {
  playlistId = validatePlaylistId(playlistId);
  track = validateTrack(track, allowedLocalFiles);
  const data = loadData();
  const pl = data.playlists.find(p => p.id === playlistId);
  if (pl && !pl.tracks.some(t => t.id === track.id)) {
    pl.tracks.push(track);
    saveData(data);
  }
  return pl ? [...pl.tracks] : [];
});

handle('remove-from-playlist', (_, playlistId, trackId) => {
  playlistId = validatePlaylistId(playlistId);
  trackId = validateTrackId(trackId);
  const data = loadData();
  const pl = data.playlists.find(p => p.id === playlistId);
  if (pl) {
    pl.tracks = pl.tracks.filter(t => t.id !== trackId);
    saveData(data);
  }
  return pl ? [...pl.tracks] : [];
});

handle('import-playlist-from-url', async (_, url) => {
  if (typeof url !== 'string' || !url.trim()) throw new Error('Missing URL');
  const result = await importFromUrl(url.trim(), ytDlp);
  if (!result || !result.tracks || result.tracks.length === 0) {
    throw new Error('No tracks found in the provided playlist/album');
  }
  const data = loadData();
  const pl = {
    id: 'pl_' + Date.now(),
    name: result.name || 'Imported Playlist',
    tracks: result.tracks
  };
  data.playlists.push(pl);
  saveData(data);
  return { id: pl.id, name: pl.name, trackCount: pl.tracks.length };
});

handle('resolve-search-track', async (_, track) => {
  if (!track || !track.id || !String(track.id).startsWith('yt:ytsearch:')) return null;
  let rawQuery = String(track.id).replace(/^yt:ytsearch:/, '');
  try { rawQuery = decodeURIComponent(rawQuery); } catch {}
  const artist = track.artist || '';
  const title = track.title || rawQuery;
  const duration = Number(track.duration) || 0;
  try {
    const best = await findBestYouTubeTrack(ytDlp, artist, title, duration);
    if (best && best.id) {
      return {
        id: 'yt:' + best.id,
        title: track.title,
        artist: track.artist,
        duration: best.duration || track.duration,
        artwork: best.artwork || track.artwork || ''
      };
    }
  } catch (e) {
    console.warn('resolve-search-track failed:', e.message);
  }
  return null;
});

// Settings
handle('get-playback-state', () => {
  const playback = loadData().playback;
  const currentId = playback.queue[playback.currentIndex]?.id;
  const queue = playback.queue.filter(track => track.source !== 'local' || (typeof track.filepath === 'string' && allowedLocalFiles.has(path.resolve(track.filepath))));
  const currentIndex = currentId ? queue.findIndex(track => track.id === currentId) : -1;
  return { queue, currentIndex };
});
handle('save-playback-state', (_, state) => {
  if (!state || typeof state !== 'object' || !Array.isArray(state.queue) || state.queue.length > 1000) throw new TypeError('Invalid playback state');
  const queue = state.queue.map(track => validateTrack(track, allowedLocalFiles));
  const currentIndex = Number.isInteger(state.currentIndex) && state.currentIndex >= -1 && state.currentIndex < queue.length ? state.currentIndex : -1;
  const data = loadData();
  data.playback = { queue, currentIndex };
  saveData(data);
  return true;
});

handle('get-history', () => [...loadData().history]);
handle('record-history', (_, track) => {
  track = validateTrack(track, allowedLocalFiles);
  const data = loadData();
  const old = data.history.find(item => item.id === track.id);
  data.history = [{ ...track, playedAt: Date.now(), playCount: (old?.playCount || 0) + 1 }, ...data.history.filter(item => item.id !== track.id)].slice(0, 500);
  saveData(data);
  return true;
});
handle('clear-history', () => { const data = loadData(); data.history = []; saveData(data); return true; });
handle('remove-history-track', (_, id) => {
  if (typeof id !== 'string' || !id || id.length > 300) throw new TypeError('Invalid track id');
  const data = loadData();
  data.history = data.history.filter(item => item.id !== id);
  saveData(data);
  return true;
});

handle('export-backup', async () => {
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: 'MintPy-backup-' + new Date().toISOString().slice(0, 10) + '.json', filters: [{ name: 'MintPy backup', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  const data = loadData();
  const activePet = typeof data.settings.pet === 'string' && data.settings.pet.startsWith('custom:') ? data.settings.pet.slice(7) : '';
  const customPets = [];
  let petBytes = 0;
  let petFiles = [];
  try { petFiles = fs.readdirSync(PETS_DIR).filter(validPetFile); } catch {}
  petFiles.sort((a, b) => Number(b === activePet) - Number(a === activePet));
  for (const file of petFiles) {
    try {
      const stat = fs.statSync(path.join(PETS_DIR, file));
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || petBytes + stat.size > 48 * 1024 * 1024) continue;
      customPets.push({ file, data: fs.readFileSync(path.join(PETS_DIR, file)).toString('base64') });
      petBytes += stat.size;
    } catch {}
  }
  const payload = { format: 'mintpy-backup', version: 1, exportedAt: new Date().toISOString(), data, customPets };
  const tempPath = result.filePath + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempPath, result.filePath);
  return { canceled: false };
});

handle('import-backup', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'MintPy backup', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  if (fs.statSync(filePath).size > 64 * 1024 * 1024) throw new Error('Backup file is larger than 64 MB');
  const backup = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!backup || backup.format !== 'mintpy-backup' || backup.version !== 1 || !backup.data) throw new Error('Unsupported MintPy backup');
  const imported = normalizeData(backup.data);
  const petPlans = [];
  const petMap = new Map();
  let petBytes = 0;
  for (const asset of (Array.isArray(backup.customPets) ? backup.customPets.slice(0, 1000) : [])) {
    if (!asset || !validPetFile(asset.file) || typeof asset.data !== 'string' || asset.data.length > 11200000 || /[^A-Za-z0-9+/=]/.test(asset.data)) continue;
    const bytes = Buffer.from(asset.data, 'base64');
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || petBytes + bytes.length > 48 * 1024 * 1024 || petMap.has(asset.file)) continue;
    const file = 'pet_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + path.extname(asset.file).toLowerCase();
    petPlans.push({ file, bytes });
    petMap.set(asset.file, file);
    petBytes += bytes.length;
  }
  if (typeof imported.settings.pet === 'string' && imported.settings.pet.startsWith('custom:')) {
    const oldName = imported.settings.pet.slice(7);
    if (petMap.has(oldName)) imported.settings.pet = 'custom:' + petMap.get(oldName);
    else if (!fs.existsSync(path.join(PETS_DIR, oldName))) imported.settings.pet = '';
  }
  const cleanTracks = items => (Array.isArray(items) ? items : []).flatMap(track => {
    try { const clean = validateTrack(track, backupAllowedFiles); if (track.playedAt != null && Number.isFinite(track.playedAt)) clean.playedAt = track.playedAt; if (track.playCount != null && Number.isInteger(track.playCount)) clean.playCount = track.playCount; return [clean]; } catch { return []; }
  });
  const countLocal = items => (Array.isArray(items) ? items : []).filter(track => track?.source === 'local').length;
  const allImportedTracks = [...imported.favorites, ...imported.history, ...imported.playback.queue, ...imported.library.tracks, ...imported.playlists.flatMap(playlist => playlist.tracks)];
  const localCount = countLocal(allImportedTracks);
  const backupAllowedFiles = new Set(allowedLocalFiles);
  for (const track of allImportedTracks) {
    if (track?.source !== 'local' || typeof track.filepath !== 'string' || !AUDIO_RE.test(track.filepath)) continue;
    try {
      const file = path.resolve(track.filepath);
      const root = [...allowedLibraryRoots].find(folder => {
        const relative = path.relative(folder, file);
        return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
      });
      if (!root || !fs.statSync(file).isFile()) continue;
      const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
      if (relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) backupAllowedFiles.add(file);
    } catch {}
  }
  const oldCurrentId = imported.playback.queue[imported.playback.currentIndex]?.id;
  imported.favorites = cleanTracks(imported.favorites);
  imported.history = cleanTracks(imported.history);
  imported.library.tracks = cleanTracks(imported.library.tracks);
  imported.playlists = imported.playlists.map(playlist => ({ ...playlist, tracks: cleanTracks(playlist.tracks) }));
  imported.playback.queue = cleanTracks(imported.playback.queue);
  imported.playback.currentIndex = oldCurrentId ? imported.playback.queue.findIndex(track => track.id === oldCurrentId) : -1;
  imported.library.folders = imported.library.folders.filter(folder => { try { return allowedLibraryRoots.has(path.resolve(folder)); } catch { return false; } });
  const keptLocal = [...imported.favorites, ...imported.history, ...imported.playback.queue, ...imported.library.tracks, ...imported.playlists.flatMap(playlist => playlist.tracks)].filter(track => track.source === 'local').length;
  const createdPetFiles = [];
  try {
    if (petPlans.length) fs.mkdirSync(PETS_DIR, { recursive: true });
    for (const pet of petPlans) {
      fs.writeFileSync(path.join(PETS_DIR, pet.file), pet.bytes, { flag: 'wx' });
      createdPetFiles.push(pet.file);
    }
    saveData({ ...imported, schemaVersion: 2 });
  } catch (error) {
    createdPetFiles.forEach(file => { try { fs.unlinkSync(path.join(PETS_DIR, file)); } catch {} });
    throw error;
  }
  backupAllowedFiles.forEach(file => allowedLocalFiles.add(file));
  return { canceled: false, skippedLocalTracks: Math.max(0, localCount - keptLocal), libraryFolders: imported.library.folders.length };
});

handle('get-settings', () => ({ ...loadData().settings }));
handle('save-settings', (_, settings) => {
  const validated = validateSettings(settings);
  const data = loadData();
  data.settings = validated;
  saveData(data);
  try {
    discordRpc.init(validated.discordRpcEnabled !== false);
  } catch {}
  return true;
});

handle('setup:complete', async (_, options = {}) => {
  const data = loadData();
  const currentSettings = data.settings || {};
  const updated = {
    ...currentSettings,
    setupCompleted: true
  };
  if (options.style && typeof options.style === 'string') {
    updated.style = options.style;
  }
  if (options.theme && ['system', 'light', 'dark'].includes(options.theme)) {
    updated.appearance = options.theme;
  }
  data.settings = validateSettings(updated);
  saveData(data);

  if (options.createShortcut) {
    try {
      const desktopDir = app.getPath('desktop');
      const targetExe = process.execPath;
      const shortcutPath = path.join(desktopDir, 'MintPy.lnk');
      shell.writeShortcutLink(shortcutPath, {
        target: targetExe,
        description: 'MintPy Zen Audio Player',
        icon: targetExe,
        iconIndex: 0
      });
    } catch (err) {
      console.warn('Could not create desktop shortcut:', err.message);
    }
  }

  return { ok: true, settings: data.settings };
});

handle('setup:set-window-mode', async (_, mode) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  try {
    mainWindow.center();
  } catch {}
  return { ok: true, mode };
});

// ========== Drag & Drop Audio Import ==========
handle('audio:import-dropped-files', async (_, rawPaths) => {
  if (!Array.isArray(rawPaths)) return [];
  const tracks = [];
  let parseFileFn = null;
  try {
    ({ parseFile: parseFileFn } = await import('music-metadata'));
  } catch (e) {
    console.error('Failed to init music-metadata:', e.message);
  }
  const coversDir = path.join(app.getPath('userData'), 'covers');
  fs.mkdirSync(coversDir, { recursive: true });

  for (const raw of rawPaths) {
    if (typeof raw !== 'string' || !raw) continue;
    let full;
    try {
      full = path.resolve(raw);
      if (!fs.existsSync(full)) continue;
    } catch {
      continue;
    }

    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      allowedLibraryRoots.add(full);
      const stack = [full];
      while (stack.length > 0) {
        const dir = stack.pop();
        let entries = [];
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch { continue; }
        for (const entry of entries) {
          const entryFull = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!shouldSkipDir(entry.name)) stack.push(entryFull);
          } else if (AUDIO_RE.test(entry.name)) {
            const track = await processAudioFile(entryFull, entry.name, parseFileFn, coversDir);
            if (track) tracks.push(track);
          }
        }
      }
    } else if (AUDIO_RE.test(full)) {
      allowedLibraryRoots.add(path.dirname(full));
      const track = await processAudioFile(full, path.basename(full), parseFileFn, coversDir);
      if (track) tracks.push(track);
    }
  }

  if (tracks.length > 0) {
    try {
      const data = loadData();
      data.library = data.library || { folders: [], tracks: [] };
      const byPath = new Map((data.library.tracks || []).map(t => [t.filepath, t]));
      tracks.forEach(t => byPath.set(t.filepath, t));
      data.library.tracks = [...byPath.values()];
      saveData(data);
    } catch (e) {
      console.error('Failed to save dropped tracks to library:', e);
    }
  }

  return tracks;
});

// ========== Mini-Player Mode ==========
let normalBounds = null;
let isMiniMode = false;

handle('window:set-mini-mode', (_, enableMini) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  enableMini = Boolean(enableMini);
  if (enableMini === isMiniMode) return isMiniMode;

  if (enableMini) {
    normalBounds = mainWindow.getBounds();
    isMiniMode = true;
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setMinimumSize(320, 140);
    const primaryDisplay = screen.getDisplayMatching(normalBounds);
    const workArea = primaryDisplay.workArea;
    const miniWidth = 360;
    const miniHeight = 150;
    const x = Math.min(normalBounds.x, workArea.x + workArea.width - miniWidth - 24);
    const y = Math.min(normalBounds.y, workArea.y + workArea.height - miniHeight - 24);
    mainWindow.setBounds({ x, y, width: miniWidth, height: miniHeight });
    mainWindow.webContents.send('window:mini-mode-changed', true);
  } else {
    isMiniMode = false;
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setMinimumSize(980, 680);
    if (normalBounds) {
      mainWindow.setBounds(normalBounds);
    } else {
      mainWindow.setSize(1360, 860);
      mainWindow.center();
    }
    mainWindow.webContents.send('window:mini-mode-changed', false);
  }
  return isMiniMode;
});

handle('window:get-mini-mode', () => isMiniMode);

// ========== Discord Rich Presence ==========
handle('discord:set-activity', (_, activity) => {
  if (activity && typeof activity === 'object') {
    discordRpc.setActivity(activity);
  }
  return true;
});

handle('discord:set-enabled', (_, enabled) => {
  discordRpc.init(Boolean(enabled));
  return true;
});

function hydrateAllowedFiles() {
  const data = loadData();
  const roots = data.library.folders.map(folder => {
    try { const root = path.resolve(folder); allowedLibraryRoots.add(root); return root; } catch { return null; }
  }).filter(Boolean);
  const savedTracks = [
    ...data.favorites, ...data.history, ...(data.playback?.queue || []),
    ...data.playlists.flatMap(playlist => playlist.tracks || []), ...data.library.tracks
  ];
  savedTracks.forEach(track => {
    if (track?.source !== 'local' || !track.filepath || !AUDIO_RE.test(track.filepath)) return;
    try {
      const file = path.resolve(track.filepath);
      const insideRoot = roots.some(root => { const relative = path.relative(root, file); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); });
      if (!insideRoot || !fs.statSync(file).isFile()) return;
      const realFile = fs.realpathSync(file);
      const realInsideRoot = roots.some(root => { try { const relative = path.relative(fs.realpathSync(root), realFile); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); } catch { return false; } });
      if (realInsideRoot) allowedLocalFiles.add(file);
    } catch {}
  });
}
hydrateAllowedFiles();
