// ============================================================================
// MintPy Mobile Bridge Facade (Non-Blocking Native HTTP, MediaSession & API)
// ============================================================================
(function () {
  'use strict';

  const Store = window.MintPyMobileStorage;
  const KEYS = Store.KEYS;
  const mediaCommandListeners = [];
  const localBlobTracks = new Map();

  // --- Non-blocking Async Java Network Bridge ---
  const pendingNativeReqs = new Map();
  let nativeReqSeq = 0;

  window.__mintpyNativeCb = function (reqId, okOrPayload, errMsg) {
    const entry = pendingNativeReqs.get(reqId);
    if (!entry) {
      if (okOrPayload === true && window.AndroidNative && typeof window.AndroidNative.takeAsyncResult === 'function') {
        try { window.AndroidNative.takeAsyncResult(reqId); } catch {}
      }
      return;
    }
    pendingNativeReqs.delete(reqId);
    clearTimeout(entry.timer);

    if (typeof okOrPayload === 'boolean') {
      if (okOrPayload) {
        let body = null;
        try {
          body = window.AndroidNative && typeof window.AndroidNative.takeAsyncResult === 'function'
            ? window.AndroidNative.takeAsyncResult(reqId)
            : null;
        } catch {}
        if (body != null) entry.resolve(body);
        else entry.reject(new Error('Empty native result'));
      } else {
        entry.reject(new Error(errMsg || 'Native HTTP request failed'));
      }
      return;
    }

    if (okOrPayload && okOrPayload.ok && okOrPayload.body != null) {
      entry.resolve(okOrPayload.body);
    } else {
      entry.reject(new Error((okOrPayload && okOrPayload.error) || 'Native HTTP request failed'));
    }
  };

  function nativeAndroidRequest(method, url, bodyStr, headersObj) {
    return new Promise((resolve, reject) => {
      const reqId = 'r_' + (++nativeReqSeq);
      const timer = setTimeout(() => {
        pendingNativeReqs.delete(reqId);
        try { window.AndroidNative?.takeAsyncResult?.(reqId); } catch {}
        reject(new Error('Native HTTP timeout'));
      }, 15000);
      pendingNativeReqs.set(reqId, { resolve, reject, timer });
      try {
        window.AndroidNative.requestAsync(reqId, method, url, bodyStr || '', headersObj ? JSON.stringify(headersObj) : '');
      } catch (e) {
        clearTimeout(timer);
        pendingNativeReqs.delete(reqId);
        reject(e);
      }
    });
  }

  function nativeProbeStreamAsync(url, userAgent) {
    return new Promise((resolve) => {
      const reqId = 'p_' + (++nativeReqSeq);
      const timer = setTimeout(() => {
        pendingNativeReqs.delete(reqId);
        try { window.AndroidNative?.takeAsyncResult?.(reqId); } catch {}
        resolve(false);
      }, 8500);
      pendingNativeReqs.set(reqId, {
        resolve: (val) => {
          const code = parseInt(val, 10);
          resolve(code === 200 || code === 206);
        },
        reject: () => resolve(false),
        timer
      });
      try {
        window.AndroidNative.probeStreamAsync(reqId, url, userAgent || '');
      } catch {
        clearTimeout(timer);
        pendingNativeReqs.delete(reqId);
        resolve(false);
      }
    });
  }

  const net = {
    async postJson(url, bodyObj, headersObj) {
      const jsonStr = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
      if (window.AndroidNative && typeof window.AndroidNative.requestAsync === 'function') {
        const raw = await nativeAndroidRequest('POST', url, jsonStr, headersObj);
        if (!raw) throw new Error('Empty response from native HTTP');
        return JSON.parse(raw);
      }
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', ...(headersObj || {}) };
      const opts = { method: 'POST', headers, body: jsonStr };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(7000);
      const resp = await fetch(url, opts);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    },

    async getUrl(url, headersObj) {
      if (window.AndroidNative && typeof window.AndroidNative.requestAsync === 'function') {
        try {
          return (await nativeAndroidRequest('GET', url, '', headersObj)) || '';
        } catch {
          return '';
        }
      }
      try {
        const opts = { headers: headersObj || {} };
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(7000);
        const resp = await fetch(url, opts);
        return resp.ok ? await resp.text() : '';
      } catch {
        return '';
      }
    },

    hasStreamProbe() {
      return !!(window.AndroidNative && typeof window.AndroidNative.probeStreamAsync === 'function');
    },

    async probeStream(url, userAgent) {
      if (!url) return false;
      if (window.AndroidNative && typeof window.AndroidNative.probeStreamAsync === 'function') {
        return await nativeProbeStreamAsync(url, userAgent);
      }
      return true;
    },

    wrapProxyStream(url, userAgent, mimeType) {
      if (!url) return '';
      if (window.AndroidNative && typeof window.AndroidNative.registerProxyStream === 'function') {
        try {
          const proxied = window.AndroidNative.registerProxyStream(url, userAgent || '', mimeType || 'video/mp4');
          if (proxied) return proxied;
        } catch {}
      }
      return url;
    }
  };

  const yt = window.MintPyMobileYouTube.createYouTubeResolver(net);
  const importer = window.MintPyMobileImporters.createPlaylistImporter(net);

  // --- Android Lockscreen & Notification MediaSession ---
  function setupMediaSession() {
    let lastActiveTrack = null;
    let lastPlayingState = false;
    let lastNativeSessionSig = '';
    let lastNativePosSyncTs = 0;

    window.__mintpyNativeMediaAction = function (action, arg) {
      if (action === 'play') mediaCommandListeners.forEach((fn) => fn('play'));
      else if (action === 'pause') mediaCommandListeners.forEach((fn) => fn('pause'));
      else if (action === 'next') mediaCommandListeners.forEach((fn) => fn('next-track'));
      else if (action === 'prev') mediaCommandListeners.forEach((fn) => fn('prev-track'));
      else if (action === 'seekto') mediaCommandListeners.forEach((fn) => fn('seek-to', Number(arg) / 1000));
      else if (action === 'stop') mediaCommandListeners.forEach((fn) => fn('stop'));
    };

    window.updateMobileMediaSession = function (track, isPlaying, positionSec) {
      if (!track) return;
      lastActiveTrack = track;
      lastPlayingState = !!isPlaying;
      const dur = Number(track.duration) || 0;
      const pos = Number(positionSec) || 0;
      const sig = `${track.id || track.title}|${lastPlayingState ? 1 : 0}|${Math.round(dur)}|${track.artwork || ''}`;

      if (sig !== lastNativeSessionSig && window.AndroidNative?.updateNativeMediaSession) {
        lastNativeSessionSig = sig;
        lastNativePosSyncTs = Date.now();
        try {
          window.AndroidNative.updateNativeMediaSession(
            track.title || 'MintPy',
            track.artist || '',
            track.album || 'MintPy',
            track.artwork || '',
            dur,
            lastPlayingState,
            pos
          );
        } catch {}
      }

      if (!('mediaSession' in navigator)) return;
      try {
        const artSrc = track.artwork || '../assets/mintpy-logo.png';
        const sizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title || 'MintPy',
          artist: track.artist || 'Zen Music Player',
          album: track.album || 'MintPy',
          artwork: sizes.map((size) => ({ src: artSrc, sizes: size, type: 'image/png' }))
        });
        navigator.mediaSession.playbackState = lastPlayingState ? 'playing' : 'paused';
      } catch {}
    };

    window.updateMobilePositionState = function (state, force) {
      if (!state) return;
      const positionSec = Number(state.position) || 0;
      const durationSec = Number(state.duration) || (lastActiveTrack ? Number(lastActiveTrack.duration) || 0 : 0);

      if (window.AndroidNative && typeof window.AndroidNative.updateNativePlaybackPosition === 'function') {
        const now = Date.now();
        if (force === true || now - lastNativePosSyncTs >= 15000) {
          lastNativePosSyncTs = now;
          try { window.AndroidNative.updateNativePlaybackPosition(positionSec, durationSec, lastPlayingState); } catch {}
        }
      }

      if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
        try {
          if (durationSec > 0 && positionSec >= 0 && positionSec <= durationSec) {
            navigator.mediaSession.setPositionState({
              duration: durationSec,
              playbackRate: Number(state.playbackRate) || 1.0,
              position: positionSec
            });
          }
        } catch {}
      }
    };

    if (!('mediaSession' in navigator)) return;
    const actions = [
      ['play', () => mediaCommandListeners.forEach((fn) => fn('play'))],
      ['pause', () => mediaCommandListeners.forEach((fn) => fn('pause'))],
      ['previoustrack', () => mediaCommandListeners.forEach((fn) => fn('prev-track'))],
      ['nexttrack', () => mediaCommandListeners.forEach((fn) => fn('next-track'))],
      ['seekto', (d) => { if (d && isFinite(d.seekTime)) mediaCommandListeners.forEach((fn) => fn('seek-to', d.seekTime)); }],
      ['seekforward', (d) => mediaCommandListeners.forEach((fn) => fn('seek-by', (d && isFinite(d.seekOffset)) ? d.seekOffset : 10))],
      ['seekbackward', (d) => mediaCommandListeners.forEach((fn) => fn('seek-by', (d && isFinite(d.seekOffset)) ? -Math.abs(d.seekOffset) : -10))],
      ['stop', () => mediaCommandListeners.forEach((fn) => fn('stop'))]
    ];
    actions.forEach(([action, handler]) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
    });
  }

  // --- Public Mobile window.api ---
  window.api = {
    isMobile: true,
    ready: Store.ready,
    win: () => {},
    fetchText: (url) => net.getUrl(url),

    searchTracks: (query) => yt.searchTracks(query),
    getTrackAudioUrl: (track) => yt.resolveStreamUrl(track, localBlobTracks),
    prefetchTrack: (track) => {
      if (!track || track.source === 'local') return;
      yt.resolveStreamUrl(track, localBlobTracks).catch(() => {});
    },
    invalidateTrackStream: (trackId) => yt.invalidateStream(trackId),

    resolveSearchTrack: async (track) => {
      const results = await yt.searchTracks(`${track.artist || ''} - ${track.title || ''}`);
      return (results && results.length > 0) ? results[0] : track;
    },

    isFavoriteSync: (trackId) => {
      if (!trackId) return false;
      const favs = Store.getSync(KEYS.FAVORITES, []);
      return favs.some((f) => f.id === trackId);
    },

    pickFolder: () => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = 'audio/*';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = async () => {
        const files = Array.from(input.files || []);
        input.remove();
        if (!files.length) { resolve(null); return; }
        const tracks = files.map((file, idx) => {
          const blobUrl = URL.createObjectURL(file);
          const id = `local:${file.name}_${file.size}_${Date.now()}_${idx}`;
          localBlobTracks.set(id, blobUrl);
          const nameParts = file.name.replace(/\.[^.]+$/, '').split(' - ');
          const artist = nameParts.length > 1 ? nameParts[0].trim() : 'Local Audio';
          const title = nameParts.length > 1 ? nameParts.slice(1).join(' - ').trim() : file.name.replace(/\.[^.]+$/, '');
          return {
            id,
            filepath: id,
            title,
            artist,
            album: 'Mobile Storage',
            artwork: '../assets/mintpy-logo.png',
            duration: 0,
            source: 'local',
            directUrl: blobUrl
          };
        });
        const lib = await Store.getAsync(KEYS.LIBRARY, { folders: ['Phone Storage'], tracks: [] });
        lib.tracks = [...tracks, ...lib.tracks];
        Store.set(KEYS.LIBRARY, lib);
        resolve('Phone Storage');
      };
      input.click();
    }),

    getFavorites: () => Store.getAsync(KEYS.FAVORITES, []),
    addFavorite: async (track) => {
      const favs = await Store.getAsync(KEYS.FAVORITES, []);
      if (!favs.some((f) => f.id === track.id)) {
        favs.push(track);
        Store.set(KEYS.FAVORITES, favs);
      }
      return favs;
    },
    removeFavorite: async (trackId) => {
      const favs = (await Store.getAsync(KEYS.FAVORITES, [])).filter((f) => f.id !== trackId);
      Store.set(KEYS.FAVORITES, favs);
      return favs;
    },

    getPlaylists: () => Store.getAsync(KEYS.PLAYLISTS, []),
    createPlaylist: async (name) => {
      const pl = await Store.getAsync(KEYS.PLAYLISTS, []);
      const item = { id: 'pl_' + Date.now(), name: name || 'Playlist', tracks: [] };
      pl.push(item);
      Store.set(KEYS.PLAYLISTS, pl);
      return item;
    },
    deletePlaylist: async (playlistId) => {
      const pl = (await Store.getAsync(KEYS.PLAYLISTS, [])).filter((p) => p.id !== playlistId);
      Store.set(KEYS.PLAYLISTS, pl);
      return true;
    },
    getPlaylistTracks: async (playlistId) => {
      const pl = await Store.getAsync(KEYS.PLAYLISTS, []);
      return pl.find((p) => p.id === playlistId)?.tracks || [];
    },
    addToPlaylist: async (playlistId, track) => {
      const pl = await Store.getAsync(KEYS.PLAYLISTS, []);
      const found = pl.find((p) => p.id === playlistId);
      if (found && !found.tracks.some((t) => t.id === track.id)) {
        found.tracks.push(track);
        Store.set(KEYS.PLAYLISTS, pl);
      }
      return found?.tracks || [];
    },
    removeFromPlaylist: async (playlistId, trackId) => {
      const pl = await Store.getAsync(KEYS.PLAYLISTS, []);
      const found = pl.find((p) => p.id === playlistId);
      if (found) {
        found.tracks = found.tracks.filter((t) => t.id !== trackId);
        Store.set(KEYS.PLAYLISTS, pl);
      }
      return found?.tracks || [];
    },

    importPlaylistFromUrl: async (url) => {
      const result = await importer.importFromUrl(url);
      const pls = await Store.getAsync(KEYS.PLAYLISTS, []);
      const newPl = {
        id: 'pl_' + Date.now(),
        name: result.name || 'Импортированный плейлист',
        tracks: result.tracks
      };
      pls.push(newPl);
      Store.set(KEYS.PLAYLISTS, pls);
      return {
        id: newPl.id,
        name: newPl.name,
        trackCount: newPl.tracks.length,
        tracks: newPl.tracks
      };
    },

    getSettings: () => Store.getAsync(KEYS.SETTINGS, {
      appearance: 'dark',
      style: 'zen',
      volumeNormalize: false,
      eqBands: { low: 0, mid: 0, high: 0 },
      crossfadeSeconds: 5,
      auraIntensity: 0.35,
      playbackSpeed: 1.0
    }),
    saveSettings: async (settings) => {
      Store.set(KEYS.SETTINGS, settings);
      return true;
    },

    getPlaybackState: () => Store.getAsync(KEYS.QUEUE, { queue: [], currentIndex: -1 }),
    savePlaybackState: async (state) => {
      Store.set(KEYS.QUEUE, state);
      return true;
    },

    getHistory: () => Store.getAsync(KEYS.HISTORY, []),
    recordHistory: async (track) => {
      if (!track) return true;
      let hist = (await Store.getAsync(KEYS.HISTORY, [])).filter((t) => t.id !== track.id);
      hist.unshift(track);
      if (hist.length > 300) hist = hist.slice(0, 300);
      Store.set(KEYS.HISTORY, hist);
      return true;
    },
    clearHistory: async () => {
      Store.set(KEYS.HISTORY, []);
      return true;
    },
    removeHistoryTrack: async (trackId) => {
      const hist = (await Store.getAsync(KEYS.HISTORY, [])).filter((t) => t.id !== trackId);
      Store.set(KEYS.HISTORY, hist);
      return true;
    },

    exportBackup: async () => {
      const dump = {
        format: 'mintpy-mobile-backup',
        version: 2,
        settings: await Store.getAsync(KEYS.SETTINGS, {}),
        favorites: await Store.getAsync(KEYS.FAVORITES, []),
        playlists: await Store.getAsync(KEYS.PLAYLISTS, []),
        history: await Store.getAsync(KEYS.HISTORY, [])
      };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mintpy-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      return { ok: true };
    },

    importBackup: () => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) { resolve({ canceled: true }); return; }
        try {
          const parsed = JSON.parse(await file.text());
          const src = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
          if (src.settings) Store.set(KEYS.SETTINGS, src.settings);
          if (Array.isArray(src.favorites)) Store.set(KEYS.FAVORITES, src.favorites);
          if (Array.isArray(src.playlists)) Store.set(KEYS.PLAYLISTS, src.playlists);
          if (Array.isArray(src.history)) Store.set(KEYS.HISTORY, src.history);
          Store.flushNow();
          resolve({ ok: true });
          setTimeout(() => window.location.reload(), 150);
        } catch (e) {
          resolve({ error: e.message });
        }
      };
      input.click();
    }),

    onMediaCommand: (callback) => {
      mediaCommandListeners.push(callback);
    }
  };

  setupMediaSession();
})();
