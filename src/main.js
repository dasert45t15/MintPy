const audio = new Audio();
let queue = [], currentIndex = -1, isPlaying = false, isShuffle = false, isRepeat = false, currentTrack = null, currentView = 'home';
let audioCtx = null, gainNode = null, volPercent = 80;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24"><use href="#ico-${name}"/></svg>`;
const contentInner = $('#contentInner'), queueList = $('#queueList');
const npArt = $('#npArt'), npTitle = $('#npTitle'), npArtist = $('#npArtist');
const playBtn = $('#playBtn'), seekFill = $('#seekFill'), seekBar = $('#seekBar');
const curTime = $('#curTime'), totTime = $('#totTime');
const volFill = $('#volFill'), volBar = $('#volBar');
const shuffleBtn = $('#shuffleBtn'), repeatBtn = $('#repeatBtn');

const previewSettings = { opacity: 1, auraIntensity: .35, compactMode: false, appearance: 'system', accentColor: 'blue-purple', customColor: '', cornerRadius: 30, keybinds: {} };
const bridge = window.api || {
  win: () => {}, searchTracks: async () => [], pickFolder: async () => null, scanFolder: async () => [], onScanProgress: () => () => {},
  getFavorites: async () => [], addFavorite: async () => [], removeFavorite: async () => [],
  getPlaylists: async () => [], createPlaylist: async () => ({}), deletePlaylist: async () => true,
  getPlaylistTracks: async () => [], addToPlaylist: async () => [], removeFromPlaylist: async () => [],
  getSettings: async () => ({ ...previewSettings }), saveSettings: async () => true, setOpacity: () => {}, checkYtDlp: async () => true,
};

audio.volume = 0.8; volPercent = 80; volFill.style.width = '80%';
setupAudio(); bindUI(); renderView('home');
loadAndApplySettings();
bridge.checkYtDlp().then(ok => { if (!ok) showError('yt-dlp not found — YouTube search & streaming disabled'); });

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
  const settings = await bridge.getSettings();
  if ((settings.appearance || 'system') === 'system') applySettings(settings);
});

let keybinds = {};
async function loadKeybinds() {
  const s = await bridge.getSettings();
  keybinds = Object.assign({}, defaultKeys, s.keybinds || {});
}
loadKeybinds();

document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const key = e.key === ' ' ? 'Space' : e.key;
  const act = Object.entries(keybinds).find(([, k]) => k === key)?.[0];
  if (!act) return;
  e.preventDefault();
  if (act === 'play-pause' && currentTrack && audio.src) togglePlay();
  if (act === 'seek-forward' && isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
  if (act === 'seek-back' && isFinite(audio.duration)) audio.currentTime = Math.max(0, audio.currentTime - 5);
  if (act === 'vol-up') { volPercent = Math.min(100, volPercent + 5); applyVol(); }
  if (act === 'vol-down') { volPercent = Math.max(0, volPercent - 5); applyVol(); }
  if (act === 'next-track') nextTrack();
  if (act === 'prev-track') prevTrack();
});

bridge.onScanProgress((msg) => {
  console.log('SCAN:', msg);
  const el = $('#localList');
  if (el) el.innerHTML = `<div class="empty">${msg}</div>`;
});

function setupAudio() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1;
    const source = audioCtx.createMediaElementSource(audio);
    source.connect(gainNode);
    gainNode.connect(audioCtx.destination);
  } catch (e) { console.warn('WebAudio init failed:', e); }
  
  audio.ontimeupdate = updateTimelineUI;
  audio.onloadedmetadata = updateTimelineUI;
  audio.ondurationchange = updateTimelineUI;
  audio.onplay = () => { isPlaying = true; updateUI(); };
  audio.onpause = () => { isPlaying = false; updateUI(); };
  audio.onended = () => isRepeat ? playCurrent() : nextTrack();
  audio.onerror = (e) => {
    console.error('Audio error:', audio.error?.message || 'unknown');
    isPlaying = false;
    updateUI();
    showError('Playback failed: ' + (audio.error?.message || 'Unknown error'));
  };
}

function showError(msg, useHtml) {
  console.error(msg);
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#c00;color:#fff;padding:12px 24px;border-radius:8px;z-index:9999;font-size:14px;max-width:80%;text-align:center;pointer-events:none;';
  if (useHtml) { el.innerHTML = msg; } else { el.textContent = msg; }
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

async function playTrack(track, index, newQueue = null) {
  if (newQueue) { queue = newQueue; currentIndex = index; } else { currentIndex = index; }

  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  currentTrack = track; isPlaying = false; updateUI();

  try {
    let streamUrl;
    if (track.source === 'local') {
      streamUrl = `http://127.0.0.1:3737/local?path=${encodeURIComponent(track.filepath)}`;
    } else {
      streamUrl = `http://127.0.0.1:3737/youtube?q=${encodeURIComponent(track.searchQuery)}`;
    }
    if (!streamUrl) throw new Error('No stream URL');
    audio.src = streamUrl;
    await audio.play();
    updateUI();
  } catch (e) {
    console.error('Play error:', e);
    if (e.name === 'AbortError') return;
    showError('Failed to play: ' + (track.title || 'unknown'));
    isPlaying = false;
    updateUI();
  }
}
function playCurrent() { audio.currentTime = 0; if (audio.src) audio.play(); }
function togglePlay() { if (!audio.src) return; isPlaying ? audio.pause() : audio.play().catch(e => showError('Playback failed: ' + e.message)); }
function nextTrack() { if (!queue.length) return; currentIndex = (currentIndex + 1) % queue.length; playTrack(queue[currentIndex], currentIndex); }
function prevTrack() { if (!queue.length) return; currentIndex = (currentIndex - 1 + queue.length) % queue.length; playTrack(queue[currentIndex], currentIndex); }
function seek(e) { if (!audio.duration || !isFinite(audio.duration)) return; const r = seekBar.getBoundingClientRect(); audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration; }

let volDragging = false, seekDragging = false;
const defaultKeys = {
  'play-pause': 'Space',
  'seek-forward': 'ArrowRight',
  'seek-back': 'ArrowLeft',
  'vol-up': 'ArrowUp',
  'vol-down': 'ArrowDown',
  'next-track': 'MediaNextTrack',
  'prev-track': 'MediaPrevTrack',
};
function calcVol(e) {
  const r = volBar.getBoundingClientRect();
  return Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
}
function applyVol() {
  const gain = volPercent / 100;
  audio.volume = gain;
  if (gainNode) gainNode.gain.value = 1;
  volFill.style.width = volPercent + '%';
}
function setVol(e) { volPercent = calcVol(e); applyVol(); }
function toggleShuffle() { isShuffle = !isShuffle; shuffleBtn.classList.toggle('active', isShuffle); if (isShuffle) shuffleQueue(); }
function toggleRepeat() { isRepeat = !isRepeat; repeatBtn.classList.toggle('active', isRepeat); }
function shuffleQueue() { const current = queue[currentIndex]; const rest = queue.filter((_, i) => i !== currentIndex); for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; } queue = [current, ...rest]; currentIndex = 0; }

function bindUI() {
  $$('.nav-btn[data-view]').forEach(b => b.onclick = () => { setActive(b); renderView(b.dataset.view); });
  playBtn.onclick = togglePlay; $('#prevBtn').onclick = prevTrack; $('#nextBtn').onclick = nextTrack;
  shuffleBtn.onclick = toggleShuffle; repeatBtn.onclick = toggleRepeat;
  seekBar.onmousedown = (e) => { if (audio.duration && isFinite(audio.duration)) { seekDragging = true; seek(e); } };
  document.onmousemove = (e) => { if (seekDragging) seek(e); if (volDragging) setVol(e); };
  document.onmouseup = () => { seekDragging = false; volDragging = false; };
  volBar.onmousedown = (e) => { volDragging = true; setVol(e); };
  $('#winMin').onclick = () => bridge.win('minimize');
  $('#winMax').onclick = () => bridge.win('maximize');
  $('#winClose').onclick = () => bridge.win('close');
}
function setActive(btn) { $$('.nav-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); }

function renderView(view) {
  currentView = view;
  if (view === 'home') return renderHome();
  if (view === 'search') return renderSearch();
  if (view === 'library') return renderLibrary();
  if (view === 'favorites') return renderFavorites();
  if (view === 'playlists') return renderPlaylists();
  if (view === 'settings') return renderSettings();
  if (view.startsWith('playlist-')) return renderPlaylistDetail(view.replace('playlist-', ''));
}

// ========== SETTINGS ==========

async function loadAndApplySettings() {
  try {
    const s = await bridge.getSettings();
    applySettings(s);
  } catch (e) { console.error('Settings load error:', e); }
}

function applySettings(s) {
  const root = document.documentElement;
  
  bridge.setOpacity(s.opacity);
  
  root.style.setProperty('--content-padding', s.compactMode ? '20px' : '32px');
  root.style.setProperty('--spacing', s.compactMode ? '10px' : '16px');
  root.style.setProperty('--window-radius', Math.max(28, Number(s.cornerRadius) || 30) + 'px');
  root.style.setProperty('--aura-opacity', s.auraIntensity);
  const appearance = s.appearance || 'system';
  root.dataset.theme = appearance === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : appearance;
  
  const accents = {
    'blue-purple': { accent: '#a5202d', secondary: '#486b45' },
    'green-teal':  { accent: '#3f6845', secondary: '#7f4c3c' },
    'orange-red':  { accent: '#b45b2a', secondary: '#556f48' },
    'pink-rose':   { accent: '#b14a62', secondary: '#63764f' },
    'cyan-lime':   { accent: '#376b72', secondary: '#657445' },
    'white-cold':  { accent: '#4f5663', secondary: '#6b6258' },
  };
  const c = s.customColor ? { accent: s.customColor, secondary: '#486b45' }
                          : (accents[s.accentColor] || accents['blue-purple']);
  
  root.style.setProperty('--red', c.accent);
  root.style.setProperty('--red-soft', c.accent + '1a');
  root.style.setProperty('--green', c.secondary);
  keybinds = Object.assign({}, defaultKeys, s.keybinds || {});
}

async function renderSettings() {
  const s = await bridge.getSettings();
  const themes = [
    { value: 'blue-purple', label: 'Crimson Hanko' },
    { value: 'green-teal', label: 'Matcha' },
    { value: 'orange-red', label: 'Autumn Maple' },
    { value: 'pink-rose', label: 'Sakura' },
    { value: 'cyan-lime', label: 'Indigo Mist' },
    { value: 'white-cold', label: 'Sumi Ink' },
  ];
  contentInner.innerHTML = `
    <h2 style="margin-bottom:24px;">${icon('settings')} Settings</h2>
    <div class="settings-group">
      <h3>Window</h3>
      <div class="setting-row">
        <label>Appearance</label>
        <select id="setAppearance">
          <option value="system" ${(s.appearance || 'system') === 'system' ? 'selected' : ''}>System</option>
          <option value="light" ${s.appearance === 'light' ? 'selected' : ''}>Light</option>
          <option value="dark" ${s.appearance === 'dark' ? 'selected' : ''}>Dark</option>
        </select>
      </div>
      <div class="setting-row">
        <label>Window Opacity</label>
        <div style="display:flex;align-items:center;gap:10px;">
          <input type="range" id="setOpacity" min="0.15" max="1" step="0.05" value="${s.opacity}">
          <span class="setting-val" id="opacityVal">${Math.round(s.opacity*100)}%</span>
        </div>
      </div>
    </div>
    <div class="settings-group">
      <h3>Colors</h3>
      <div class="setting-row">
        <label>Theme</label>
        <select id="setAccent">
          ${themes.map(t => `<option value="${t.value}" ${s.accentColor === t.value ? 'selected' : ''}>${t.label}</option>`).join('')}
        </select>
      </div>
      <div class="setting-row">
        <label>Custom Color</label>
        <input type="color" id="setCustomColor" value="${s.customColor || '#00d4ff'}" style="width:40px;height:40px;border:none;border-radius:8px;cursor:pointer;background:none;">
      </div>
    </div>
    <div class="settings-group">
      <h3>Effects</h3>
      <div class="setting-row">
        <label>Aura Glow</label>
        <select id="setAura">
          <option value="0.15" ${s.auraIntensity == 0.15 ? 'selected' : ''}>Subtle</option>
          <option value="0.35" ${s.auraIntensity == 0.35 ? 'selected' : ''}>Normal</option>
          <option value="0.55" ${s.auraIntensity == 0.55 ? 'selected' : ''}>Enhanced</option>
          <option value="0.8" ${s.auraIntensity == 0.8 ? 'selected' : ''}>Maximum</option>
          <option value="0" ${s.auraIntensity == 0 ? 'selected' : ''}>Off</option>
        </select>
      </div>
      <div class="setting-row">
        <label>Compact Mode</label>
        <div class="toggle-switch ${s.compactMode ? 'active' : ''}" id="setCompact"></div>
      </div>
    </div>
    <div class="settings-group">
      <h3>Keyboard Shortcuts</h3>
      <div id="keybindsList"></div>
      <p class="muted" style="font-size:12px;margin-top:8px;">Click a shortcut then press new key to rebind</p>
    </div>
    <p class="muted" style="font-size:12px;margin-top:32px;">Settings are saved automatically</p>`;

  const cur = { ...s };

  renderKeybinds(cur);

  $('#setAppearance').onchange = function() {
    cur.appearance = this.value;
    applySettings(cur);
    debounceSave(cur);
  };
  
  $('#setOpacity').oninput = function() {
    const val = parseFloat(this.value);
    $('#opacityVal').textContent = Math.round(val*100) + '%';
    cur.opacity = val;
    applySettings(cur);
    debounceSave(cur);
  };
  $('#setAccent').onchange = function() {
    cur.accentColor = this.value;
    cur.customColor = '';
    applySettings(cur);
    debounceSave(cur);
  };
  $('#setCustomColor').oninput = function() {
    cur.customColor = this.value;
    cur.accentColor = 'blue-purple';
    applySettings(cur);
    debounceSave(cur);
  };
  $('#setAura').onchange = function() {
    cur.auraIntensity = parseFloat(this.value);
    applySettings(cur);
    debounceSave(cur);
  };
  $('#setCompact').onclick = function() {
    cur.compactMode = !cur.compactMode;
    this.classList.toggle('active', cur.compactMode);
    applySettings(cur);
    debounceSave(cur);
  };
}

const keyLabels = {
  'play-pause': 'Play / Pause',
  'seek-forward': 'Seek Forward',
  'seek-back': 'Seek Back',
  'vol-up': 'Volume Up',
  'vol-down': 'Volume Down',
  'next-track': 'Next Track',
  'prev-track': 'Previous Track',
};

function renderKeybinds(s) {
  const merged = Object.assign({}, defaultKeys, s.keybinds || {});
  const list = $('#keybindsList');
  list.innerHTML = '';
  Object.entries(keyLabels).forEach(([id, label]) => {
    const row = document.createElement('div');
    row.className = 'setting-row';
    row.innerHTML = `<label>${label}</label><span class="keybind-btn" data-action="${id}" tabindex="0">${merged[id]}</span>`;
    row.querySelector('.keybind-btn').onclick = function() {
      this.classList.add('capturing');
      this.textContent = '...';
      const handler = e => {
        e.preventDefault(); e.stopPropagation();
        const key = e.key === ' ' ? 'Space' : e.key;
        this.textContent = key;
        this.classList.remove('capturing');
        if (!s.keybinds) s.keybinds = {};
        s.keybinds[id] = key;
        keybinds[id] = key;
        debounceSave(s);
        document.removeEventListener('keydown', handler, true);
      };
      document.addEventListener('keydown', handler, true);
    };
    list.appendChild(row);
  });
}

let _settingsTimer;
function debounceSave(s) {
  clearTimeout(_settingsTimer);
  _settingsTimer = setTimeout(() => bridge.saveSettings(s), 500);
}

// ========== HOME ==========

function renderHome() {
  if (currentTrack) {
    const artwork = safeArtwork(currentTrack.artwork) || '../assets/mintpy-logo.png';
    contentInner.innerHTML = `
      <section class="home-player" data-track-id="${escHtml(currentTrack.id)}">
        <div class="home-art-stage">
          <div class="home-vinyl ${isPlaying ? 'playing' : ''}" aria-hidden="true">
            <div class="home-vinyl-grooves"></div>
            <img class="home-vinyl-label" src="${artwork}" alt="">
            <span class="home-vinyl-hole"></span>
          </div>
          <img class="home-cover" src="${artwork}" alt="${escHtml(currentTrack.title)} artwork">
        </div>
        <div class="home-track-copy">
          <span class="home-eyebrow">NOW PLAYING · 再生中</span>
          <h2>${escHtml(currentTrack.title)}</h2>
          <p>${escHtml(currentTrack.artist)}</p>
        </div>
        <div class="home-timeline">
          <span id="homeCurTime">${fmt(audio.currentTime)}</span>
          <div class="seek-bar home-seek">
            <i></i><i></i><i></i>
            <div class="seek-fill" id="homeSeekFill"></div>
          </div>
          <span id="homeTotTime">${audio.duration && isFinite(audio.duration) ? fmt(audio.duration) : '--:--'}</span>
        </div>
      </section>`;
  } else {
    contentInner.innerHTML = `<div class="empty"><img class="home-brand-logo" src="../assets/mintpy-logo.png" alt="MintPy"><h2>MintPy</h2><p class="muted">Search for music or import a local folder</p><small class="muted">静けさの中に、音がある</small></div>`;
  }
  const homeSeek = contentInner.querySelector('.home-seek');
  if (homeSeek) homeSeek.onclick = e => {
    if (!audio.duration || !isFinite(audio.duration)) return;
    const r = homeSeek.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(audio.duration, ((e.clientX - r.left) / r.width) * audio.duration));
    updateTimelineUI();
  };
  updateTimelineUI();
}

function updateTimelineUI() {
  const duration = audio.duration;
  const hasDuration = duration && isFinite(duration);
  const percent = hasDuration ? Math.max(0, Math.min(100, (audio.currentTime / duration) * 100)) : 0;

  seekFill.style.width = percent + '%';
  curTime.textContent = fmt(audio.currentTime);
  totTime.textContent = hasDuration ? fmt(duration) : '--:--';

  const homeFill = $('#homeSeekFill');
  const homeCurrent = $('#homeCurTime');
  const homeTotal = $('#homeTotTime');
  if (homeFill) homeFill.style.width = percent + '%';
  if (homeCurrent) homeCurrent.textContent = fmt(audio.currentTime);
  if (homeTotal) homeTotal.textContent = hasDuration ? fmt(duration) : '--:--';
}

function syncHomePlayer() {
  if (currentView !== 'home') return;
  const homePlayer = contentInner.querySelector('.home-player');
  if (!currentTrack || !homePlayer || homePlayer.dataset.trackId !== String(currentTrack.id)) {
    renderHome();
    return;
  }
  homePlayer.querySelector('.home-vinyl')?.classList.toggle('playing', isPlaying);
  updateTimelineUI();
}

// ========== SEARCH ==========

function renderSearch() {
  contentInner.innerHTML = '';
  const searchBar = document.createElement('div');
  searchBar.className = 'search-bar';
  const inp = document.createElement('input');
  inp.className = 'search-input'; inp.id = 'searchInp'; inp.placeholder = 'Search tracks...'; inp.autocomplete = 'off';
  const btn = document.createElement('button');
  btn.className = 'search-btn'; btn.id = 'searchBtn'; btn.textContent = 'Search';
  searchBar.appendChild(inp); searchBar.appendChild(btn);
  const results = document.createElement('div');
  results.className = 'track-list'; results.id = 'results';
  contentInner.appendChild(searchBar); contentInner.appendChild(results);
  btn.onclick = doSearch;
  inp.onkeydown = e => { if (e.key === 'Enter') doSearch(); };
  setTimeout(() => inp.focus(), 50);
}

async function doSearch() {
  const q = $('#searchInp').value.trim(); if (!q) return;
  const res = $('#results'); res.innerHTML = '<div class="empty">Searching...</div>';
  const tracks = await bridge.searchTracks(q);
  if (!tracks.length) return res.innerHTML = '<div class="empty">Nothing found</div>';
  window._searchTracks = tracks;
  renderTrackList(res, tracks, 'search');
}
function playFromSearch(track, index, tracks) { playTrack(track, index, tracks); }

// ========== LIBRARY ==========

function renderLibrary() {
  contentInner.innerHTML = `<div class="empty" style="flex-direction: column; height: auto; padding: 20px;">
    <div class="icon">${icon('folder')}</div><h2>Local Library</h2>
    <button class="search-btn" id="scanLocalBtn" style="margin: 16px 0;">Import & Scan Folder</button>
    <div class="track-list" id="localList" style="max-height:400px; overflow:auto; width:100%;"></div>
  </div>`;
  $('#scanLocalBtn').onclick = scanLocal;
}

async function scanLocal() {
  const folder = await bridge.pickFolder();
  if (!folder) return;
  const localList = $('#localList');
  localList.innerHTML = '<div class="empty">Scanning...</div>';
  const result = await bridge.scanFolder(folder);
  if (result && result.error) return localList.innerHTML = `<div class="empty">${result.error}</div>`;
  if (!result || !result.length) return localList.innerHTML = '<div class="empty">No audio files found</div>';
  window._localTracks = result;
  renderTrackList(localList, result, 'local');
}

// ========== FAVORITES ==========

async function renderFavorites() {
  contentInner.innerHTML = '<h2 style="padding:20px;">' + icon('heart') + ' Favorites</h2><div class="track-list" id="favList"></div>';
  const favs = await bridge.getFavorites();
  const list = $('#favList');
  if (!favs.length) return list.innerHTML = '<div class="empty">No favorites yet. Click ' + icon('heart-o') + ' on any track to add.</div>';
  window._favTracks = favs;
  renderTrackList(list, favs, 'favorite');
}

// ========== PLAYLISTS ==========

async function renderPlaylists() {
  contentInner.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 20px 0;">
      <h2>${icon('playlist')} Playlists</h2>
      <button class="search-btn" id="newPlaylistBtn">+ New</button>
    </div>
    <div class="track-list" id="plList"></div>`;
  const pls = await bridge.getPlaylists();
  const list = $('#plList');
  $('#newPlaylistBtn').onclick = showCreatePlaylist;
  if (!pls.length) return list.innerHTML = '<div class="empty">No playlists yet. Create one!</div>';
  list.innerHTML = pls.map(p => `
    <div class="pl-row" data-playlist-id="${escHtml(p.id)}">
      <span class="pl-icon">${icon('playlist')}</span>
      <div class="info"><span class="ttl">${escHtml(p.name)}</span><span class="art">${p.trackCount} tracks</span></div>
    </div>`).join('');
  list.onclick = e => {
    const row = e.target.closest('.pl-row');
    if (row) renderView('playlist-' + row.dataset.playlistId);
  };
}

function showCreatePlaylist() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>New Playlist</h3>
      <input id="plNameInput" class="search-input" placeholder="Playlist name" autofocus>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="search-btn" id="plCreateBtn">Create</button>
        <button class="search-btn" id="plCancelBtn" style="background:#5b5148;border-color:#5b5148;">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  const inp = $('#plNameInput');
  inp.focus();
  $('#plCancelBtn').onclick = () => overlay.remove();
  $('#plCreateBtn').onclick = async () => {
    const name = inp.value.trim();
    if (!name) return;
    await bridge.createPlaylist(name);
    overlay.remove();
    renderPlaylists();
  };
  inp.onkeydown = e => { if (e.key === 'Enter') $('#plCreateBtn').click(); };
}

async function renderPlaylistDetail(plId) {
  contentInner.innerHTML = '<h2 style="padding:20px;">' + icon('playlist') + ' Loading...</h2><div class="track-list" id="plDetailList"></div>';
  const tracks = await bridge.getPlaylistTracks(plId);
  const allPls = await bridge.getPlaylists();
  const pl = allPls.find(p => p.id === plId);
  contentInner.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 20px 0;">
      <h2>${icon('playlist')} ${escHtml(pl ? pl.name : 'Playlist')}</h2>
      <button class="search-btn" id="deletePlaylistBtn">Delete</button>
    </div>
    <div class="track-list" id="plDetailList"></div>`;
  const list = $('#plDetailList');
  $('#deletePlaylistBtn').onclick = () => deletePlaylist(plId);
  if (!tracks.length) return list.innerHTML = '<div class="empty">Empty playlist. Add tracks from Search or Library.</div>';
  window._plTracks = tracks;
  window._plId = plId;
  renderTrackList(list, tracks, 'playlist');
}

async function deletePlaylist(plId) {
  await bridge.deletePlaylist(plId);
  renderView('playlists');
}

// ========== TRACK LIST RENDERER ==========

function renderTrackList(container, tracks, source) {
  container.innerHTML = tracks.map((t, i) => `
    <div class="track-row" data-index="${i}" data-id="${t.id}">
      <span class="num">${i+1}</span>
      <div class="info"><span class="ttl">${escHtml(t.title)}</span><span class="art">${escHtml(t.artist)}</span></div>
      <span class="dur">${fmt(t.duration)}</span>
      <span class="fav-btn" data-id="${t.id}">${icon('heart-o')}</span>
      <span class="pl-add-btn" data-id="${t.id}">${icon('plus')}</span>
    </div>`).join('');

  container.onclick = async (e) => {
    const row = e.target.closest('.track-row');
    if (!row) return;
    const idx = parseInt(row.dataset.index);
    
    // Favorite button
    if (e.target.classList.contains('fav-btn') || e.target.closest('.fav-btn')) {
      const btn = e.target.classList.contains('fav-btn') ? e.target : e.target.closest('.fav-btn');
      const track = tracks[idx];
      const isFaved = btn.classList.contains('faved');
      if (!isFaved) {
        await bridge.addFavorite(track);
        btn.classList.add('faved');
        btn.innerHTML = icon('heart');
      } else {
        await bridge.removeFavorite(track.id);
        btn.classList.remove('faved');
        btn.innerHTML = icon('heart-o');
        if (source === 'favorite') {
          row.remove();
          window._favTracks = await bridge.getFavorites();
        }
      }
      return;
    }
    
    // Add to playlist button
    if (e.target.classList.contains('pl-add-btn') || e.target.closest('.pl-add-btn')) {
      const track = tracks[idx];
      showPlaylistPicker(track);
      return;
    }
    
    // Play track
    if (source === 'search') playFromSearch(tracks[idx], idx, tracks);
    else if (source === 'local') playLocalTrack(tracks[idx], idx, tracks);
    else if (source === 'favorite') playTrack(tracks[idx], idx, tracks);
    else if (source === 'playlist') {
      window._plTracks = tracks;
      playTrack(tracks[idx], idx, tracks);
    }
  };

  // Update favorite button states
  updateFavBtns(container);
}

async function updateFavBtns(container) {
  try {
    const favs = await bridge.getFavorites();
    const favIds = new Set(favs.map(t => t.id));
    container.querySelectorAll('.fav-btn').forEach(btn => {
      if (favIds.has(btn.dataset.id)) {
        btn.classList.add('faved');
        btn.innerHTML = icon('heart');
      } else {
        btn.classList.remove('faved');
        btn.innerHTML = icon('heart-o');
      }
    });
  } catch (e) { console.error('updateFavBtns error:', e); }
}

function playLocalTrack(track, index, tracks) { playTrack(track, index, tracks); }
function escHtml(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function safeArtwork(value) {
  if (!value) return '';
  const url = String(value);
  return /^(https:\/\/|data:image\/)/i.test(url) ? escHtml(url) : '';
}

// ========== ADD TO PLAYLIST POPUP ==========

async function showPlaylistPicker(track) {
  const pls = await bridge.getPlaylists();
  if (!pls.length) {
    showError('No playlists. Create one first in Playlists tab.');
    return;
  }
  
  const old = $('#plPicker');
  if (old) old.remove();
  
  const picker = document.createElement('div');
  picker.id = 'plPicker';
  picker.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;border:1px solid #4a4a8a;border-radius:12px;padding:16px;z-index:10000;min-width:250px;box-shadow:0 0 40px rgba(100,100,255,.3);';
  picker.innerHTML = `<h3 style="margin:0 0 8px;">Add to playlist</h3>
    <p style="margin:0 0 12px;font-size:12px;color:#888;">${escHtml(track.title)}</p>
    ${pls.map(p => `<div class="pl-pick-row" data-id="${escHtml(p.id)}" style="padding:8px 12px;cursor:pointer;border-radius:6px;">${escHtml(p.name)} (${p.trackCount})</div>`).join('')}
    <button class="search-btn pl-picker-cancel" style="margin-top:8px;background:#5b5148;border-color:#5b5148;">Cancel</button>`;
  document.body.appendChild(picker);
  picker.querySelector('.pl-picker-cancel').onclick = () => picker.remove();
  
  picker.querySelectorAll('.pl-pick-row').forEach(el => {
    el.onmouseenter = () => el.style.background = '#2a2a4e';
    el.onmouseleave = () => el.style.background = '';
    el.onclick = async () => {
      await bridge.addToPlaylist(el.dataset.id, track);
      picker.remove();
      showError('Added to playlist ' + icon('check'), true);
    };
  });
}

// ========== NOW PLAYING / QUEUE ==========

function updateUI() {
  if (!currentTrack) return;
  npArt.src = safeArtwork(currentTrack.artwork);
  npTitle.textContent = currentTrack.title || '';
  npArtist.textContent = currentTrack.artist || '';
  playBtn.innerHTML = isPlaying ? icon('pause') : icon('play');
  seekBar.style.cursor = audio.duration && isFinite(audio.duration) ? 'pointer' : 'default';
  
  if (isPlaying) {
    npArt.classList.add('playing');
  } else {
    npArt.classList.remove('playing');
  }
  
  renderQueue();
  syncHomePlayer();
}

function renderQueue() {
  queueList.innerHTML = queue.slice(currentIndex + 1).map((t, i) => {
    const idx = currentIndex + 1 + i;
    return `<div class="queue-item" data-queue-index="${idx}">
      <img src="${safeArtwork(t.artwork)}" alt=""><div class="qi-info"><div class="qi-ttl">${escHtml(t.title)}</div><div class="qi-art">${escHtml(t.artist)}</div></div>
    </div>`;
  }).join('') || '<div class="muted" style="padding:20px;text-align:center;">Queue empty</div>';
  queueList.onclick = e => {
    const item = e.target.closest('.queue-item');
    if (item) playTrackFromQueue(Number(item.dataset.queueIndex));
  };
}
function playTrackFromQueue(idx) { playTrack(queue[idx], idx); }
function fmt(s) { if (!s) return '0:00'; const m = Math.floor(s/60), sec = Math.floor(s%60); return `${m}:${sec<10?'0':''}${sec}`; }

// ==================================================
// SAKURA FALLING PETALS ANIMATION FOR THE WORKSPACE
// ==================================================
(function() {
  const canvas = document.getElementById('sakura-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let width = canvas.width = window.innerWidth;
  let height = canvas.height = window.innerHeight;

  window.addEventListener('resize', () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  });

  const petalCount = 35;
  const petals = [];

  class SakuraPetal {
    constructor() {
      this.reset();
      this.y = Math.random() * height;
    }

    reset() {
      this.x = Math.random() * width;
      this.y = -20;
      this.size = Math.random() * 8 + 6;
      this.scale = Math.random() * 0.8 + 0.2;
      this.speedY = Math.random() * 1.0 + 0.6;
      this.speedX = Math.random() * 1.2 - 0.6;
      this.angle = Math.random() * 360;
      this.spinSpeed = Math.random() * 2 - 1;
      this.opacity = Math.random() * 0.4 + 0.4;
      this.color = Math.random() > 0.4 ? '#ffb7c5' : '#ffa1b2';
    }

    update() {
      this.y += this.speedY;
      this.x += this.speedX + Math.sin(this.y / 30) * 0.4;
      this.angle += this.spinSpeed;

      if (this.y > height + 20 || this.x < -20 || this.x > width + 20) {
        this.reset();
      }
    }

    draw() {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.angle * Math.PI / 180);
      ctx.scale(this.scale, this.scale);
      
      ctx.beginPath();
      ctx.fillStyle = this.color;
      ctx.globalAlpha = this.opacity;
      
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-this.size, -this.size / 2, -this.size, this.size, 0, this.size * 1.5);
      ctx.bezierCurveTo(this.size, this.size, this.size, -this.size / 2, 0, 0);
      ctx.fill();
      
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 0.8;
      ctx.moveTo(0, 0);
      ctx.lineTo(0, this.size * 1.1);
      ctx.stroke();
      
      ctx.restore();
    }
  }

  for (let i = 0; i < petalCount; i++) {
    petals.push(new SakuraPetal());
  }

  function animateSakura() {
    ctx.clearRect(0, 0, width, height);
    petals.forEach(petal => {
      petal.update();
      petal.draw();
    });
    requestAnimationFrame(animateSakura);
  }
  
  animateSakura();
})();
