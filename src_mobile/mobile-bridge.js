// MintPy Mobile Bridge (Android WebView & Mobile Web)
// Decoupled, optimized native bridge and offline-first storage.

(function () {
  const SETTINGS_KEY = 'mintpy_settings';
  const HISTORY_KEY = 'mintpy_history';
  const FAVORITES_KEY = 'mintpy_favorites';
  const PLAYLISTS_KEY = 'mintpy_playlists';
  const QUEUE_KEY = 'mintpy_queue';

  // In-memory store cache + debounced localStorage flush (prevents UI stalls on repeated reads/writes)
  const memCache = new Map();
  const dirtyKeys = new Set();
  let flushTimer = null;

  function flushStorage() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    for (const key of dirtyKeys) {
      try {
        localStorage.setItem(key, JSON.stringify(memCache.get(key)));
      } catch (e) {
        console.warn('Storage write failed:', e);
      }
    }
    dirtyKeys.clear();
  }

  window.addEventListener('pagehide', flushStorage);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushStorage();
  });

  function getLocalJson(key, def) {
    if (memCache.has(key)) return memCache.get(key);
    try {
      const v = localStorage.getItem(key);
      const parsed = v ? JSON.parse(v) : def;
      memCache.set(key, parsed);
      return parsed;
    } catch {
      memCache.set(key, def);
      return def;
    }
  }

  function setLocalJson(key, val) {
    memCache.set(key, val);
    dirtyKeys.add(key);
    if (!flushTimer) {
      flushTimer = setTimeout(flushStorage, 150);
    }
  }

  const mediaCommandListeners = [];

  // MediaSession integration for Android lockscreen, AOD, notifications and dynamic islands
  function setupMediaSession() {
    let lastActiveTrack = null;
    let lastPlayingState = false;
    let lastNativeSessionSig = '';
    let lastNativePosSyncTs = 0;

    window.__mintpyNativeMediaAction = function (action, arg) {
      if (action === 'play') mediaCommandListeners.forEach(fn => fn('play'));
      else if (action === 'pause') mediaCommandListeners.forEach(fn => fn('pause'));
      else if (action === 'next') mediaCommandListeners.forEach(fn => fn('next-track'));
      else if (action === 'prev') mediaCommandListeners.forEach(fn => fn('prev-track'));
      else if (action === 'seekto') mediaCommandListeners.forEach(fn => fn('seek-to', Number(arg) / 1000));
      else if (action === 'stop') mediaCommandListeners.forEach(fn => fn('stop'));
    };

    window.updateMobileMediaSession = function (track, isPlaying, positionSec) {
      if (!track) return;
      lastActiveTrack = track;
      lastPlayingState = !!isPlaying;
      const dur = Number(track.duration) || 0;
      const pos = Number(positionSec) || 0;
      const sig = `${track.id || track.title}|${lastPlayingState ? 1 : 0}|${Math.round(dur)}|${track.artwork || ''}`;

      if (sig !== lastNativeSessionSig && window.AndroidNative && window.AndroidNative.updateNativeMediaSession) {
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
        } catch (e) {
          console.warn('AndroidNative MediaSession error:', e);
        }
      }

      if (!('mediaSession' in navigator)) return;
      try {
        const artSrc = track.artwork || '../assets/mintpy-logo.png';
        const sizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title || 'MintPy',
          artist: track.artist || 'Zen Music Player',
          album: track.album || 'MintPy',
          artwork: sizes.map(size => ({
            src: artSrc,
            sizes: size,
            type: 'image/png'
          }))
        });
        navigator.mediaSession.playbackState = lastPlayingState ? 'playing' : 'paused';
      } catch (e) {
        console.warn('MediaSession error:', e);
      }
    };

    window.updateMobilePositionState = function (state, force) {
      if (!state) return;
      const positionSec = Number(state.position) || 0;
      const durationSec = Number(state.duration) || (lastActiveTrack ? Number(lastActiveTrack.duration) || 0 : 0);

      if (window.AndroidNative && typeof window.AndroidNative.updateNativePlaybackPosition === 'function') {
        const now = Date.now();
        if (force === true || now - lastNativePosSyncTs >= 15000) {
          lastNativePosSyncTs = now;
          try {
            window.AndroidNative.updateNativePlaybackPosition(positionSec, durationSec, lastPlayingState);
          } catch (e) {}
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
        } catch (e) {}
      }
    };

    if (!('mediaSession' in navigator)) return;

    const actions = [
      ['play', () => mediaCommandListeners.forEach(fn => fn('play'))],
      ['pause', () => mediaCommandListeners.forEach(fn => fn('pause'))],
      ['previoustrack', () => mediaCommandListeners.forEach(fn => fn('prev-track'))],
      ['nexttrack', () => mediaCommandListeners.forEach(fn => fn('next-track'))],
      ['seekto', (details) => {
        if (details && isFinite(details.seekTime)) {
          mediaCommandListeners.forEach(fn => fn('seek-to', details.seekTime));
        }
      }],
      ['seekforward', (details) => {
        const offset = (details && isFinite(details.seekOffset)) ? details.seekOffset : 10;
        mediaCommandListeners.forEach(fn => fn('seek-by', offset));
      }],
      ['seekbackward', (details) => {
        const offset = (details && isFinite(details.seekOffset)) ? -Math.abs(details.seekOffset) : -10;
        mediaCommandListeners.forEach(fn => fn('seek-by', offset));
      }],
      ['stop', () => mediaCommandListeners.forEach(fn => fn('stop'))]
    ];

    actions.forEach(([action, handler]) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {}
    });
  }

  // Non-blocking native async HTTP bridge (runs on Java ExecutorService thread pool with Keep-Alive + GZIP)
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
        if (body != null) {
          entry.resolve(body);
        } else {
          entry.reject(new Error('Empty native result'));
        }
      } else {
        entry.reject(new Error(errMsg || 'Native HTTP request failed'));
      }
      return;
    }

    const payload = okOrPayload;
    if (payload && payload.ok && payload.body != null) {
      entry.resolve(payload.body);
    } else {
      entry.reject(new Error((payload && payload.error) || 'Native HTTP request failed'));
    }
  };

  function nativeAndroidRequest(method, url, bodyStr, headersObj) {
    return new Promise((resolve, reject) => {
      const reqId = 'r_' + (++nativeReqSeq);
      const timer = setTimeout(() => {
        pendingNativeReqs.delete(reqId);
        try {
          if (window.AndroidNative && typeof window.AndroidNative.takeAsyncResult === 'function') {
            window.AndroidNative.takeAsyncResult(reqId);
          }
        } catch {}
        reject(new Error('Native HTTP timeout'));
      }, 15000);
      pendingNativeReqs.set(reqId, { resolve, reject, timer });
      try {
        const headersJson = headersObj ? JSON.stringify(headersObj) : '';
        window.AndroidNative.requestAsync(reqId, method, url, bodyStr || '', headersJson);
      } catch (e) {
        clearTimeout(timer);
        pendingNativeReqs.delete(reqId);
        reject(e);
      }
    });
  }

  async function nativeProbeStreamAsync(url, userAgent) {
    return new Promise((resolve) => {
      const reqId = 'p_' + (++nativeReqSeq);
      const timer = setTimeout(() => {
        pendingNativeReqs.delete(reqId);
        try {
          if (window.AndroidNative && typeof window.AndroidNative.takeAsyncResult === 'function') {
            window.AndroidNative.takeAsyncResult(reqId);
          }
        } catch {}
        resolve(false);
      }, 9000);
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
      } catch (e) {
        clearTimeout(timer);
        pendingNativeReqs.delete(reqId);
        resolve(false);
      }
    });
  }

  async function nativePostJson(url, bodyObj, headersObj) {
    const jsonStr = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);

    // 1. Non-blocking async native bridge (keeps WebView UI thread 100% responsive)
    if (window.AndroidNative && typeof window.AndroidNative.requestAsync === 'function') {
      const raw = await nativeAndroidRequest('POST', url, jsonStr, headersObj);
      if (!raw) throw new Error('Empty response from native HTTP');
      return JSON.parse(raw);
    }

    // 2. Legacy synchronous native bridge fallback (only if requestAsync is absent)
    if (window.AndroidNative && typeof window.AndroidNative.postJsonWithHeaders === 'function') {
      try {
        const raw = window.AndroidNative.postJsonWithHeaders(url, jsonStr, headersObj ? JSON.stringify(headersObj) : null);
        if (raw) return JSON.parse(raw);
      } catch (e) {
        console.warn('Native postJsonWithHeaders error:', e);
      }
    }

    if (window.AndroidNative && typeof window.AndroidNative.postJson === 'function') {
      try {
        const raw = window.AndroidNative.postJson(url, jsonStr);
        if (raw) return JSON.parse(raw);
      } catch (e) {}
    }

    // 3. Web fetch (for browser preview)
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', ...(headersObj || {}) };
    try {
      const opts = { method: 'POST', headers, body: jsonStr };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(6000);
      const resp = await fetch(url, opts);
      if (resp.ok) return await resp.json();
    } catch (e) {
      console.warn('Async fetch error:', e.message);
    }

    throw new Error('Network request failed');
  }

  async function nativeGetUrl(url, headersObj) {
    // 1. Non-blocking async native bridge (keeps WebView UI thread 100% responsive)
    if (window.AndroidNative && typeof window.AndroidNative.requestAsync === 'function') {
      try {
        const raw = await nativeAndroidRequest('GET', url, '', headersObj);
        return raw || '';
      } catch (e) {
        console.warn('Native async GET error:', e.message);
        return '';
      }
    }

    // 2. Legacy synchronous native bridge fallback (only if requestAsync is absent)
    if (window.AndroidNative && typeof window.AndroidNative.getUrlWithHeaders === 'function') {
      try {
        const raw = window.AndroidNative.getUrlWithHeaders(url, headersObj ? JSON.stringify(headersObj) : null);
        if (raw) return raw;
      } catch (e) {
        console.warn('Native getUrlWithHeaders error:', e);
      }
    }

    if (window.AndroidNative && typeof window.AndroidNative.getUrl === 'function') {
      try {
        const raw = window.AndroidNative.getUrl(url);
        if (raw) return raw;
      } catch (e) {}
    }

    // 3. Web fetch
    try {
      const opts = { headers: headersObj || {} };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(6000);
      const resp = await fetch(url, opts);
      if (resp.ok) return await resp.text();
    } catch (e) {
      console.warn('Async fetch get error:', e.message);
    }

    return '';
  }

  // Stream URL TTL cache (25 min) + in-flight deduplication
  const streamUrlCache = new Map();
  const streamInFlight = new Map();
  const STREAM_CACHE_TTL_MS = 25 * 60 * 1000;

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
            if (tracks.length >= 30) break;
          }
          if (tracks.length >= 30) break;
        }
        if (tracks.length > 0) return tracks;
      } catch (err) {
        console.warn('Innertube search error, falling back:', err);
      }

      // 2. Fallback: YouTube Suggest Queries
      try {
        const rawJson = await nativeGetUrl(`https://suggestqueries-clients6.youtube.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(cleanQ)}`);
        const parsed = JSON.parse(rawJson);
        const suggestions = Array.isArray(parsed?.[1]) ? parsed[1] : [];
        if (suggestions.length > 0) {
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
      if (track.source === 'local') {
        if (track.directUrl) return track.directUrl;
        const cached = localBlobTracks.get(track.filepath || track.id);
        if (cached) return cached;
      }

      const cacheKey = String(track.id || '');
      const cachedStream = streamUrlCache.get(cacheKey);
      if (cachedStream && Date.now() - cachedStream.ts < STREAM_CACHE_TTL_MS) {
        return cachedStream.url;
      }
      if (streamInFlight.has(cacheKey)) {
        return streamInFlight.get(cacheKey);
      }

      const promise = (async () => {
        let videoId = cacheKey.replace(/^yt:/, '');
        if (!videoId) return '';

        // If it's a search query placeholder
        if (videoId.startsWith('search_') || videoId.startsWith('ytsearch:')) {
          const cleanQ = videoId.replace(/^search_/, '').replace(/^ytsearch:/, '');
          const found = await window.api.searchTracks(decodeURIComponent(cleanQ));
          if (found && found.length && found[0].id) {
            videoId = String(found[0].id).replace(/^yt:/, '');
            track.id = `yt:${videoId}`;
          }
        } else if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
          const query = `${track.artist || ''} - ${track.title || ''}`.trim() || videoId;
          const searchFn = (window.api && window.api.searchTracks) ? window.api.searchTracks : this.searchTracks?.bind(this);
          if (searchFn) {
            const found = await searchFn(query);
            if (found && found.length && found[0].id) {
              videoId = String(found[0].id).replace(/^yt:/, '');
              track.id = `yt:${videoId}`;
            }
          }
        }

        async function probePlayableUrl(url, userAgent) {
          if (!url) return false;
          if (window.AndroidNative && typeof window.AndroidNative.probeStreamAsync === 'function') {
            return await nativeProbeStreamAsync(url, userAgent);
          }
          if (window.AndroidNative && typeof window.AndroidNative.probeStreamUrl === 'function') {
            try {
              const code = window.AndroidNative.probeStreamUrl(url, userAgent || '');
              return code === 200 || code === 206;
            } catch (e) {
              return false;
            }
          }
          return true;
        }

        function wrapPlayableUrl(url, userAgent, mimeType) {
          if (!url) return '';
          if (window.AndroidNative && typeof window.AndroidNative.registerProxyStream === 'function') {
            try {
              const proxied = window.AndroidNative.registerProxyStream(url, userAgent || '', mimeType || 'video/mp4');
              if (proxied) return proxied;
            } catch (e) {}
          }
          return url;
        }

        async function extractVerifiedStream(json, userAgent) {
          const sd = json && json.streamingData;
          if (!sd) return '';

          const adaptive = (sd.adaptiveFormats || [])
            .filter(f => f && f.url && ((f.mimeType || '').startsWith('audio/') || (f.mimeType || '').includes('audio/mp4') || (f.mimeType || '').includes('audio/webm')))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          const bestAdaptive = adaptive.find(f => (f.mimeType || '').includes('audio/mp4')) || adaptive[0] || null;

          const progFormats = (sd.formats || []).filter(f => f && f.url && (f.mimeType || '').includes('video/mp4'));
          const itag18 = progFormats.find(f => f.itag === 18);
          const progressiveCandidates = itag18 ? [itag18, ...progFormats.filter(f => f !== itag18)] : progFormats;

          const hasNativeProbe = !!(window.AndroidNative && (
            typeof window.AndroidNative.probeStreamAsync === 'function' ||
            typeof window.AndroidNative.probeStreamUrl === 'function'
          ));

          if (hasNativeProbe) {
            if (bestAdaptive && await probePlayableUrl(bestAdaptive.url, userAgent)) {
              return wrapPlayableUrl(bestAdaptive.url, userAgent, bestAdaptive.mimeType || 'audio/mp4');
            }
            for (const f of progressiveCandidates) {
              if (await probePlayableUrl(f.url, userAgent)) {
                return wrapPlayableUrl(f.url, userAgent, f.mimeType || 'video/mp4');
              }
            }
            return '';
          }

          if (progressiveCandidates.length > 0) {
            return wrapPlayableUrl(progressiveCandidates[0].url, userAgent, progressiveCandidates[0].mimeType || 'video/mp4');
          }
          if (bestAdaptive) {
            return wrapPlayableUrl(bestAdaptive.url, userAgent, bestAdaptive.mimeType || 'audio/mp4');
          }
          return '';
        }

        const playerClients = [
          {
            name: 'ANDROID 20.10.38',
            endpoint: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
              'X-Youtube-Client-Name': '3',
              'X-Youtube-Client-Version': '20.10.38'
            },
            client: {
              clientName: 'ANDROID',
              clientVersion: '20.10.38',
              androidSdkVersion: 34,
              osName: 'Android',
              osVersion: '14',
              hl: 'en',
              gl: 'US'
            }
          },
          {
            name: 'ANDROID 21.03.36',
            endpoint: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'com.google.android.youtube/21.03.36 (Linux; U; Android 15) gzip',
              'X-Youtube-Client-Name': '3',
              'X-Youtube-Client-Version': '21.03.36'
            },
            client: {
              clientName: 'ANDROID',
              clientVersion: '21.03.36',
              androidSdkVersion: 35,
              osName: 'Android',
              osVersion: '15',
              hl: 'en',
              gl: 'US'
            }
          },
          {
            name: 'IOS 20.10.4',
            endpoint: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
              'X-Youtube-Client-Name': '5',
              'X-Youtube-Client-Version': '20.10.4'
            },
            client: {
              clientName: 'IOS',
              clientVersion: '20.10.4',
              deviceMake: 'Apple',
              deviceModel: 'iPhone16,2',
              osName: 'iPhone',
              osVersion: '18.3.2.22D82',
              hl: 'en',
              gl: 'US'
            }
          },
          {
            name: 'WEB_REMIX',
            endpoint: 'https://music.youtube.com/youtubei/v1/player?prettyPrint=false',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Origin': 'https://music.youtube.com',
              'Referer': 'https://music.youtube.com/',
              'X-Youtube-Client-Name': '67',
              'X-Youtube-Client-Version': '1.20240101.01.00'
            },
            client: {
              clientName: 'WEB_REMIX',
              clientVersion: '1.20240101.01.00',
              hl: 'en',
              gl: 'US'
            }
          }
        ];

        for (const cfg of playerClients) {
          try {
            const payload = {
              context: { client: cfg.client },
              videoId: videoId,
              contentCheckOk: true,
              racyCheckOk: true
            };
            const json = await nativePostJson(cfg.endpoint, payload, cfg.headers);
            const verifiedUrl = await extractVerifiedStream(json, cfg.headers['User-Agent']);
            if (verifiedUrl) {
              streamUrlCache.set(cacheKey, { url: verifiedUrl, ts: Date.now() });
              streamUrlCache.set(`yt:${videoId}`, { url: verifiedUrl, ts: Date.now() });
              return verifiedUrl;
            }
          } catch (err) {
            console.warn(`Innertube ${cfg.name} resolve error:`, err.message || err);
          }
        }

        return '';
      })();

      streamInFlight.set(cacheKey, promise);
      try {
        return await promise;
      } finally {
        streamInFlight.delete(cacheKey);
      }
    },

    prefetchTrack: (track) => {
      if (!track || track.source === 'local') return;
      window.api.getTrackAudioUrl(track).catch(() => {});
    },

    invalidateTrackStream: (trackId) => {
      if (!trackId) return;
      const clean = String(trackId).replace(/^yt:/, '');
      streamUrlCache.delete(trackId);
      streamUrlCache.delete(clean);
      streamUrlCache.delete(`yt:${clean}`);
    },

    isFavoriteSync: (trackId) => {
      if (!trackId) return false;
      const favs = getLocalJson(FAVORITES_KEY, []);
      return favs.some(f => f.id === trackId);
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
              album: 'Mobile Storage',
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
      url = String(url || '').trim();
      if (!url) throw new Error('Введите ссылку на плейлист или альбом');
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

      // 1. Spotify Importer
      async function importSpotify(rawUrl) {
        const embedUrl = rawUrl.replace('open.spotify.com/', 'open.spotify.com/embed/');
        const html = await nativeGetUrl(embedUrl, {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        });
        if (!html) throw new Error('Не удалось загрузить данные Spotify');

        let entity = null;
        const tag = '__NEXT_DATA__';
        const idx = html.indexOf(tag);
        if (idx !== -1) {
          const start = html.indexOf('>', idx) + 1;
          const end = html.indexOf('</script>', start);
          if (end > start) {
            try {
              const json = JSON.parse(html.slice(start, end));
              entity = json.props?.pageProps?.state?.data?.entity;
            } catch {}
          }
        }

        if (!entity || !Array.isArray(entity.trackList)) {
          throw new Error('Не удалось найти треки в плейлисте Spotify. Убедитесь, что плейлист открытый.');
        }

        const title = (entity.name || 'Spotify Playlist').trim();
        const tracks = entity.trackList.map(t => {
          const artist = t.subtitle || 'Unknown Artist';
          const trackTitle = t.title || 'Unknown Title';
          return {
            id: 'yt:ytsearch:' + encodeURIComponent(`${artist} - ${trackTitle}`),
            title: trackTitle,
            artist: artist,
            album: '',
            artwork: '',
            duration: Math.round((Number(t.duration) || 0) / 1000),
            source: 'youtube'
          };
        }).filter(t => t.title && t.title !== 'Unknown Title');

        return { name: `Spotify: ${title}`, tracks };
      }

      // 2. YouTube / YouTube Music Importer
      async function importYouTube(rawUrl) {
        let listId = '';
        try {
          const u = new URL(rawUrl);
          listId = u.searchParams.get('list') || '';
        } catch {
          const m = rawUrl.match(/[?&]list=([a-zA-Z0-9_-]+)/);
          if (m) listId = m[1];
        }

        if (!listId) {
          const vMatch = rawUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
          if (vMatch) {
            const vId = vMatch[1];
            return {
              name: 'YouTube Track',
              tracks: [{
                id: 'yt:' + vId,
                title: 'YouTube Track',
                artist: 'YouTube',
                artwork: `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`,
                duration: 0,
                source: 'youtube'
              }]
            };
          }
          throw new Error('В ссылке YouTube не найден идентификатор плейлиста (?list=...)');
        }

        const json = await nativePostJson('https://www.youtube.com/youtubei/v1/browse', {
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20240101.00.00',
              hl: 'ru',
              gl: 'RU'
            }
          },
          browseId: 'VL' + listId
        });

        const title = json.metadata?.playlistMetadataRenderer?.title ||
                      json.header?.pageHeaderRenderer?.pageTitle ||
                      'YouTube Playlist';

        const tracks = [];
        const visitedIds = new Set();

        function scan(obj) {
          if (!obj || typeof obj !== 'object') return;

          if (obj.lockupViewModel && obj.lockupViewModel.contentId) {
            const l = obj.lockupViewModel;
            const vId = l.contentId;
            if (!visitedIds.has(vId)) {
              visitedIds.add(vId);
              const meta = l.metadata?.lockupMetadataViewModel;
              const tTitle = meta?.title?.content || 'YouTube Track';
              const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
              const artist = rows[0]?.metadataParts?.[0]?.text?.content || 'YouTube';
              const thumbs = l.contentImage?.thumbnailViewModel?.image?.sources || [];
              const artwork = thumbs.length ? thumbs[thumbs.length - 1].url : '';
              tracks.push({
                id: 'yt:' + vId,
                title: tTitle.trim(),
                artist: artist.trim(),
                artwork,
                duration: 0,
                source: 'youtube'
              });
            }
          }

          if (obj.playlistVideoRenderer && obj.playlistVideoRenderer.videoId) {
            const v = obj.playlistVideoRenderer;
            const vId = v.videoId;
            if (!visitedIds.has(vId)) {
              visitedIds.add(vId);
              const tTitle = v.title?.runs?.[0]?.text || v.title?.simpleText || 'YouTube Track';
              const artist = v.shortBylineText?.runs?.[0]?.text || 'YouTube';
              const thumbs = v.thumbnail?.thumbnails || [];
              const artwork = thumbs.length ? thumbs[thumbs.length - 1].url : '';
              let duration = 0;
              const durStr = v.lengthText?.simpleText || '';
              if (durStr) {
                const parts = durStr.split(':').map(Number);
                if (parts.length === 2) duration = parts[0] * 60 + parts[1];
                else if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
              }
              tracks.push({
                id: 'yt:' + vId,
                title: tTitle.trim(),
                artist: artist.trim(),
                artwork,
                duration,
                source: 'youtube'
              });
            }
          }

          if (Array.isArray(obj)) {
            for (const item of obj) scan(item);
          } else {
            for (const k of Object.keys(obj)) scan(obj[k]);
          }
        }

        scan(json);

        if (!tracks.length) {
          throw new Error('Не удалось извлечь треки из плейлиста YouTube. Убедитесь, что плейлист публичный.');
        }

        return { name: `YouTube: ${title}`, tracks };
      }

      // 3. Yandex Music Importer
      async function importYandexMusic(rawUrl) {
        let user = '', kind = '', albumId = '';
        try {
          const u = new URL(rawUrl);
          const parts = u.pathname.split('/').filter(Boolean);
          const plIdx = parts.indexOf('playlists');
          if (plIdx >= 0 && parts[plIdx + 1]) {
            kind = parts[plIdx + 1];
            user = parts[plIdx - 1] || 'users';
          }
          const albIdx = parts.indexOf('album');
          if (albIdx >= 0 && parts[albIdx + 1]) {
            albumId = parts[albIdx + 1];
          }
        } catch {}

        // Playlist handler
        if (kind) {
          try {
            const jsonStr = await nativeGetUrl(`https://music.yandex.ru/handlers/playlist.jsx?owner=${encodeURIComponent(user)}&kinds=${encodeURIComponent(kind)}`, {
              'X-Requested-With': 'XMLHttpRequest'
            });
            const data = JSON.parse(jsonStr);
            const pl = data.playlist || {};
            const rawTracks = pl.tracks || [];
            if (rawTracks.length) {
              const tracks = rawTracks.map(t => {
                const artists = (t.artists || []).map(a => a.name).join(', ') || 'Unknown Artist';
                const art = t.coverUri ? ('https://' + t.coverUri.replace('%%', '400x400')) : '';
                return {
                  id: `yt:ytsearch:${encodeURIComponent(artists + ' - ' + t.title)}`,
                  title: t.title,
                  artist: artists,
                  album: t.albums?.[0]?.title || '',
                  artwork: art,
                  duration: Math.round((t.durationMs || 0) / 1000),
                  source: 'youtube'
                };
              });
              return { name: `Яндекс: ${pl.title || 'Плейлист'}`, tracks };
            }
          } catch (e) {
            console.warn('Yandex playlist.jsx error:', e.message);
          }
        }

        // Album handler
        if (albumId) {
          try {
            const jsonStr = await nativeGetUrl(`https://music.yandex.ru/handlers/album.jsx?album=${encodeURIComponent(albumId)}`, {
              'X-Requested-With': 'XMLHttpRequest'
            });
            const data = JSON.parse(jsonStr);
            const title = data.title || 'Альбом';
            const rawTracks = (data.volumes || []).flat();
            if (rawTracks.length) {
              const tracks = rawTracks.map(t => {
                const artists = (t.artists || []).map(a => a.name).join(', ') || data.artists?.[0]?.name || 'Unknown Artist';
                const art = t.coverUri ? ('https://' + t.coverUri.replace('%%', '400x400')) : (data.coverUri ? ('https://' + data.coverUri.replace('%%', '400x400')) : '');
                return {
                  id: `yt:ytsearch:${encodeURIComponent(artists + ' - ' + t.title)}`,
                  title: t.title,
                  artist: artists,
                  album: title,
                  artwork: art,
                  duration: Math.round((t.durationMs || 0) / 1000),
                  source: 'youtube'
                };
              });
              return { name: `Яндекс: ${title}`, tracks };
            }
          } catch (e) {
            console.warn('Yandex album.jsx error:', e.message);
          }
        }

        // Fallback: parse HTML schema.org
        try {
          const html = await nativeGetUrl(rawUrl);
          if (html) {
            const ldMatches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
            for (const m of ldMatches) {
              try {
                const ld = JSON.parse(m[1]);
                const rawTracks = ld.track || ld.tracks || [];
                if (Array.isArray(rawTracks) && rawTracks.length) {
                  const tracks = rawTracks.map(t => {
                    const artName = t.byArtist?.name || t.author?.name || 'Unknown Artist';
                    return {
                      id: `yt:ytsearch:${encodeURIComponent(artName + ' - ' + t.name)}`,
                      title: t.name,
                      artist: artName,
                      duration: 0,
                      source: 'youtube'
                    };
                  });
                  return { name: `Яндекс: ${ld.name || 'Плейлист'}`, tracks };
                }
              } catch {}
            }
          }
        } catch (e) {
          console.warn('Yandex HTML fallback error:', e.message);
        }

        throw new Error('Не удалось импортировать плейлист Яндекс Музыки. Убедитесь, что плейлист открытый.');
      }

      // Router
      let result = null;
      if (url.includes('spotify.com')) {
        result = await importSpotify(url);
      } else if (url.includes('music.yandex.') || url.includes('ya.ru') || url.includes('yandex.ru')) {
        result = await importYandexMusic(url);
      } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
        result = await importYouTube(url);
      } else {
        result = await importYouTube(url);
      }

      if (!result || !result.tracks || !result.tracks.length) {
        throw new Error('В плейлисте не найдено треков');
      }

      const pls = getLocalJson(PLAYLISTS_KEY, []);
      const newPl = {
        id: 'pl_' + Date.now(),
        name: result.name || 'Импортированный плейлист',
        tracks: result.tracks
      };
      pls.push(newPl);
      setLocalJson(PLAYLISTS_KEY, pls);

      return {
        id: newPl.id,
        name: newPl.name,
        trackCount: newPl.tracks.length,
        tracks: newPl.tracks
      };
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
      appearance: 'dark',
      style: 'zen',
      volumeNormalize: false,
      eqBands: { low: 0, mid: 0, high: 0 },
      crossfadeSeconds: 5,
      auraIntensity: 0.35
    }),
    saveSettings: async (settings) => {
      setLocalJson(SETTINGS_KEY, settings);
      return true;
    },

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
    }
  };

  setupMediaSession();
  console.log('MintPy Mobile Bridge initialized.');
})();
