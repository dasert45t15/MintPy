// MintPy Mobile Bridge (Android WebView & Mobile Web)
// Replaces Electron's preload.js IPC bridge when running on mobile.

(function () {
  if (window.api) return; // Desktop Electron already provided window.api

  const STORAGE_KEY = 'mintpy_mobile_data';
  const SETTINGS_KEY = 'mintpy_settings';
  const HISTORY_KEY = 'mintpy_history';
  const FAVORITES_KEY = 'mintpy_favorites';
  const PLAYLISTS_KEY = 'mintpy_playlists';
  const QUEUE_KEY = 'mintpy_queue';

  function getLocalJson(key, def) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : def;
    } catch {
      return def;
    }
  }

  function setLocalJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn('Storage write failed:', e);
    }
  }

  // MediaSession integration for Android lockscreen and notification player
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;

    window.updateMobileMediaSession = function (track, isPlaying) {
      if (!track) return;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title || 'MintPy',
          artist: track.artist || 'Zen Music Player',
          album: track.album || 'MintPy',
          artwork: [
            { src: track.artwork || '../assets/mintpy-logo.png', sizes: '512x512', type: 'image/png' }
          ]
        });
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
      } catch (e) {
        console.warn('MediaSession error:', e);
      }
    };

    const actions = [
      ['play', () => mediaCommandListeners.forEach(fn => fn('play-pause'))],
      ['pause', () => mediaCommandListeners.forEach(fn => fn('play-pause'))],
      ['previoustrack', () => mediaCommandListeners.forEach(fn => fn('prev-track'))],
      ['nexttrack', () => mediaCommandListeners.forEach(fn => fn('next-track'))],
    ];

    actions.forEach(([action, handler]) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {}
    });
  }

  const mediaCommandListeners = [];

  async function nativePostJson(url, bodyObj, headersObj) {
    const jsonStr = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
    const headersJson = headersObj ? JSON.stringify(headersObj) : null;
    if (window.AndroidNative) {
      if (headersJson && typeof window.AndroidNative.postJsonWithHeaders === 'function') {
        try {
          const raw = window.AndroidNative.postJsonWithHeaders(url, jsonStr, headersJson);
          if (raw) return JSON.parse(raw);
        } catch (e) {
          console.warn('AndroidNative.postJsonWithHeaders error:', e);
        }
      } else if (typeof window.AndroidNative.postJson === 'function') {
        try {
          const raw = window.AndroidNative.postJson(url, jsonStr);
          if (raw) return JSON.parse(raw);
        } catch (e) {
          console.warn('AndroidNative.postJson error:', e);
        }
      }
    }
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', ...(headersObj || {}) };
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: jsonStr
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  }

  async function nativeGetUrl(url, headersObj) {
    const headersJson = headersObj ? JSON.stringify(headersObj) : null;
    if (window.AndroidNative) {
      if (headersJson && typeof window.AndroidNative.getUrlWithHeaders === 'function') {
        try {
          const raw = window.AndroidNative.getUrlWithHeaders(url, headersJson);
          if (raw) return raw;
        } catch (e) {
          console.warn('AndroidNative.getUrlWithHeaders error:', e);
        }
      } else if (typeof window.AndroidNative.getUrl === 'function') {
        try {
          const raw = window.AndroidNative.getUrl(url);
          if (raw) return raw;
        } catch (e) {
          console.warn('AndroidNative.getUrl error:', e);
        }
      }
    }
    const resp = await fetch(url, { headers: headersObj || {} });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  }

  // Cache YouTube visitor credentials for reliable Innertube playback
  let cachedVisitorId = '';
  let cachedVisitorCookies = '';
  let cookiesExpireAt = 0;

  async function getVisitorCredentials() {
    if (cachedVisitorId && Date.now() < cookiesExpireAt) {
      return { visitorId: cachedVisitorId, cookies: cachedVisitorCookies };
    }
    try {
      const pageHtml = await nativeGetUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      if (pageHtml) {
        const m = pageHtml.match(/"VISITOR_DATA":"([^"]+)"/);
        if (m) cachedVisitorId = m[1];
      }
      cookiesExpireAt = Date.now() + 1000 * 3600 * 4; // 4 hours
    } catch (e) {
      console.warn('Visitor credential fetch notice:', e);
    }
    return { visitorId: cachedVisitorId, cookies: cachedVisitorCookies };
  }

  // Local files cache for mobile
  const localBlobTracks = new Map();

  window.api = {
    isMobile: true,
    win: () => {},

    searchTracks: async (query) => {
      if (!query || typeof query !== 'string') return [];
      const cleanQ = query.trim();
      if (!cleanQ) return [];

      // 1. YouTube Innertube search (Direct & Instant via native Java bridge or fetch)
      try {
        const data = await nativePostJson('https://www.youtube.com/youtubei/v1/search', {
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20240101.00.00',
              hl: 'ru',
              gl: 'RU'
            }
          },
          query: cleanQ
        });

        const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        const tracks = [];
        for (const sec of sections) {
          const items = sec?.itemSectionRenderer?.contents || [];
          for (const it of items) {
            const v = it.videoRenderer;
            if (!v || !v.videoId) continue;
            const title = v.title?.runs?.[0]?.text || v.title?.simpleText || '';
            const artist = v.ownerText?.runs?.[0]?.text || 'YouTube';
            const thumbs = v.thumbnail?.thumbnails || [];
            const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : '';
            const durStr = v.lengthText?.simpleText || '';
            let duration = 0;
            if (durStr) {
              const parts = durStr.split(':').map(Number);
              if (parts.length === 2) duration = parts[0] * 60 + parts[1];
              else if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
            tracks.push({
              id: `yt:${v.videoId}`,
              title,
              artist,
              artwork: thumb,
              duration,
              source: 'youtube'
            });
            if (tracks.length >= 25) break;
          }
          if (tracks.length >= 25) break;
        }
        if (tracks.length > 0) return tracks;
      } catch (err) {
        console.warn('Innertube search error, falling back:', err);
      }

      // 2. Fallback: YouTube Suggest Queries + Search scraper
      try {
        const rawJson = await nativeGetUrl(`https://suggestqueries-clients6.youtube.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(cleanQ)}`);
        const parsed = JSON.parse(rawJson);
        const suggestions = Array.isArray(parsed?.[1]) ? parsed[1] : [];
        if (suggestions.length > 0) {
          // Generate quick search entries from YouTube suggest
          return suggestions.slice(0, 15).map((s, idx) => ({
            id: `yt:search_${encodeURIComponent(s)}_${idx}`,
            title: s,
            artist: 'YouTube Music',
            artwork: '../assets/mintpy-logo.png',
            duration: 0,
            source: 'youtube'
          }));
        }
      } catch (e) {
        console.warn('Suggest fallback error:', e);
      }

      return [];
    },

    getTrackAudioUrl: async (track) => {
      if (!track) return '';
      if (track.directUrl) return track.directUrl;
      if (track.source === 'local') {
        const cached = localBlobTracks.get(track.filepath || track.id);
        if (cached) return cached;
      }
      let videoId = String(track.id || '').replace(/^yt:/, '');
      if (!videoId) return '';

      // If it's a search query placeholder (e.g. ytsearch:...)
      if (videoId.startsWith('search_') || videoId.startsWith('ytsearch:')) {
        const cleanQ = videoId.replace(/^search_/, '').replace(/^ytsearch:/, '');
        const found = await window.api.searchTracks(decodeURIComponent(cleanQ));
        if (found && found.length && found[0].id) {
          videoId = String(found[0].id).replace(/^yt:/, '');
          track.id = `yt:${videoId}`;
        }
      }

      // 1. YouTube Innertube with VISIONOS client + visitor credentials
      try {
        const { visitorId, cookies } = await getVisitorCredentials();
        const headers = {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
          'X-Youtube-Client-Name': '101',
          'X-Youtube-Client-Version': '1.02',
          'Origin': 'https://www.youtube.com'
        };
        if (visitorId) headers['X-Goog-Visitor-Id'] = visitorId;
        if (cookies) headers['Cookie'] = cookies;

        const payload = {
          context: {
            client: {
              clientName: 'VISIONOS',
              clientVersion: '1.02',
              deviceMake: 'Apple',
              deviceModel: 'RealityDevice17,1',
              userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
              osName: 'visionOS',
              osVersion: '26.5.23O471',
              hl: 'en',
              gl: 'US'
            }
          },
          videoId: videoId,
          playbackContext: {
            contentPlaybackContext: {
              html5Preference: 'HTML5_PREF_WANTS'
            }
          },
          contentCheckOk: true,
          racyCheckOk: true
        };

        const json = await nativePostJson('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', payload, headers);
        const formats = json?.streamingData?.adaptiveFormats || [];
        const audioFormats = formats
          .filter(f => (f.mimeType || '').startsWith('audio/') && f.url)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        if (audioFormats.length > 0) {
          const aac = audioFormats.find(f => (f.mimeType || '').includes('audio/mp4')) || audioFormats[0];
          track.directUrl = aac.url;
          return aac.url;
        }
      } catch (err) {
        console.warn('Innertube VISIONOS resolve error:', err);
      }

      // 2. YouTube Innertube with ANDROID_VR client
      try {
        const payload = {
          context: {
            client: {
              clientName: 'ANDROID_VR',
              clientVersion: '1.60.19',
              deviceMake: 'Oculus',
              deviceModel: 'Quest 3',
              osName: 'Android',
              hl: 'en',
              gl: 'US'
            }
          },
          videoId: videoId
        };
        const json = await nativePostJson('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', payload);
        const formats = json?.streamingData?.adaptiveFormats || [];
        const audioFormats = formats
          .filter(f => (f.mimeType || '').startsWith('audio/') && f.url)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        if (audioFormats.length > 0) {
          const aac = audioFormats.find(f => (f.mimeType || '').includes('audio/mp4')) || audioFormats[0];
          track.directUrl = aac.url;
          return aac.url;
        }
      } catch (err) {
        console.warn('Innertube ANDROID_VR resolve error:', err);
      }

      // 3. Fallback to public Invidious instances
      const invidiousHosts = [
        'https://inv.tux.pizza',
        'https://invidious.nerdvpn.de',
        'https://iv.melmac.space',
        'https://yt.artemislena.eu'
      ];
      for (const host of invidiousHosts) {
        try {
          const raw = await nativeGetUrl(`${host}/api/v1/videos/${encodeURIComponent(videoId)}`);
          if (raw) {
            const parsed = JSON.parse(raw);
            const aFormats = (parsed.adaptiveFormats || []).filter(f => (f.type || '').startsWith('audio/') && f.url);
            if (aFormats.length > 0) {
              const u = aFormats[0].url.startsWith('http') ? aFormats[0].url : `${host}${aFormats[0].url}`;
              track.directUrl = u;
              return u;
            }
          }
        } catch (e) {}
      }

      return '';
    },

    pickFolder: async () => {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = 'audio/*';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.onchange = () => {
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
              album: 'Mobile Library',
              artwork: '../assets/mintpy-logo.png',
              duration: 0,
              source: 'local',
              directUrl: blobUrl
            };
          });
          const lib = getLocalJson('mintpy_library', { folders: ['Phone Storage'], tracks: [] });
          lib.tracks = [...tracks, ...lib.tracks];
          setLocalJson('mintpy_library', lib);
          resolve('Phone Storage');
        };
        input.click();
      });
    },

    scanFolder: async () => {
      const lib = getLocalJson('mintpy_library', { folders: [], tracks: [] });
      return lib.tracks || [];
    },

    onScanProgress: (callback) => {
      setTimeout(() => callback('done'), 100);
      return () => {};
    },

    getFavorites: async () => getLocalJson(FAVORITES_KEY, []),
    addFavorite: async (track) => {
      const favs = getLocalJson(FAVORITES_KEY, []);
      if (!favs.some(f => f.id === track.id)) {
        favs.push(track);
        setLocalJson(FAVORITES_KEY, favs);
      }
      return favs;
    },
    removeFavorite: async (trackId) => {
      let favs = getLocalJson(FAVORITES_KEY, []);
      favs = favs.filter(f => f.id !== trackId);
      setLocalJson(FAVORITES_KEY, favs);
      return favs;
    },

    getPlaylists: async () => getLocalJson(PLAYLISTS_KEY, []),
    createPlaylist: async (name) => {
      const pl = getLocalJson(PLAYLISTS_KEY, []);
      const item = { id: 'pl_' + Date.now(), name: name || 'Playlist', tracks: [] };
      pl.push(item);
      setLocalJson(PLAYLISTS_KEY, pl);
      return item;
    },
    deletePlaylist: async (playlistId) => {
      let pl = getLocalJson(PLAYLISTS_KEY, []);
      pl = pl.filter(p => p.id !== playlistId);
      setLocalJson(PLAYLISTS_KEY, pl);
      return true;
    },
    getPlaylistTracks: async (playlistId) => {
      const pl = getLocalJson(PLAYLISTS_KEY, []);
      const found = pl.find(p => p.id === playlistId);
      return found?.tracks || [];
    },
    addToPlaylist: async (playlistId, track) => {
      const pl = getLocalJson(PLAYLISTS_KEY, []);
      const found = pl.find(p => p.id === playlistId);
      if (found && !found.tracks.some(t => t.id === track.id)) {
        found.tracks.push(track);
        setLocalJson(PLAYLISTS_KEY, pl);
      }
      return found?.tracks || [];
    },
    removeFromPlaylist: async (playlistId, trackId) => {
      const pl = getLocalJson(PLAYLISTS_KEY, []);
      const found = pl.find(p => p.id === playlistId);
      if (found) {
        found.tracks = found.tracks.filter(t => t.id !== trackId);
        setLocalJson(PLAYLISTS_KEY, pl);
      }
      return found?.tracks || [];
    },

    importPlaylistFromUrl: async (url) => {
      // Direct Yandex Music playlist import in browser/mobile WebView
      try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        let user = '', kind = '';
        const plIdx = parts.indexOf('playlists');
        if (plIdx >= 0 && parts[plIdx + 1]) {
          kind = parts[plIdx + 1];
          user = parts[plIdx - 1] || 'users';
        }
        if (kind) {
          const apiResp = await fetch(`https://music.yandex.ru/handlers/playlist.jsx?owner=${encodeURIComponent(user)}&kinds=${encodeURIComponent(kind)}`);
          if (apiResp.ok) {
            const data = await apiResp.json();
            const pl = data.playlist || {};
            const rawTracks = pl.tracks || [];
            const tracks = rawTracks.map(t => {
              const artists = (t.artists || []).map(a => a.name).join(', ') || 'Unknown Artist';
              const art = t.coverUri ? 'https://' + t.coverUri.replace('%%', '400x400') : '';
              return {
                id: `yt:ytsearch:${artists} - ${t.title}`,
                title: t.title,
                artist: artists,
                album: t.albums?.[0]?.title || '',
                artwork: art,
                duration: Math.round((t.durationMs || 0) / 1000),
                source: 'youtube'
              };
            });
            return {
              title: pl.title || 'Yandex Playlist',
              tracks
            };
          }
        }
      } catch (e) {
        console.warn('Direct Yandex import failed, error:', e);
      }
      throw new Error('Не удалось импортировать плейлист. Проверьте ссылку.');
    },

    resolveSearchTrack: async (track) => {
      const q = `${track.artist} - ${track.title}`;
      const results = await window.api.searchTracks(q);
      if (results && results.length > 0) {
        return results[0];
      }
      return track;
    },

    getSettings: async () => getLocalJson(SETTINGS_KEY, {
      opacity: 1, auraIntensity: .35, compactMode: false, appearance: 'system',
      accentColor: 'blue-purple', customColor: '', cornerRadius: 20, keybinds: {},
      style: 'zen', pet: '', petSize: 84, petPos: null, volumeNormalize: false,
      eqBands: { low: 0, mid: 0, high: 0 }, crossfadeSeconds: 0, setupCompleted: false
    }),
    saveSettings: async (settings) => {
      setLocalJson(SETTINGS_KEY, settings);
      return true;
    },
    setupComplete: async (options = {}) => {
      const s = getLocalJson(SETTINGS_KEY, {});
      s.setupCompleted = true;
      if (options.style) s.style = options.style;
      if (options.theme) s.appearance = options.theme;
      setLocalJson(SETTINGS_KEY, s);
      return { ok: true, settings: s };
    },
    setupSetWindowMode: async () => ({ ok: true }),

    setOpacity: () => {},
    setGlobalMute: async () => ({ ok: true }),
    onGlobalMute: () => {},
    checkYtDlp: async () => true,
    getStreamInfo: async () => ({ base: '', token: '' }),

    getLibrary: async () => getLocalJson('mintpy_library', { folders: ['Phone Storage'], tracks: [] }),
    getMissingLibraryTracks: async () => [],
    removeMissingLibraryTracks: async () => ({ removed: 0, tracks: [] }),

    getPlaybackState: async () => getLocalJson(QUEUE_KEY, { queue: [], currentIndex: -1 }),
    savePlaybackState: async (state) => {
      setLocalJson(QUEUE_KEY, state);
      return true;
    },

    getHistory: async () => getLocalJson(HISTORY_KEY, []),
    recordHistory: async (track) => {
      if (!track) return true;
      let hist = getLocalJson(HISTORY_KEY, []);
      hist = hist.filter(t => t.id !== track.id);
      hist.unshift(track);
      if (hist.length > 100) hist = hist.slice(0, 100);
      setLocalJson(HISTORY_KEY, hist);
      return true;
    },
    clearHistory: async () => {
      setLocalJson(HISTORY_KEY, []);
      return true;
    },
    removeHistoryTrack: async (trackId) => {
      let hist = getLocalJson(HISTORY_KEY, []);
      hist = hist.filter(t => t.id !== trackId);
      setLocalJson(HISTORY_KEY, hist);
      return true;
    },

    exportBackup: async () => {
      const dump = {
        settings: getLocalJson(SETTINGS_KEY, {}),
        favorites: getLocalJson(FAVORITES_KEY, []),
        playlists: getLocalJson(PLAYLISTS_KEY, []),
        history: getLocalJson(HISTORY_KEY, [])
      };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mintpy-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      return { ok: true };
    },

    importBackup: async () => {
      return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) { resolve({ canceled: true }); return; }
          try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (data.settings) setLocalJson(SETTINGS_KEY, data.settings);
            if (data.favorites) setLocalJson(FAVORITES_KEY, data.favorites);
            if (data.playlists) setLocalJson(PLAYLISTS_KEY, data.playlists);
            if (data.history) setLocalJson(HISTORY_KEY, data.history);
            resolve({ ok: true });
            window.location.reload();
          } catch (e) {
            resolve({ error: e.message });
          }
        };
        input.click();
      });
    },

    onMediaCommand: (callback) => {
      mediaCommandListeners.push(callback);
    },

    pickPetImage: async () => {
      return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) { resolve(null); return; }
          const reader = new FileReader();
          reader.onload = () => {
            const customPets = getLocalJson('mintpy_custom_pets', []);
            const id = 'custom:pet_' + Date.now();
            customPets.push({ id, name: file.name.replace(/\.[^.]+$/, ''), dataUrl: reader.result });
            setLocalJson('mintpy_custom_pets', customPets);
            resolve(id);
          };
          reader.readAsDataURL(file);
        };
        input.click();
      });
    },

    getCustomPets: async () => {
      const customs = getLocalJson('mintpy_custom_pets', []);
      return customs.map(p => ({ id: p.id, name: p.name }));
    },

    deleteCustomPet: async (id) => {
      let customs = getLocalJson('mintpy_custom_pets', []);
      customs = customs.filter(p => p.id !== id);
      setLocalJson('mintpy_custom_pets', customs);
      return true;
    },

    getPetDataUrl: async (id) => {
      const customs = getLocalJson('mintpy_custom_pets', []);
      const found = customs.find(p => p.id === id || p.id === 'custom:' + id);
      return found?.dataUrl || '';
    }
  };

  setupMediaSession();
  console.log('MintPy Mobile Bridge initialized successfully.');
})();
