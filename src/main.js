const deckA = new Audio(), deckB = new Audio();
let audio = deckA, spareAudio = deckB;
const deckNodes = new Map();
let crossfadePreparing = false, crossfadeToken = 0, crossfadePromise = null, crossfadeAttemptTrackId = null, normalizeTimer = null, normalizerGain = 1, lastHistoryTrackId = null, lastHistoryAt = 0;
let queue = [], currentIndex = -1, isPlaying = false, isShuffle = false, isRepeat = false, currentTrack = null, currentView = 'home';
let consecutiveFailures = 0;
let audioCtx = null, gainNode = null, volPercent = 80, analyser = null, isMuted = false;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24"><use href="#ico-${name}"/></svg>`;
const contentInner = $('#contentInner'), queueList = $('#queueList');
const npArt = $('#npArt'), npTitle = $('#npTitle'), npArtist = $('#npArtist');
const playBtn = $('#playBtn'), seekFill = $('#seekFill'), seekBar = $('#seekBar');
const curTime = $('#curTime'), totTime = $('#totTime');
const volFill = $('#volFill'), volBar = $('#volBar');
const shuffleBtn = $('#shuffleBtn'), repeatBtn = $('#repeatBtn');

const previewSettings = { opacity: 1, auraIntensity: .35, compactMode: false, appearance: 'system', accentColor: 'blue-purple', customColor: '', cornerRadius: 30, keybinds: {}, style: 'zen', pet: '', petSize: 96, petPos: null, volumeNormalize: false, eqBands: { low: 0, mid: 0, high: 0 }, crossfadeSeconds: 0, setupCompleted: false };
let uiSettings = { ...previewSettings };
const bridge = window.api || {
  win: () => {}, searchTracks: async () => [], pickFolder: async () => null, scanFolder: async () => [], onScanProgress: () => () => {},
  getFavorites: async () => [], addFavorite: async () => [], removeFavorite: async () => [],
  getPlaylists: async () => [], createPlaylist: async () => ({}), deletePlaylist: async () => true,
  getPlaylistTracks: async () => [], addToPlaylist: async () => [], removeFromPlaylist: async () => [],
  getSettings: async () => ({ ...previewSettings }), saveSettings: async () => true, setOpacity: () => {},
  setGlobalMute: async () => ({ ok: true }), onGlobalMute: () => {}, checkYtDlp: async () => true,
  getStreamInfo: async () => ({ base: 'http://127.0.0.1:3737', token: '' }), getLibrary: async () => ({ folders: [], tracks: [] }),
  getMissingLibraryTracks: async () => [], removeMissingLibraryTracks: async () => ({ removed: 0, tracks: [] }),
  getPlaybackState: async () => ({ queue: [], currentIndex: -1 }), savePlaybackState: async () => true,
  getHistory: async () => [], recordHistory: async () => true, clearHistory: async () => true, removeHistoryTrack: async () => true,
  exportBackup: async () => ({ canceled: true }), importBackup: async () => ({ canceled: true }), onMediaCommand: () => {},
  pickPetImage: async () => null, getCustomPets: async () => [], deleteCustomPet: async () => true, getPetDataUrl: async () => '',
  setupComplete: async (opts = {}) => ({ ok: true, settings: { ...previewSettings, ...opts, setupCompleted: true } }),
  setupSetWindowMode: async () => ({ ok: true })
};

const { populatePetSelect, setPet, applyPetLayout, updatePetState } = window.createPetCompanion({
  getSettings: () => uiSettings,
  saveSettings: debounceSave,
  getPlaybackState: () => ({ isPlaying, currentTrack }),
  getAnalyser: () => analyser,
  getCustomPets: () => bridge.getCustomPets(),
  getPetDataUrl: file => bridge.getPetDataUrl(file),
  applySettings, escHtml
});

// Stream proxy base + per-session token (fetched once, awaited before playback)
let streamInfoPromise = (bridge.getStreamInfo() || Promise.resolve({ base: 'http://127.0.0.1:3737', token: '' }))
  .catch(() => ({ base: 'http://127.0.0.1:3737', token: '' }));

audio.volume = 0.8; volPercent = 80; volFill.style.width = '80%';
setupAudio(); bindUI(); renderView('home');
loadAndApplySettings();
restorePlaybackQueue();
bridge.onMediaCommand(command => { if (command === 'play-pause') togglePlay(); else if (command === 'next-track') nextTrack(); else if (command === 'prev-track') prevTrack(); });
bridge.checkYtDlp().then(ok => { if (!ok) showError('yt-dlp not found — YouTube search & streaming disabled'); });

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
  const settings = await bridge.getSettings();
  if ((settings.appearance || 'system') === 'system') applySettings(settings);
});

function normalizeKey(k) {
  if (!k || typeof k !== 'string') return '';
  return k.replace(/\bKey([A-Za-z0-9])\b/g, '$1');
}

let keybinds = {};
async function loadKeybinds() {
  const s = await bridge.getSettings();
  keybinds = Object.assign({}, defaultKeys, s.keybinds || {});
  syncGlobalMute();
}
loadKeybinds();
bridge.onGlobalMute(() => toggleMute());

document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  const base = e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  const key = [...parts, base].join('+');
  const normKey = normalizeKey(key);
  const act = Object.entries(keybinds).find(([, k]) => normalizeKey(k) === normKey)?.[0];
  if (!act) return;
  e.preventDefault();
  if (act === 'play-pause' && currentTrack && audio.src) togglePlay();
  if (act === 'seek-forward' && isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
  if (act === 'seek-back' && isFinite(audio.duration)) audio.currentTime = Math.max(0, audio.currentTime - 5);
  if (act === 'vol-up') { volPercent = Math.min(100, volPercent + 5); applyVol(); }
  if (act === 'vol-down') { volPercent = Math.max(0, volPercent - 5); applyVol(); }
  if (act === 'mute-toggle') toggleMute();
  if (act === 'next-track') nextTrack();
  if (act === 'prev-track') prevTrack();
});

// Mute: toggles a gain-mute while keeping the slider value intact
function toggleMute() {
  isMuted = !isMuted;
  applyVol();
  const vb = $('#volBar');
  if (vb) {
    vb.classList.toggle('muted', isMuted);
    vb.title = isMuted ? 'Muted' : '';
  }
  showToast(window.__stylePhrases ? (isMuted ? window.__stylePhrases.mute[0] : window.__stylePhrases.mute[1]) : (isMuted ? 'Muted' : 'Unmuted'), 'info');
}

bridge.onScanProgress((msg) => {
  console.log('SCAN:', msg);
  const el = $('#localList');
  if (el) el.innerHTML = `<div class="empty">${msg}</div>`;
});

function connectDeck(deck) {
  const source = audioCtx.createMediaElementSource(deck);
  const low = audioCtx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 250;
  const mid = audioCtx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.8;
  const high = audioCtx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 4000;
  const deckGain = audioCtx.createGain(); deckGain.gain.value = deck === audio ? 1 : 0;
  source.connect(low); low.connect(mid); mid.connect(high); high.connect(deckGain); deckGain.connect(gainNode); deckGain.connect(analyser);
  deckNodes.set(deck, { gain: deckGain, filters: [low, mid, high] });
}

function setupAudio() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    gainNode.connect(audioCtx.destination);
    const silentTap = audioCtx.createGain(); silentTap.gain.value = 0; analyser.connect(silentTap); silentTap.connect(audioCtx.destination);
    connectDeck(deckA); connectDeck(deckB);
  } catch (e) { console.warn('WebAudio init failed:', e); }

  for (const deck of [deckA, deckB]) {
    deck.crossOrigin = 'anonymous';
    deck.volume = 1;
    deck.ontimeupdate = () => { if (deck !== audio) return; updateTimelineUI(); maybeCrossfade(); };
    deck.onloadedmetadata = () => { if (deck === audio) updateTimelineUI(); };
    deck.ondurationchange = () => { if (deck === audio) updateTimelineUI(); };
    deck.onplay = () => {
      if (deck !== audio) return;
      consecutiveFailures = 0; isPlaying = true; recordTrackPlay(currentTrack); updateUI();
    };
    deck.onpause = () => { if (deck === audio) { isPlaying = false; updateUI(); } };
    deck.onended = () => {
      if (deck !== audio) return;
      if (crossfadePromise) { const pending = crossfadePromise; pending.finally(() => { if (deck === audio && deck.ended) { if (isRepeat) playCurrent(); else nextTrack(); } }); return; }
      if (isRepeat) playCurrent(); else nextTrack();
    };
    deck.onerror = () => {
      if (deck !== audio) return;
      console.error('Audio error:', deck.error?.message || 'unknown');
      isPlaying = false; updateUI();
      if (currentTrack?.source === 'youtube' && queue.length > 1 && consecutiveFailures < 3) {
        consecutiveFailures++; showError('Track unavailable, skipping: ' + (currentTrack.title || 'unknown'));
        setTimeout(() => nextTrack(), 800);
      } else showError('Playback failed: ' + (currentTrack?.title || deck.error?.message || 'Unknown error'));
    };
  }
  applyAudioSettings(uiSettings);
  if (normalizeTimer) clearInterval(normalizeTimer);
  normalizeTimer = setInterval(updateNormalizer, 250);
}

function applyAudioSettings(settings) {
  const bands = settings?.eqBands || { low: 0, mid: 0, high: 0 };
  deckNodes.forEach(nodes => nodes.filters.forEach((filter, index) => {
    const value = [bands.low, bands.mid, bands.high][index] || 0;
    filter.gain.setTargetAtTime(Number(value), audioCtx.currentTime, 0.04);
  }));
  applyVol();
}

function updateNormalizer() {
  if (!analyser || !audioCtx || !uiSettings.volumeNormalize || !isPlaying) { normalizerGain += (1 - normalizerGain) * 0.12; applyVol(); return; }
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  const target = rms > 0.008 ? Math.max(0.65, Math.min(2.2, 0.18 / rms)) : 1;
  normalizerGain += (target - normalizerGain) * 0.08;
  applyVol();
}

function showToast(msg, type = 'error', useHtml = false) {
  const colors = { error: '#c00', success: '#2e7d32', info: '#37474f' };
  const bg = colors[type] || colors.error;
  if (type === 'error') console.error(msg); else console.log(msg);
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;padding:12px 24px;border-radius:8px;z-index:9999;font-size:14px;max-width:80%;text-align:center;pointer-events:none;`;
  if (useHtml) { el.innerHTML = msg; } else { el.textContent = msg; }
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
function showError(msg, useHtml) { showToast(msg, 'error', useHtml); }

async function trackStreamUrl(track) {
  if (track.directUrl) return track.directUrl;
  if (bridge.getTrackAudioUrl) {
    const url = await bridge.getTrackAudioUrl(track);
    if (url) return url;
  }
  const streamInfo = await streamInfoPromise;
  if (track.source === 'local') return streamInfo.base + '/local?path=' + encodeURIComponent(track.filepath) + '&t=' + streamInfo.token;
  const videoId = String(track.id || '').replace(/^yt:/, '');
  return streamInfo.base + '/youtube?v=' + encodeURIComponent(videoId) + '&t=' + streamInfo.token;
}

async function loadDeck(deck, track) {
  deck.pause(); deck.removeAttribute('src'); deck.load();
  deck.loop = false;
  const url = await trackStreamUrl(track);
  if (!url) throw new Error('No stream URL');
  deck.src = url;
}

function resetSpareDeck() {
  const nodes = deckNodes.get(spareAudio);
  if (nodes && audioCtx) { nodes.gain.gain.cancelScheduledValues(audioCtx.currentTime); nodes.gain.gain.setValueAtTime(0, audioCtx.currentTime); }
  spareAudio.pause(); spareAudio.removeAttribute('src'); spareAudio.load();
}

function cancelCrossfade() {
  crossfadeToken++;
  crossfadePreparing = false;
  crossfadePromise = null;
  resetSpareDeck();
}

async function maybeCrossfade() {
  if (isRepeat) return;
  const seconds = Number(uiSettings.crossfadeSeconds) || 0;
  if (!seconds || crossfadePreparing || crossfadeAttemptTrackId === currentTrack?.id || !isPlaying || !audio.duration || !Number.isFinite(audio.duration) || currentIndex < 0 || currentIndex + 1 >= queue.length) return;
  if (audio.duration - audio.currentTime > seconds) return;
  crossfadePreparing = true;
  crossfadeAttemptTrackId = currentTrack?.id || null;
  const token = crossfadeToken;
  const from = audio, to = spareAudio, fromIndex = currentIndex, nextIndex = currentIndex + 1, nextTrackData = queue[nextIndex];
  crossfadePromise = (async () => {
    try {
      await loadDeck(to, nextTrackData);
      if (token !== crossfadeToken || audio !== from || currentIndex !== fromIndex) return;
      if (audioCtx?.state === 'suspended') await audioCtx.resume();
      await to.play();
      if (token !== crossfadeToken || audio !== from || currentIndex !== fromIndex) { to.pause(); return; }
      const oldNodes = deckNodes.get(from), newNodes = deckNodes.get(to);
      const now = audioCtx?.currentTime || 0;
      const remaining = Number.isFinite(from.duration) ? Math.max(0.2, from.duration - from.currentTime) : seconds;
      const nextDuration = Number.isFinite(to.duration) ? Math.max(0.2, to.duration) : seconds;
      const fade = Math.min(seconds, remaining, nextDuration);
      if (oldNodes && newNodes && audioCtx) {
        oldNodes.gain.gain.cancelScheduledValues(now); newNodes.gain.gain.cancelScheduledValues(now);
        oldNodes.gain.gain.setValueAtTime(oldNodes.gain.gain.value, now);
        newNodes.gain.gain.setValueAtTime(newNodes.gain.gain.value, now);
        oldNodes.gain.gain.linearRampToValueAtTime(0, now + fade);
        newNodes.gain.gain.linearRampToValueAtTime(1, now + fade);
      }
      audio = to; spareAudio = from; currentIndex = nextIndex; currentTrack = nextTrackData; crossfadeAttemptTrackId = null;
      isPlaying = true; crossfadePreparing = false; crossfadePromise = null;
      persistPlaybackQueue(); recordTrackPlay(currentTrack); updateUI();
      setTimeout(() => {
        if (spareAudio === from) { from.pause(); from.removeAttribute('src'); from.load(); if (oldNodes && audioCtx) oldNodes.gain.gain.setValueAtTime(0, audioCtx.currentTime); }
      }, fade * 1000 + 100);
    } catch (error) {
      console.warn('Crossfade failed:', error.message);
      if (to !== audio) { to.pause(); to.removeAttribute('src'); to.load(); }

    } finally {
      if (token === crossfadeToken) { crossfadePreparing = false; crossfadePromise = null; }
    }
  })();
}

function persistPlaybackQueue() {
  return bridge.savePlaybackState({ queue, currentIndex }).catch(error => console.error('Queue save failed:', error));
}

function restorePlaybackQueue() {
  return bridge.getPlaybackState().then(state => {
    if (!state || !Array.isArray(state.queue)) return;
    queue = state.queue; currentIndex = Number.isInteger(state.currentIndex) ? state.currentIndex : -1;
    currentTrack = currentIndex >= 0 ? queue[currentIndex] || null : null;
    isPlaying = false; renderQueue(); updateUI();
    if (currentTrack && currentView === 'home') renderHome();
  }).catch(error => console.error('Queue restore failed:', error));
}

function recordTrackPlay(track) {
  if (!track) return;
  const now = Date.now();
  if (lastHistoryTrackId === track.id && now - lastHistoryAt < 30000) return;
  lastHistoryTrackId = track.id; lastHistoryAt = now;
  bridge.recordHistory(track).catch(error => console.error('History save failed:', error));
}

async function playTrack(track, index, newQueue = null) {
  cancelCrossfade(); crossfadeAttemptTrackId = null;
  if (newQueue) queue = [...newQueue];
  currentIndex = index; currentTrack = track; isPlaying = false;
  const nodes = deckNodes.get(audio);
  if (nodes && audioCtx) { nodes.gain.gain.cancelScheduledValues(audioCtx.currentTime); nodes.gain.gain.setValueAtTime(1, audioCtx.currentTime); }
  updateUI(); persistPlaybackQueue();
  try {
    if (track && track.id && String(track.id).startsWith('yt:ytsearch:') && bridge.resolveSearchTrack) {
      try {
        const resolved = await bridge.resolveSearchTrack(track);
        if (resolved && resolved.id) {
          track.id = resolved.id;
          if (resolved.duration) track.duration = resolved.duration;
          if (resolved.artwork && !track.artwork) track.artwork = resolved.artwork;
          persistPlaybackQueue();
        }
      } catch (err) {
        console.warn('Background search resolution notice:', err);
      }
    }
    await loadDeck(audio, track);
    if (audioCtx?.state === 'suspended') await audioCtx.resume();
    await audio.play();
    updateUI();
    preResolveUpcomingTracks();
  } catch (error) {
    console.error('Play error:', error);
    if (error.name === 'AbortError') return;
    showError('Failed to play: ' + (track.title || 'unknown'));
    isPlaying = false; updateUI();
  }
}

let preResolveRunning = false;
async function preResolveUpcomingTracks() {
  if (preResolveRunning) return;
  preResolveRunning = true;
  try {
    for (let i = currentIndex + 1; i < Math.min(queue.length, currentIndex + 5); i++) {
      const t = queue[i];
      if (t && t.id && String(t.id).startsWith('yt:ytsearch:') && bridge.resolveSearchTrack) {
        try {
          const res = await bridge.resolveSearchTrack(t);
          if (res && res.id) {
            t.id = res.id;
            if (res.duration) t.duration = res.duration;
            if (res.artwork && !t.artwork) t.artwork = res.artwork;
            persistPlaybackQueue();
          }
        } catch {}
      }
    }
  } finally {
    preResolveRunning = false;
  }
}
async function playCurrent() {
  if (!currentTrack) return;
  cancelCrossfade();
  await playTrack(currentTrack, currentIndex);
}
function togglePlay() {
  if (!audio.src && currentTrack) return playTrack(currentTrack, currentIndex);
  if (!audio.src && queue.length) return playTrack(queue[0], 0);
  if (!audio.src) return;
  isPlaying ? audio.pause() : audio.play().catch(error => showError('Playback failed: ' + error.message));
}
function nextTrack() { if (!queue.length) return; currentIndex = (currentIndex + 1) % queue.length; playTrack(queue[currentIndex], currentIndex); }
function prevTrack() { if (!queue.length) return; currentIndex = (currentIndex - 1 + queue.length) % queue.length; playTrack(queue[currentIndex], currentIndex); }
function playNextTrack(track) {
  if (crossfadePreparing) { cancelCrossfade(); crossfadeAttemptTrackId = null; }
  let insertAt = Math.max(0, currentIndex + 1);
  const existing = queue.findIndex(item => item.id === track.id);
  if (existing >= 0) { queue.splice(existing, 1); if (existing < currentIndex) currentIndex--; if (existing < insertAt) insertAt--; }
  queue.splice(insertAt, 0, track);
  if (currentIndex < 0) currentIndex = -1;
  persistPlaybackQueue(); renderQueue(); showError('Added to play next');
}
function changeQueueItem(index, direction) {
  if (crossfadePreparing) { cancelCrossfade(); crossfadeAttemptTrackId = null; }
  const target = index + direction;
  if (index <= currentIndex || target <= currentIndex || target < 0 || target >= queue.length) return;
  [queue[index], queue[target]] = [queue[target], queue[index]];
  persistPlaybackQueue(); renderQueue();
}
function removeQueueItem(index) {
  if (crossfadePreparing) { cancelCrossfade(); crossfadeAttemptTrackId = null; }
  if (index <= currentIndex || index < 0 || index >= queue.length) return;
  queue.splice(index, 1); persistPlaybackQueue(); renderQueue();
}

function getEventX(e) {
  if (e.touches && e.touches.length) return e.touches[0].clientX;
  if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0].clientX;
  return e.clientX || 0;
}

function seek(e) {
  if (!audio.duration || !isFinite(audio.duration)) return;
  const r = seekBar.getBoundingClientRect();
  const x = getEventX(e);
  const ratio = Math.max(0, Math.min(1, (x - r.left) / r.width));
  audio.currentTime = ratio * audio.duration;
}

let volDragging = false, seekDragging = false;
const defaultKeys = {
  'play-pause': 'Space',
  'seek-forward': 'ArrowRight',
  'seek-back': 'ArrowLeft',
  'vol-up': 'ArrowUp',
  'vol-down': 'ArrowDown',
  'mute-toggle': 'M',
  'next-track': 'MediaNextTrack',
  'prev-track': 'MediaPrevTrack',
};
function calcVol(e) {
  const r = volBar.getBoundingClientRect();
  const x = getEventX(e);
  return Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100));
}
function applyVol() {
  const gain = (isMuted ? 0 : volPercent / 100) * normalizerGain;
  if (gainNode && audioCtx) gainNode.gain.setTargetAtTime(gain, audioCtx.currentTime, 0.035);
  else { audio.volume = isMuted ? 0 : volPercent / 100; spareAudio.volume = audio.volume; }
  volFill.style.width = volPercent + '%';
}
function setVol(e) { volPercent = calcVol(e); applyVol(); }
let originalQueue = [];
function toggleShuffle() {
  if (crossfadePreparing) { cancelCrossfade(); crossfadeAttemptTrackId = null; }
  isShuffle = !isShuffle;
  shuffleBtn.classList.toggle('active', isShuffle);
  if (isShuffle) { originalQueue = [...queue]; shuffleQueue(); }
  else if (originalQueue.length) {
    queue = [...originalQueue]; originalQueue = [];
    const idx = currentTrack ? queue.findIndex(t => t.id === currentTrack.id) : -1;
    currentIndex = idx;
  }
  persistPlaybackQueue(); renderQueue();
}
function toggleRepeat() {
  isRepeat = !isRepeat;
  repeatBtn.classList.toggle('active', isRepeat);
  if (audio) audio.loop = false;
  if (spareAudio) spareAudio.loop = false;
}
function shuffleQueue() { const current = currentIndex >= 0 ? queue[currentIndex] : null; const rest = queue.filter((_, i) => i !== currentIndex); for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; } queue = current ? [current, ...rest] : rest; currentIndex = current ? 0 : -1; }

function bindUI() {
  $$('.nav-btn[data-view]').forEach(b => b.onclick = () => { setActive(b); renderView(b.dataset.view); });
  playBtn.onclick = togglePlay; $('#prevBtn').onclick = prevTrack; $('#nextBtn').onclick = nextTrack;
  shuffleBtn.onclick = toggleShuffle; repeatBtn.onclick = toggleRepeat;
  seekBar.onmousedown = (e) => { if (audio.duration && isFinite(audio.duration)) { seekDragging = true; seek(e); } };
  seekBar.addEventListener('touchstart', (e) => { if (audio.duration && isFinite(audio.duration)) { seekDragging = true; seek(e); } }, { passive: true });
  volBar.onmousedown = (e) => { volDragging = true; setVol(e); };
  volBar.addEventListener('touchstart', (e) => { volDragging = true; setVol(e); }, { passive: true });
  document.onmousemove = (e) => { if (seekDragging) seek(e); if (volDragging) setVol(e); };
  document.addEventListener('touchmove', (e) => { if (seekDragging) seek(e); if (volDragging) setVol(e); }, { passive: true });
  document.onmouseup = () => { seekDragging = false; volDragging = false; };
  document.addEventListener('touchend', () => { seekDragging = false; volDragging = false; }, { passive: true });
  $('#winMin').onclick = () => bridge.win('minimize');
  $('#winMax').onclick = () => bridge.win('maximize');
  $('#winClose').onclick = () => bridge.win('close');
  const lBtn = $('#lyricsBtn');
  if (lBtn) lBtn.onclick = () => window.mintpyLyrics?.toggle();
  const ambBtn = $('#ambientBtn');
  if (ambBtn) ambBtn.onclick = () => window.mintpyAmbient?.toggle();
  const stBtn = $('#sleepTimerBtn');
  if (stBtn) stBtn.onclick = () => window.mintpySleepTimer?.toggle();
}
function setActive(btn) { $$('.nav-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); }

function renderView(view) {
  currentView = view;
  if (view === 'home') return renderHome();
  if (view === 'search') return renderSearch();
  if (view === 'library') return renderLibrary();
  if (view === 'history') return renderHistory();
  if (view === 'favorites') return renderFavorites();
  if (view === 'playlists') return renderPlaylists();
  if (view === 'settings') return renderSettings();
  if (view.startsWith('playlist-')) return renderPlaylistDetail(view.replace('playlist-', ''));
}

// ========== SETTINGS ==========

// ==================== MINTPY ZEN SETUP WIZARD ====================
const styleAccents = {
  zen: { accent: '#4ade80', glow: 'rgba(74, 222, 128, 0.25)', icon: '🎋', label: 'Zen (Сад камней)' },
  lofi: { accent: '#f59e0b', glow: 'rgba(245, 158, 11, 0.25)', icon: '☕', label: 'Lo-Fi (Уютный кофе)' },
  synthwave: { accent: '#ec4899', glow: 'rgba(236, 72, 153, 0.25)', icon: '🌆', label: 'Synthwave (Ретро-закат)' },
  ocean: { accent: '#38bdf8', glow: 'rgba(56, 189, 248, 0.25)', icon: '🌊', label: 'Ocean (Морские глубины)' },
  forest: { accent: '#22c55e', glow: 'rgba(34, 197, 94, 0.25)', icon: '🌲', label: 'Forest (Ночной лес)' },
  aurora: { accent: '#a855f7', glow: 'rgba(168, 85, 247, 0.25)', icon: '✨', label: 'Aurora (Северное сияние)' }
};

function initSetupWizard(initialSettings = {}) {
  const overlay = $('#mintpy-setup-overlay');
  const card = $('#setupWindowCard');
  if (!overlay || !card) return;

  let selectedStyle = initialSettings.style || uiSettings.style || 'zen';
  let selectedTheme = (initialSettings.appearance || uiSettings.appearance) === 'light' ? 'light' : 'dark';

  function applySetupAccent(st) {
    const meta = styleAccents[st] || styleAccents.zen;
    document.documentElement.style.setProperty('--setup-accent', meta.accent);
    document.documentElement.style.setProperty('--setup-accent-glow', meta.glow);
    const labelIco = $('#setupLabelIcon');
    if (labelIco) labelIco.textContent = meta.icon;
  }

  function setSetupStep(stepNum) {
    document.querySelectorAll('.setup-step').forEach(s => s.classList.remove('active'));
    const target = $(`#setupStep${stepNum}`);
    if (target) target.classList.add('active');

    document.querySelectorAll('#setupStepDots .step-dot').forEach(d => {
      d.classList.toggle('active', Number(d.dataset.step) === stepNum);
    });
  }

  // 1. Show overlay
  card.classList.remove('closing');
  overlay.classList.remove('hidden');
  setSetupStep(1);
  applySetupAccent(selectedStyle);

  // Sync initial style cards
  document.querySelectorAll('#setupStylesGrid .setup-style-card').forEach(c => {
    c.classList.toggle('active', c.dataset.style === selectedStyle);
  });

  // Sync initial theme pills
  document.querySelectorAll('#setupThemePills .theme-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.theme === selectedTheme);
  });

  if (bridge.setupSetWindowMode) {
    bridge.setupSetWindowMode('setup');
  }

  // 2. Bind Style Cards
  document.querySelectorAll('#setupStylesGrid .setup-style-card').forEach(btn => {
    btn.onclick = () => {
      selectedStyle = btn.dataset.style;
      document.querySelectorAll('#setupStylesGrid .setup-style-card').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      applySetupAccent(selectedStyle);

      // Instantly apply style to app window
      applySettings({ ...uiSettings, style: selectedStyle, appearance: selectedTheme });

      // Refresh background particles
      if (typeof window.resetSakuraParticles === 'function') {
        window.resetSakuraParticles();
      }
      document.dispatchEvent(new CustomEvent('mintpy:style-change'));
    };
  });

  // 3. Bind Theme Pills
  document.querySelectorAll('#setupThemePills .theme-pill').forEach(pill => {
    pill.onclick = () => {
      selectedTheme = pill.dataset.theme;
      document.querySelectorAll('#setupThemePills .theme-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      applySettings({ ...uiSettings, style: selectedStyle, appearance: selectedTheme });
    };
  });

  // 4. Step 1 -> Step 2
  const toStep2Btn = $('#setupToStep2Btn');
  if (toStep2Btn) {
    toStep2Btn.onclick = () => {
      setSetupStep(2);
      runSetupProgress();
    };
  }

  // Run progress simulation
  function runSetupProgress() {
    const bar = $('#setupProgressBar');
    const statusText = $('#setupProgressStatus');
    const percentText = $('#setupProgressPercent');
    const terminalLog = $('#setupTerminalLog');
    if (!bar || !statusText || !percentText || !terminalLog) return;

    bar.style.width = '0%';
    percentText.textContent = '0%';
    terminalLog.innerHTML = '<div class="log-line active">&gt; Запуск модуля быстрой установки MintPy...</div>';

    const logs = [
      { pct: '25%', status: 'Инициализация аудио-ядра...', log: '> Web Audio API & HTML5 Deck активированы. Буфер pink/white шума готов.' },
      { pct: '55%', status: 'Подключение локального audio-proxy...', log: '> Проксирование потоков (127.0.0.1:3737) установлено.' },
      { pct: '80%', status: 'Кэширование шейдеров частиц и тем...', log: `> Пресет частиц «${selectedStyle}» загружен в Canvas GPU.` },
      { pct: '100%', status: 'Всё готово к работе!', log: '> Конфигурация сохранена. Мастер завершен успешно.' }
    ];

    let currentIdx = 0;
    const interval = setInterval(() => {
      if (currentIdx >= logs.length) {
        clearInterval(interval);
        setTimeout(() => {
          // Go to step 3
          setSetupStep(3);
          const meta = styleAccents[selectedStyle] || styleAccents.zen;
          const themeLabel = $('#summaryThemeLabel');
          if (themeLabel) {
            themeLabel.textContent = `Применена атмосфера: ${meta.label} (${selectedTheme === 'dark' ? 'Тёмная' : 'Светлая'})`;
          }
        }, 400);
        return;
      }

      const item = logs[currentIdx];
      bar.style.width = item.pct;
      percentText.textContent = item.pct;
      statusText.textContent = item.status;

      document.querySelectorAll('#setupTerminalLog .log-line').forEach(l => l.classList.remove('active'));
      const line = document.createElement('div');
      line.className = 'log-line active';
      line.textContent = item.log;
      terminalLog.appendChild(line);
      terminalLog.scrollTop = terminalLog.scrollHeight;

      currentIdx++;
    }, 550);
  }

  // 5. Finish setup button
  const finishBtn = $('#setupFinishBtn');
  if (finishBtn) {
    finishBtn.onclick = async () => {
      const createShortcut = $('#setupShortcutCheck') ? $('#setupShortcutCheck').checked : true;
      const startAmbient = $('#setupAmbientCheck') ? $('#setupAmbientCheck').checked : false;

      finishBtn.disabled = true;
      finishBtn.textContent = 'Запуск...';

      if (bridge.setupComplete) {
        await bridge.setupComplete({
          style: selectedStyle,
          theme: selectedTheme,
          createShortcut,
          startAmbient
        });
      } else {
        uiSettings.setupCompleted = true;
        uiSettings.style = selectedStyle;
        uiSettings.appearance = selectedTheme;
        await bridge.saveSettings(uiSettings);
      }

      if (startAmbient && window.mintpyAmbient && typeof window.mintpyAmbient.setVolume === 'function') {
        window.mintpyAmbient.setVolume('rain', 0.4);
      }

      card.classList.add('closing');
      setTimeout(() => {
        overlay.classList.add('hidden');
        card.classList.remove('closing');
        finishBtn.disabled = false;
        finishBtn.innerHTML = '<span>Запустить MintPy 🎧</span>';
        if (bridge.setupSetWindowMode) {
          bridge.setupSetWindowMode('main');
        }
        showToast('✨ MintPy настроен и готов к погружению!', 'success');
      }, 450);
    };
  }
}

async function loadAndApplySettings() {
  try {
    const s = await bridge.getSettings();
    applySettings(s);
    setPet(s.pet || '');
    if (!s.setupCompleted) {
      initSetupWizard(s);
    }
  } catch (e) { console.error('Settings load error:', e); }
}

function applySettings(s) {
  const root = document.documentElement;
  uiSettings = { ...s };
  
  bridge.setOpacity(s.opacity);
  
  root.style.setProperty('--content-padding', s.compactMode ? '20px' : '32px');
  root.style.setProperty('--spacing', s.compactMode ? '10px' : '16px');
  root.style.setProperty('--window-radius', Math.max(28, Number(s.cornerRadius) || 30) + 'px');
  root.style.setProperty('--aura-opacity', s.auraIntensity);
  const appearance = s.appearance || 'system';
  root.dataset.theme = appearance === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : appearance;
  root.dataset.style = s.style || 'zen';
  
  // Accent color is user-selectable only in the zen style; other styles ship their own palette
  if ((s.style || 'zen') === 'zen') {
    const accents = {
      'blue-purple': { accent: '#a5202d', secondary: '#486b45' },
      'green-teal':  { accent: '#3f6845', secondary: '#7f4c3c' },
      'orange-red':  { accent: '#b45b2a', secondary: '#556f48' },
      'pink-rose':   { accent: '#b14a62', secondary: '#63764f' },
      'cyan-lime':   { accent: '#376b72', secondary: '#657445' },
      'white-cold':  { accent: '#4f5663', secondary: '#6b6258' },
    };
    const validCustom = typeof s.customColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s.customColor) ? s.customColor : '';
    const c = validCustom ? { accent: validCustom, secondary: '#486b45' }
                            : (accents[s.accentColor] || accents['blue-purple']);
    root.style.setProperty('--red', c.accent);
    root.style.setProperty('--red-soft', c.accent + '1a');
    root.style.setProperty('--green', c.secondary);
  } else {
    root.style.removeProperty('--red');
    root.style.removeProperty('--red-soft');
    root.style.removeProperty('--green');
  }
  keybinds = Object.assign({}, defaultKeys, s.keybinds || {});
  syncGlobalMute();
  applyAudioSettings(s);
  applyStylePhrases(s.style || 'zen');
}

// Per-style localized chrome: brand, tagline, sidebar quote, queue badge, volume label
const STYLE_PHRASES = {
  zen: {
    brand: '音の間', title: '静かな音', volume: '音量', queue: '次',
    eyebrow: 'NOW PLAYING · 再生中', empty: '静けさの中に、音がある',
    quote: { text: '古池や<br>蛙飛びこむ<br>水の音', by: '— 松尾芭蕉' },
    playerTag: '朱に交わる', // vermilion seal accent
    mute: ['消音', '音あり'],
    nav: { home: 'ホーム', search: '検索', favorites: 'お気に入り', playlists: '再生リスト', library: '音楽庫', settings: '設定' },
  },
  lofi: {
    brand: 'salon du son', title: 'douceur sonore', volume: 'volume', queue: '→',
    eyebrow: 'NOW PLAYING · en cours', empty: 'Dans le calme, la musique',
    quote: { text: '«La musique est la langue des émotions»', by: '— Voltaire' },
    playerTag: 'cassette nº1',
    mute: ['silence…', 'le son revient'],
    nav: { home: 'accueil', search: 'chercher', favorites: 'favoris', playlists: 'listes', library: 'bibliothèque', settings: 'réglages' },
  },
  synthwave: {
    brand: 'SONIDO', title: 'noche de neón', volume: 'VOL', queue: '»',
    eyebrow: 'NOW PLAYING · REPRODUCIENDO', empty: 'En la noche, el ritmo',
    quote: { text: 'El silencio es música<br>en pausa', by: '— Retrowave' },
    playerTag: 'FM 84.0 MHz',
    mute: ['SILENCIO', 'SONIDO'],
    nav: { home: 'inicio', search: 'buscar', favorites: 'favoritos', playlists: 'listas', library: 'biblioteca', settings: 'ajustes' },
  },
  aurora: {
    brand: 'lydrommet', title: 'stillhet og lyd', volume: 'lyd', queue: '→',
    eyebrow: 'NOW PLAYING · spiller', empty: 'I stillheten finnes tonene',
    quote: { text: 'Naturen synger<br>sin egen melodi', by: '— Nordlys' },
    playerTag: 'nordlys aktiv',
    mute: ['hysj…', 'lyden er tilbake'],
    nav: { home: 'hjem', search: 'søk', favorites: 'favoritter', playlists: 'lister', library: 'bibliotek', settings: 'innstillinger' },
  },
  ocean: {
    brand: 'ABYSSAL', title: 'deep sea vibrations', volume: 'depth', queue: '→',
    eyebrow: 'NOW PLAYING · SUBMERGED', empty: 'In the depths, only echoes',
    quote: { text: 'The sea, once it casts its spell,<br>holds one in its net of wonder forever.', by: '— J. Cousteau' },
    playerTag: 'nautilus 01',
    mute: ['SILENCE', 'SONAR'],
    nav: { home: 'home', search: 'sonar', favorites: 'pearls', playlists: 'currents', library: 'abyss', settings: 'config' },
  },
  forest: {
    brand: 'äänihuone', title: ' hiljaa soi', volume: 'ääni', queue: '→',
    eyebrow: 'NOW PLAYING · soi', empty: 'Hiljaisuudessa laulaa metsä',
    quote: { text: 'Bambu taipuu,<br>muttei katkea', by: '— Sananlasku' },
    playerTag: 'viidantaival',
    mute: ['hiljaisuus', 'ääni palasi'],
    nav: { home: 'koti', search: 'haku', favorites: 'suosikit', playlists: 'listat', library: 'kirjasto', settings: 'asetukset' },
  },
};

function applyStylePhrases(style) {
  const p = STYLE_PHRASES[style] || STYLE_PHRASES.zen;
  const q = $('#styleQuote');
  if (q) q.innerHTML = `<span>${p.quote.text}</span><small>${p.quote.by}</small>`;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('brandJp', p.brand);
  set('titleSmall', p.title);
  set('volumeLabel', p.volume);
  set('queueBadge', p.queue);
  set('playerTag', p.playerTag);
  $$('.nav-btn[data-view]').forEach(b => {
    const small = b.querySelector('small');
    if (small && p.nav[b.dataset.view]) small.textContent = p.nav[b.dataset.view];
  });
  window.__stylePhrases = p;
}

// Register the mute bind as an OS-level shortcut so it works while any app is focused
let _lastMuteBind;
async function syncGlobalMute(announce = false) {
  const bind = normalizeKey(keybinds['mute-toggle'] || '');
  if (bind === _lastMuteBind) return;
  _lastMuteBind = bind;
  try {
    const r = await bridge.setGlobalMute(bind || null);
    if (announce && bind && r && !r.ok) showError('Global mute bind unavailable: ' + r.error);
  } catch (e) {
    if (announce) showError('Global mute bind failed: ' + e.message);
  }
}

function renderSettings() {
  // Read from client-side state (applySettings keeps uiSettings in sync immediately),
  // otherwise the debounced save would race with re-render and revert the last change.
  const raw = { ...uiSettings };
  const s = {
    ...raw,
    opacity: Math.min(1, Math.max(0.15, Number(raw.opacity) || 1)),
    auraIntensity: Number(raw.auraIntensity) || 0,
    cornerRadius: Number(raw.cornerRadius) || 30,
    customColor: typeof raw.customColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.customColor) ? raw.customColor : '',
  };
  const themes = [
    { value: 'blue-purple', label: 'Crimson Hanko' },
    { value: 'green-teal', label: 'Matcha' },
    { value: 'orange-red', label: 'Autumn Maple' },
    { value: 'pink-rose', label: 'Sakura' },
    { value: 'cyan-lime', label: 'Indigo Mist' },
    { value: 'white-cold', label: 'Sumi Ink' },
  ];
  const styles = [
    { value: 'zen', label: 'Japanese Zen (default)' },
    { value: 'lofi', label: 'Lo-Fi Chill' },
    { value: 'synthwave', label: 'Synthwave 80s' },
    { value: 'aurora', label: 'Glass Aurora' },
    { value: 'ocean', label: 'Deep Ocean' },
    { value: 'forest', label: 'Forest Zen' },
  ];
  const isZen = (s.style || 'zen') === 'zen';
  contentInner.innerHTML = `
    <h2 style="margin-bottom:24px;">${icon('settings')} Settings</h2>
    <div class="settings-group">
      <h3>Window</h3>
      <div class="setting-row">
        <label>Style</label>
        <select id="setStyle">
          ${styles.map(t => `<option value="${t.value}" ${(s.style || 'zen') === t.value ? 'selected' : ''}>${t.label}</option>`).join('')}
        </select>
      </div>
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
      <h3>Colors${isZen ? '' : ' <small class="muted">(Zen style only)</small>'}</h3>
      <div class="setting-row">
        <label>Theme</label>
        <select id="setAccent" ${isZen ? '' : 'disabled style="opacity:.45;"'}>
          ${themes.map(t => `<option value="${t.value}" ${s.accentColor === t.value ? 'selected' : ''}>${t.label}</option>`).join('')}
        </select>
      </div>
      <div class="setting-row">
        <label>Custom Color</label>
        <input type="color" id="setCustomColor" value="${s.customColor || '#00d4ff'}" style="width:40px;height:40px;border:none;border-radius:8px;cursor:pointer;background:none;" ${isZen ? '' : 'disabled style="opacity:.45;"'}>
      </div>
    </div>
    <div class="settings-group">
      <h3>Sound</h3>
      <div class="setting-row"><label>Normalize loudness</label><div class="toggle-switch ${s.volumeNormalize ? 'active' : ''}" id="setNormalize" role="switch" aria-checked="${Boolean(s.volumeNormalize)}"></div></div>
      <p class="muted" style="font-size:11px;margin:0 0 8px;">Live RMS leveling with a capped gain boost.</p>
      <div class="setting-row"><label>Low · 250 Hz</label><div class="sound-range"><input type="range" id="eqLow" min="-12" max="12" step="1" value="${s.eqBands?.low || 0}"><span class="setting-val" id="eqLowVal">${s.eqBands?.low || 0} dB</span></div></div>
      <div class="setting-row"><label>Mid · 1 kHz</label><div class="sound-range"><input type="range" id="eqMid" min="-12" max="12" step="1" value="${s.eqBands?.mid || 0}"><span class="setting-val" id="eqMidVal">${s.eqBands?.mid || 0} dB</span></div></div>
      <div class="setting-row"><label>High · 4 kHz</label><div class="sound-range"><input type="range" id="eqHigh" min="-12" max="12" step="1" value="${s.eqBands?.high || 0}"><span class="setting-val" id="eqHighVal">${s.eqBands?.high || 0} dB</span></div></div>
      <div class="setting-row"><label>Crossfade</label><div class="sound-range"><input type="range" id="setCrossfade" min="0" max="12" step="1" value="${s.crossfadeSeconds || 0}"><span class="setting-val" id="crossfadeVal">${s.crossfadeSeconds ? s.crossfadeSeconds + ' s' : 'Off'}</span></div></div>
    </div>
    <div class="settings-group">
      <h3>Backup</h3>
      <div class="setting-row"><label>Favorites, playlists, queue, history, settings and custom companions</label><div class="backup-actions"><button class="search-btn" id="exportBackupBtn">Export</button><button class="search-btn" id="importBackupBtn">Restore</button></div></div>
    </div>
    <div class="settings-group" id="importMusicGroup">
      <h3>${icon('playlist')} Transfer Music / Import Playlist</h3>
      <p class="muted" style="font-size:12px;margin:0 0 12px;line-height:1.5;">
        Paste a public playlist or album link from <b>Yandex Music</b>, <b>YouTube / YouTube Music</b>, or <b>Spotify</b>. MintPy will automatically transfer the tracks into your playlists!
      </p>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="text" id="importUrlInput" class="search-input" placeholder="https://music.yandex.ru/... or YouTube / Spotify link" style="flex:1;">
        <button class="search-btn" id="importUrlBtn" style="white-space:nowrap;padding:0 18px;">Import</button>
      </div>
      <div id="importStatus" style="font-size:12px;margin-top:8px;display:none;"></div>
    </div>
    <div class="settings-group">
      <h3>Keyboard Shortcuts</h3>
      <div id="keybindsList"></div>
      <p class="muted" style="font-size:12px;margin-top:8px;">Click a shortcut then press new key — Ctrl/Alt/Shift combos supported (Mute works even in other apps). Defaults: Space, M for mute</p>
    </div>
    <div class="settings-group">
      <h3>${icon('settings')} Master Setup</h3>
      <div class="setting-row">
        <label>Мастер первого запуска (Zen Setup Wizard)</label>
        <button class="search-btn" id="openSetupWizardBtn" style="white-space:nowrap;padding:0 16px;">Мастер атмосферы</button>
      </div>
    </div>
    <p class="muted" style="font-size:12px;margin-top:32px;">Settings are saved automatically</p>`;

  const cur = { ...s };

  renderKeybinds(cur);
  const openSetupBtn = $('#openSetupWizardBtn');
  if (openSetupBtn) openSetupBtn.onclick = () => initSetupWizard(uiSettings);

  $('#setStyle').onchange = function() {
    cur.style = this.value;
    applySettings(cur);
    debounceSave(cur);
    renderSettings();
  };



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
  $('#setNormalize').onclick = function() {
    cur.volumeNormalize = !cur.volumeNormalize;
    this.classList.toggle('active', cur.volumeNormalize);
    this.setAttribute('aria-checked', String(cur.volumeNormalize));
    applySettings(cur); debounceSave(cur);
  };
  for (const band of ['low', 'mid', 'high']) {
    const control = $('#eq' + band[0].toUpperCase() + band.slice(1));
    control.oninput = function() {
      cur.eqBands = { ...(cur.eqBands || {}), [band]: Number(this.value) };
      $('#eq' + band[0].toUpperCase() + band.slice(1) + 'Val').textContent = this.value + ' dB';
      applySettings(cur); debounceSave(cur);
    };
  }
  $('#setCrossfade').oninput = function() {
    cur.crossfadeSeconds = Number(this.value);
    $('#crossfadeVal').textContent = cur.crossfadeSeconds ? cur.crossfadeSeconds + ' s' : 'Off';
    applySettings(cur); debounceSave(cur);
  };
  $('#exportBackupBtn').onclick = async () => {
    try { const result = await bridge.exportBackup(); if (!result.canceled) showError('MintPy backup exported'); }
    catch (error) { showError('Export failed: ' + error.message); }
  };
  $('#importBackupBtn').onclick = async () => {
    if (!window.confirm('Restore this backup? Favorites, playlists, library metadata, queue, history and settings will be replaced; custom companions from the backup will be restored.')) return;
    try {
      const result = await bridge.importBackup(); if (result.canceled) return;
      cancelCrossfade();
      for (const deck of [deckA, deckB]) { deck.pause(); deck.removeAttribute('src'); deck.load(); }
      audio = deckA; spareAudio = deckB; currentTrack = null; currentIndex = -1; isPlaying = false;
      for (const [deck, value] of [[deckA, 1], [deckB, 0]]) {
        const nodes = deckNodes.get(deck);
        if (nodes && audioCtx) { nodes.gain.gain.cancelScheduledValues(audioCtx.currentTime); nodes.gain.gain.setValueAtTime(value, audioCtx.currentTime); }
      }
      await loadAndApplySettings(); await restorePlaybackQueue(); renderView(currentView);
      showError('Backup restored' + (result.skippedLocalTracks ? ' · skipped ' + result.skippedLocalTracks + ' local tracks outside the current library' : ''));
    } catch (error) { showError('Restore failed: ' + error.message); }
  };
  const importBtn = $('#importUrlBtn');
  const importInput = $('#importUrlInput');
  const importStatus = $('#importStatus');
  if (importBtn && importInput && importStatus) {
    const doImport = async () => {
      const url = importInput.value.trim();
      if (!url) return showError('Please paste a playlist or album link');
      importBtn.disabled = true;
      importBtn.textContent = 'Importing...';
      importStatus.style.display = 'block';
      importStatus.style.color = 'var(--gold)';
      importStatus.textContent = 'Connecting and fetching tracks from service...';
      try {
        const pl = await bridge.importPlaylistFromUrl(url);
        importStatus.style.color = 'var(--green)';
        importStatus.textContent = `Successfully imported "${pl.name}" (${pl.trackCount} tracks)!`;
        importInput.value = '';
        showError(`Imported "${pl.name}" (${pl.trackCount} tracks)!`);
        setTimeout(() => {
          renderView('playlist-' + pl.id);
        }, 1200);
      } catch (err) {
        importStatus.style.color = 'var(--red)';
        importStatus.textContent = 'Import failed: ' + err.message;
        showError('Import failed: ' + err.message);
      } finally {
        importBtn.disabled = false;
        importBtn.textContent = 'Import';
      }
    };
    importBtn.onclick = doImport;
    importInput.onkeydown = e => { if (e.key === 'Enter') doImport(); };
  }
}

const keyLabels = {
  'play-pause': 'Play / Pause',
  'seek-forward': 'Seek Forward',
  'seek-back': 'Seek Back',
  'vol-up': 'Volume Up',
  'vol-down': 'Volume Down',
  'mute-toggle': 'Mute (global)',
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
    row.innerHTML = `<label>${label}</label><span class="keybind-btn" data-action="${id}" tabindex="0">${escHtml(merged[id])}</span>`;
    row.querySelector('.keybind-btn').onclick = function() {
      this.classList.add('capturing');
      this.textContent = '...';
      const handler = e => {
        if (e.key === 'Escape') {
          this.textContent = merged[id];
          this.classList.remove('capturing');
          document.removeEventListener('keydown', handler, true);
          return;
        }
        if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return;
        e.preventDefault(); e.stopPropagation();
        const parts = [];
        if (e.ctrlKey) parts.push('Control');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Super');
        const base = e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
        const key = [...parts, base].join('+');
        this.textContent = key;
        this.classList.remove('capturing');
        if (!s.keybinds) s.keybinds = {};
        s.keybinds[id] = key;
        keybinds[id] = key;
        if (id === 'mute-toggle') syncGlobalMute(true);
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
          <span class="home-eyebrow">${window.__stylePhrases ? window.__stylePhrases.eyebrow : 'NOW PLAYING'}</span>
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
    contentInner.innerHTML = `<div class="empty"><img class="home-brand-logo" src="../assets/mintpy-logo.png" alt="MintPy"><h2>MintPy</h2><p class="muted">Search for music or import a local folder</p><small class="muted">${window.__stylePhrases ? window.__stylePhrases.empty : '静けさの中に、音がある'}</small></div>`;
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
  if (window._lastSearchQuery) inp.value = window._lastSearchQuery;
  const btn = document.createElement('button');
  btn.className = 'search-btn'; btn.id = 'searchBtn'; btn.textContent = 'Search';
  searchBar.appendChild(inp); searchBar.appendChild(btn);
  const results = document.createElement('div');
  results.className = 'track-list'; results.id = 'results';
  contentInner.appendChild(searchBar); contentInner.appendChild(results);
  btn.onclick = doSearch;
  inp.onkeydown = e => { if (e.key === 'Enter') doSearch(); };
  if (Array.isArray(window._searchTracks) && window._searchTracks.length) {
    renderTrackList(results, window._searchTracks, 'search');
  } else {
    setTimeout(() => inp.focus(), 50);
  }
}

async function doSearch() {
  const q = $('#searchInp').value.trim(); if (!q) return;
  window._lastSearchQuery = q;
  const res = $('#results'); res.innerHTML = '<div class="empty">Searching...</div>';
  let tracks;
  try {
    tracks = await bridge.searchTracks(q);
  } catch (e) {
    const msg = String(e.message || e).replace(/^Error invoking remote method 'search-tracks':\s*(Error:\s*)?/, '');
    return res.innerHTML = `<div class="empty"><h2>Search error</h2><p>${escHtml(msg)}</p><p class="muted">Check your connection or yt-dlp installation, then try again</p></div>`;
  }
  if (!tracks.length) return res.innerHTML = '<div class="empty">Nothing found</div>';
  window._searchTracks = tracks;
  renderTrackList(res, tracks, 'search');
}
function playFromSearch(track, index, tracks) { playTrack(track, index, tracks); }

// ========== LIBRARY ==========

function renderLibrary() {
  contentInner.innerHTML = '<div class="library-header"><div><h2>' + icon('folder') + ' Local Library</h2><p class="muted" id="libraryCount">Loading library...</p></div><div class="library-actions"><button class="search-btn" id="rescanAllBtn">Rescan all</button><button class="search-btn" id="scanLocalBtn">Add folder</button><button class="search-btn" id="removeMissingBtn">Remove missing</button></div></div><div class="library-toolbar"><input class="search-input" id="librarySearch" placeholder="Search title, artist or album"><select id="librarySort"><option value="title">Title</option><option value="artist">Artist</option><option value="album">Album</option><option value="duration">Duration</option></select></div><div class="track-list" id="localList"></div>';
  $('#scanLocalBtn').onclick = scanLocal;
  $('#rescanAllBtn').onclick = rescanLibrary;
  $('#removeMissingBtn').onclick = removeMissingLibraryTracks;
  $('#librarySearch').oninput = renderLibraryTracks;
  $('#librarySort').onchange = renderLibraryTracks;
  bridge.getLibrary().then(lib => { window._libraryFolders = lib.folders || []; window._localTracks = lib.tracks || []; renderLibraryTracks(); })
    .catch(error => { $('#libraryCount').textContent = 'Could not load library'; console.error('Library load error:', error); });
}

function renderLibraryTracks() {
  const list = $('#localList'); if (!list) return;
  const all = window._localTracks || [];
  const query = ($('#librarySearch')?.value || '').trim().toLowerCase();
  const sortKey = $('#librarySort')?.value || 'title';
  const tracks = all.filter(track => [track.title, track.artist, track.album].some(value => String(value || '').toLowerCase().includes(query)));
  tracks.sort((a, b) => sortKey === 'duration' ? (a.duration || 0) - (b.duration || 0) : String(a[sortKey] || '').localeCompare(String(b[sortKey] || ''), undefined, { sensitivity: 'base' }));
  const count = $('#libraryCount'); if (count) count.textContent = tracks.length + ' of ' + all.length + ' tracks';
  if (!tracks.length) { list.innerHTML = '<div class="empty">' + (all.length ? 'No tracks match this search' : 'No local tracks yet. Add a folder to scan your music.') + '</div>'; return; }
  renderTrackList(list, tracks, 'local');
}

async function scanLocal() {
  const folder = await bridge.pickFolder(); if (!folder) return;
  const list = $('#localList'); list.innerHTML = '<div class="empty">Scanning...</div>';
  const result = await bridge.scanFolder(folder);
  if (result && result.error) { list.innerHTML = '<div class="empty">' + escHtml(result.error) + '</div>'; return; }
  window._libraryFolders = [...new Set([...(window._libraryFolders || []), folder])];
  const lib = await bridge.getLibrary(); window._localTracks = lib.tracks || []; renderLibraryTracks();
}

async function rescanLibrary() {
  const button = $('#rescanAllBtn'), list = $('#localList');
  const folders = window._libraryFolders || [];
  if (!folders.length) { showError('Add a folder to your library first'); return; }
  button.disabled = true; list.innerHTML = '<div class="empty">Rescanning saved folders...</div>';
  try {
    for (const folder of folders) {
      const result = await bridge.scanFolder(folder);
      if (result?.error) console.warn('Could not rescan folder:', folder, result.error);
    }
    const lib = await bridge.getLibrary(); window._localTracks = lib.tracks || []; renderLibraryTracks();
    showError('Library rescanned');
  } catch (error) { showError('Rescan failed: ' + error.message); }
  finally { button.disabled = false; }
}

async function removeMissingLibraryTracks() {
  const missing = await bridge.getMissingLibraryTracks();
  if (!missing.length) { showError('No missing tracks found'); return; }
  if (!window.confirm('Remove ' + missing.length + ' missing tracks from the library, favorites, playlists and queue?')) return;
  const result = await bridge.removeMissingLibraryTracks(missing.map(track => track.filepath));
  window._localTracks = result.tracks || []; renderLibraryTracks();
  showError('Removed ' + result.removed + ' missing tracks');
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

async function renderHistory() {
  contentInner.innerHTML = '<div class="library-header"><div><h2>' + icon('playlist') + ' Recently Played</h2><p class="muted">Your last 500 played tracks</p></div><button class="search-btn" id="clearHistoryBtn">Clear history</button></div><div class="track-list" id="historyList"></div>';
  const tracks = await bridge.getHistory(), list = $('#historyList');
  $('#clearHistoryBtn').onclick = async () => { if (!window.confirm('Clear your listening history?')) return; await bridge.clearHistory(); renderHistory(); };
  if (!tracks.length) return list.innerHTML = '<div class="empty">Tracks you play will appear here.</div>';
  window._historyTracks = tracks; renderTrackList(list, tracks, 'history');
}

// ========== PLAYLISTS ==========

async function renderPlaylists() {
  contentInner.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 20px 0;">
      <h2>${icon('playlist')} Playlists</h2>
      <div style="display:flex;gap:8px;">
        <button class="search-btn" id="importPlaylistLinkBtn">Import Link</button>
        <button class="search-btn" id="newPlaylistBtn">+ New</button>
      </div>
    </div>
    <div class="track-list" id="plList"></div>`;
  const pls = await bridge.getPlaylists();
  const list = $('#plList');
  $('#newPlaylistBtn').onclick = showCreatePlaylist;
  $('#importPlaylistLinkBtn').onclick = showImportPlaylistModal;
  if (!pls.length) return list.innerHTML = '<div class="empty">No playlists yet. Create or import one!</div>';
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

function showImportPlaylistModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:500px;">
      <h3>Import Playlist by Link</h3>
      <p class="muted" style="font-size:12px;margin:8px 0 14px;line-height:1.4;">
        Paste a link from <b>Yandex Music</b>, <b>YouTube / YouTube Music</b>, or <b>Spotify</b>:
      </p>
      <input id="modalImportUrl" class="search-input" placeholder="https://music.yandex.ru/... or YouTube / Spotify link" style="width:100%;box-sizing:border-box;">
      <div id="modalImportStatus" style="font-size:12px;margin-top:10px;display:none;"></div>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button class="search-btn" id="modalImportBtn">Import</button>
        <button class="search-btn" id="modalImportCancelBtn" style="background:#5b5148;border-color:#5b5148;">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  const inp = $('#modalImportUrl');
  const btn = $('#modalImportBtn');
  const status = $('#modalImportStatus');
  inp.focus();
  $('#modalImportCancelBtn').onclick = () => overlay.remove();
  const runModalImport = async () => {
    const url = inp.value.trim();
    if (!url) return showError('Please paste a valid link');
    btn.disabled = true;
    btn.textContent = 'Importing...';
    status.style.display = 'block';
    status.style.color = 'var(--gold)';
    status.textContent = 'Transferring tracks from music service...';
    try {
      const pl = await bridge.importPlaylistFromUrl(url);
      status.style.color = 'var(--green)';
      status.textContent = `Success! Transferred ${pl.trackCount} tracks.`;
      showError(`Imported "${pl.name}" (${pl.trackCount} tracks)!`);
      setTimeout(() => {
        overlay.remove();
        renderView('playlist-' + pl.id);
      }, 1000);
    } catch (err) {
      status.style.color = 'var(--red)';
      status.textContent = 'Import failed: ' + err.message;
      showError('Import failed: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  };
  btn.onclick = runModalImport;
  inp.onkeydown = e => { if (e.key === 'Enter') runModalImport(); };
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
    <div class="track-row" data-index="${i}" data-id="${escHtml(t.id)}">
      <span class="num">${i+1}</span>
      <div class="info"><span class="ttl">${escHtml(t.title)}</span><span class="art">${escHtml(t.artist)}</span></div>
      <span class="dur">${fmt(t.duration)}</span>
      <button class="track-action fav-btn" data-id="${escHtml(t.id)}" title="Favorite">${icon('heart-o')}</button>
      <button class="track-action pl-add-btn" data-id="${escHtml(t.id)}" title="Add to playlist">${icon('plus')}</button>
      <button class="track-action play-next-btn" data-id="${escHtml(t.id)}" title="Play next">↥</button>
      ${source === 'history' ? `<button class="track-action history-remove-btn" data-id="${escHtml(t.id)}" title="Remove from history">${icon('close')}</button>` : ''}
    </div>`).join('');

  container.onclick = async (e) => {
    const row = e.target.closest('.track-row');
    if (!row) return;
    const idx = parseInt(row.dataset.index);

    // Remove from history button
    if (e.target.classList.contains('history-remove-btn') || e.target.closest('.history-remove-btn')) {
      const track = tracks[idx];
      await bridge.removeHistoryTrack(track.id);
      tracks.splice(idx, 1);
      window._historyTracks = tracks;
      row.remove();
      container.querySelectorAll('.track-row').forEach((r, i) => {
        r.dataset.index = i;
        const numEl = r.querySelector('.num');
        if (numEl) numEl.textContent = i + 1;
      });
      if (!tracks.length) {
        container.innerHTML = '<div class="empty">Tracks you play will appear here.</div>';
      }
      return;
    }
    
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
    
    if (e.target.classList.contains('play-next-btn') || e.target.closest('.play-next-btn')) { playNextTrack(tracks[idx]); return; }

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
    else if (source === 'playlist' || source === 'history') {
      if (source === 'playlist') window._plTracks = tracks;
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
  return /^(https:\/\/|data:image\/|cover:\/\/)/i.test(url) ? escHtml(url) : '';
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
  if (!currentTrack) {
    npArt.removeAttribute('src');
    npTitle.textContent = 'Nothing playing';
    npArtist.textContent = 'Choose a track to begin';
    npArt.classList.remove('playing');
    playBtn.innerHTML = icon('play');
    seekFill.style.width = '0%'; curTime.textContent = '0:00'; totTime.textContent = '0:00';
    seekBar.style.cursor = 'default';
    renderQueue(); syncHomePlayer(); updatePetState();
    if (window.updateMobileMediaSession) window.updateMobileMediaSession(null, false);
    return;
  }
  npArt.src = safeArtwork(currentTrack.artwork);
  npTitle.textContent = currentTrack.title || '';
  npArtist.textContent = currentTrack.artist || '';
  playBtn.innerHTML = isPlaying ? icon('pause') : icon('play');
  seekBar.style.cursor = audio.duration && isFinite(audio.duration) ? 'pointer' : 'default';
  npArt.classList.toggle('playing', isPlaying);
  const artCont = npArt.closest('.art-container');
  if (artCont) artCont.classList.toggle('playing', isPlaying);
  renderQueue();
  syncHomePlayer();
  updatePetState();
  if (window.updateMobileMediaSession) window.updateMobileMediaSession(currentTrack, isPlaying);
  window.mintpyLyrics?.onTrackChange(currentTrack);
}

function renderQueue() {
  queueList.innerHTML = queue.slice(currentIndex + 1).map((track, offset) => {
    const index = currentIndex + 1 + offset;
    return '<div class="queue-item" data-queue-index="' + index + '"><img src="' + safeArtwork(track.artwork) + '" alt=""><div class="qi-info"><div class="qi-ttl">' + escHtml(track.title) + '</div><div class="qi-art">' + escHtml(track.artist) + '</div></div><div class="queue-actions"><button class="queue-action" data-queue-action="up" title="Move up" ' + (offset === 0 ? 'disabled' : '') + '>↑</button><button class="queue-action" data-queue-action="down" title="Move down" ' + (index === queue.length - 1 ? 'disabled' : '') + '>↓</button><button class="queue-action remove" data-queue-action="remove" title="Remove">×</button></div></div>';
  }).join('') || '<div class="muted" style="padding:20px;text-align:center;">Queue empty</div>';
  queueList.onclick = event => {
    const button = event.target.closest('[data-queue-action]');
    if (button) {
      const index = Number(button.closest('.queue-item').dataset.queueIndex);
      if (button.dataset.queueAction === 'up') changeQueueItem(index, -1);
      else if (button.dataset.queueAction === 'down') changeQueueItem(index, 1);
      else removeQueueItem(index);
      return;
    }
    const item = event.target.closest('.queue-item');
    if (item) playTrackFromQueue(Number(item.dataset.queueIndex));
  };
}
function playTrackFromQueue(idx) { playTrack(queue[idx], idx); }

function fmt(s) { if (!s) return '0:00'; const m = Math.floor(s/60), sec = Math.floor(s%60); return `${m}:${sec<10?'0':''}${sec}`; }
