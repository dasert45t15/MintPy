const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

let mainWindow;

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
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('unresponsive', () => console.error('Window unresponsive'));
  mainWindow.webContents.on('crashed', () => console.error('Renderer crashed'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);

ipcMain.on('win-control', (_, action) => {
  if (!mainWindow) return;
  if (action === 'close') mainWindow.close();
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});

ipcMain.on('set-window-opacity', (_, value) => {
  if (mainWindow) mainWindow.setOpacity(value);
});

// Search tracks - use yt-dlp for reliable YouTube search
const { spawn } = require('child_process');

function getYtDlpPath() {
  const bundled = path.join(__dirname, 'bin', 'yt-dlp.exe');
  if (fs.existsSync(bundled)) return bundled;
  const resources = process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'yt-dlp.exe') : '';
  if (resources && fs.existsSync(resources)) return resources;
  return 'yt-dlp';
}

// Verify yt-dlp is available at startup
let ytDlpOk = false;
const ytDlpBin = getYtDlpPath();
try {
  const out = require('child_process').execSync(`"${ytDlpBin}" --version`, { stdio: 'pipe', timeout: 5000 });
  console.log('yt-dlp version:', out.toString().trim());
  ytDlpOk = true;
} catch (e) {
  console.error('WARNING: yt-dlp not found at:', ytDlpBin, e.message);
}

ipcMain.handle('yt-dlp-status', () => ytDlpOk);

function ytDlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(getYtDlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('yt-dlp timed out')); }, timeoutMs || 30000);
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

ipcMain.handle('search-tracks', async (_, query) => {
  try {
    const json = await ytDlp(['--flat-playlist', '--dump-json', `ytsearch20:${query}`]);
    const lines = json.split('\n').filter(Boolean);
    return lines.map(line => {
      const t = JSON.parse(line);
      return {
        id: `yt:${t.id}`,
        title: t.title,
        artist: t.channel || 'YouTube',
        artwork: t.thumbnails?.[0]?.url || '',
        duration: t.duration || 0,
        searchQuery: `${t.title} ${t.channel || ''}`
      };
    });
  } catch (e) { console.error('Search error:', e); return []; }
});

// Folder picker
ipcMain.handle('pick-folder', async () => {
  console.log('Opening folder picker...');
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  console.log('Folder selected:', res.canceled ? 'canceled' : res.filePaths[0]);
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

ipcMain.handle('scan-folder', async (_, folderPath) => {
  console.log('=== SCAN START ===');
  console.log('Folder:', folderPath);
  
  if (!folderPath) {
    console.log('No folder path provided');
    return [];
  }
  
  // Check for Windows Store app virtual paths
  if (folderPath.includes('!Microsoft.') || folderPath.includes('!Windows.')) {
    console.log('Windows Store app folder detected - skipping');
    return { error: 'Это папка приложения Windows Store. Пожалуйста, выберите обычную папку с музыкальными файлами (например, C:\\Users\\You\\Music).', tracks: [] };
  }
  
  // music-metadata is ESM; dynamic import works from Electron's CommonJS main process.
  let parseFileFn;
  try {
    const { parseFile } = await import('music-metadata');
    parseFileFn = parseFile;
  } catch (e) {
    console.error('Failed to init music-metadata:', e.message);
    parseFileFn = null;
  }
  
  const tracks = [];
  const stack = [{ path: folderPath, depth: 0 }];
  let processed = 0;
  const send = (msg) => mainWindow?.webContents.send('scan-progress', msg);
  const MAX_DEPTH = 10;

  while (stack.length > 0) {
    const { path: dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!shouldSkipDir(entry.name)) {
            try {
              const stats = fs.lstatSync(full);
              if (!stats.isSymbolicLink()) stack.push({ path: full, depth: depth + 1 });
            } catch {}
          }
        } else if (/\.(mp3|flac|ogg|m4a|wav)$/i.test(entry.name)) {
          let trackData = null;
          try {
            // music-metadata v10 requires async import in CJS
            const metadata = await parseFileFn(full, { native: true, duration: true });
            const { common, format } = metadata;
            trackData = {
              id: `local:${full}`, filepath: full,
              title: common.title || entry.name.replace(/\.[^.]+$/, ''), artist: common.artist || 'Unknown',
              album: common.album || 'Unknown',
              artwork: common.picture?.[0] ? `data:${common.picture[0].format};base64,${common.picture[0].data.toString('base64')}` : '',
              duration: format.duration || 0, source: 'local'
            };
          } catch (e) { 
            console.warn('Parse fail (using filename):', full, e.message);
            // Fallback: use filename as title
            const nameWithoutExt = entry.name.replace(/\.[^.]+$/, '');
            const parts = nameWithoutExt.split(' - ');
            trackData = {
              id: `local:${full}`, filepath: full,
              title: parts.length > 1 ? parts.slice(1).join(' - ') : nameWithoutExt,
              artist: parts.length > 1 ? parts[0] : 'Unknown',
              album: 'Unknown',
              artwork: '',
              duration: 0, source: 'local'
            };
          }
          if (trackData) {
            tracks.push(trackData);
            allowedLocalFiles.add(path.resolve(full));
          }
          processed++;
          if (processed % 10 === 0) send(`Found: ${tracks.length} tracks...`);
        }
      }
    } catch (e) { console.warn('Read dir fail:', dir, e.message); }
  }
  send('done');
  console.log('=== SCAN COMPLETE: ' + tracks.length + ' tracks ===');
  return tracks;
});

// Create local HTTP proxy server to stream audio (bypasses CORS)
const ytUrlCache = new Map();
async function resolveYtUrl(query) {
  const cached = ytUrlCache.get(query);
  if (cached && Date.now() - cached.time < 3600000) return cached.url;
  const out = await ytDlp(['-g', '-f', 'bestaudio[ext=m4a]/bestaudio', `ytsearch:${query}`], 30000);
  const url = out.split('\n')[0];
  if (url) ytUrlCache.set(query, { url, time: Date.now() });
  return url;
}

const proxyServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  
  // Route: /local?path=<filepath> - serve local files
  if (url.pathname === '/local') {
    const filePath = url.searchParams.get('path');
    if (!filePath) { res.writeHead(400); res.end('Missing path'); return; }
    const resolvedFile = path.resolve(filePath);
    const isAllowed = allowedLocalFiles.has(resolvedFile) || [...allowedLibraryRoots].some(root => resolvedFile === root || resolvedFile.startsWith(root + path.sep));
    if (!isAllowed) { res.writeHead(403); res.end('Path is outside the selected library'); return; }
    console.log('Serving local file:', resolvedFile);
    try {
      const stat = fs.statSync(resolvedFile);
      const total = stat.size;
      const ext = path.extname(filePath).toLowerCase();
      const mime = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' };
      const contentType = mime[ext] || 'audio/mpeg';
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
        if (start >= total || start > end) { res.writeHead(416); res.end(); return; }
        res.writeHead(206, {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(resolvedFile, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': total,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(resolvedFile).pipe(res);
      }
    } catch (e) { console.error('Local proxy error:', e.message); res.writeHead(404); res.end('File not found'); }
    return;
  }
  
  // Route: /youtube?q=<search-query> - stream from YouTube via direct URL proxy (supports seeking)
  if (url.pathname === '/youtube') {
    const query = url.searchParams.get('q');
    if (!query) { res.writeHead(400); res.end('Missing query'); return; }
    console.log('YouTube stream for:', query);
    try {
      const directUrl = await resolveYtUrl(query);
      if (!directUrl) { res.writeHead(502); res.end('No URL resolved'); return; }
      const isHttps = directUrl.startsWith('https');
      const proxyMod = isHttps ? https : http;
      const dst = new URL(directUrl);
      const proxyReq = proxyMod.request({
        hostname: dst.hostname,
        port: dst.port,
        path: dst.pathname + dst.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Range': req.headers.range || '',
        }
      }, proxyRes => {
        res.writeHead(proxyRes.statusCode || 200, {
          ...proxyRes.headers,
          'Access-Control-Allow-Origin': '*',
        });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', e => {
        console.error('YouTube proxy error:', e.message);
        ytUrlCache.delete(query);
        if (!res.headersSent) { res.writeHead(502); res.end('Stream error'); } else res.destroy();
      });
      proxyReq.end();
      req.on('close', () => proxyReq.destroy());
    } catch (e) {
      console.error('YouTube stream error:', e.message);
      if (!res.headersSent) { res.writeHead(502); res.end('Stream failed'); }
    }
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

proxyServer.listen(3737, '127.0.0.1', () => {
  console.log('Audio proxy server running on http://localhost:3737');
});

// ========== Favorites & Playlists Storage ==========

const DATA_FILE = path.join(app.getPath('userData'), 'mintpy-data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      d.settings = d.settings || {};
      if (d.settings.opacity == null) d.settings.opacity = 1;
      if (d.settings.auraIntensity == null) d.settings.auraIntensity = 0.35;
      if (d.settings.accentColor == null) d.settings.accentColor = 'blue-purple';
      if (d.settings.customColor == null) d.settings.customColor = '';
      if (d.settings.appearance == null) d.settings.appearance = 'system';
      if (d.settings.cornerRadius == null) d.settings.cornerRadius = 30;
      if (d.settings.compactMode == null) d.settings.compactMode = false;
      return d;
    }
  } catch (e) { console.error('Load data error:', e.message); }
  return { favorites: [], playlists: [], settings: { opacity: 1, auraIntensity: 0.35, compactMode: false, appearance: 'system', accentColor: 'blue-purple', customColor: '', cornerRadius: 30 } };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Favorites
ipcMain.handle('get-favorites', () => loadData().favorites);

ipcMain.handle('add-favorite', (_, track) => {
  const data = loadData();
  if (!data.favorites.some(t => t.id === track.id)) {
    data.favorites.unshift(track);
    saveData(data);
  }
  return data.favorites;
});

ipcMain.handle('remove-favorite', (_, trackId) => {
  const data = loadData();
  data.favorites = data.favorites.filter(t => t.id !== trackId);
  saveData(data);
  return data.favorites;
});

// Playlists
ipcMain.handle('get-playlists', () => {
  return loadData().playlists.map(p => ({ id: p.id, name: p.name, trackCount: p.tracks.length }));
});

ipcMain.handle('create-playlist', (_, name) => {
  const data = loadData();
  const pl = { id: 'pl_' + Date.now(), name, tracks: [] };
  data.playlists.push(pl);
  saveData(data);
  return { id: pl.id, name: pl.name, trackCount: 0 };
});

ipcMain.handle('delete-playlist', (_, playlistId) => {
  const data = loadData();
  data.playlists = data.playlists.filter(p => p.id !== playlistId);
  saveData(data);
  return true;
});

ipcMain.handle('get-playlist-tracks', (_, playlistId) => {
  const data = loadData();
  const pl = data.playlists.find(p => p.id === playlistId);
  return pl ? pl.tracks : [];
});

ipcMain.handle('add-to-playlist', (_, playlistId, track) => {
  const data = loadData();
  const pl = data.playlists.find(p => p.id === playlistId);
  if (pl && !pl.tracks.some(t => t.id === track.id)) {
    pl.tracks.push(track);
    saveData(data);
  }
  return pl ? pl.tracks : [];
});

ipcMain.handle('remove-from-playlist', (_, playlistId, trackId) => {
  const data = loadData();
  const pl = data.playlists.find(p => p.id === playlistId);
  if (pl) {
    pl.tracks = pl.tracks.filter(t => t.id !== trackId);
    saveData(data);
  }
  return pl ? pl.tracks : [];
});

// Settings
ipcMain.handle('get-settings', () => loadData().settings);
ipcMain.handle('save-settings', (_, settings) => {
  const data = loadData();
  data.settings = settings;
  saveData(data);
  return true;
});

function hydrateAllowedLocalFiles() {
  const data = loadData();
  const savedTracks = [...data.favorites, ...data.playlists.flatMap(playlist => playlist.tracks || [])];
  savedTracks.forEach(track => {
    if (track?.source === 'local' && track.filepath) allowedLocalFiles.add(path.resolve(track.filepath));
  });
}

hydrateAllowedLocalFiles();

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
