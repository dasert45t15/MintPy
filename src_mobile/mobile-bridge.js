// MintPy Mobile Bridge (Android WebView & Mobile Web)
// Decoupled, optimized native bridge and offline-first storage.

(function () {
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

  const mediaCommandListeners = [];

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

  async function nativePostJson(url, bodyObj, headersObj) {
    const jsonStr = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', ...(headersObj || {}) };

    // 1. Non-blocking asynchronous fetch (keeps UI completely fluid and responsive)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: jsonStr,
        signal: AbortSignal.timeout(5000)
      });
      if (resp.ok) return await resp.json();
    } catch (e) {
      console.warn('Async fetch error, trying bridge fallback:', e.message);
    }

    // 2. Java bridge fallback
    if (window.AndroidNative) {
      const headersJson = headersObj ? JSON.stringify(headersObj) : null;
      try {
        if (headersJson && typeof window.AndroidNative.postJsonWithHeaders === 'function') {
          const raw = window.AndroidNative.postJsonWithHeaders(url, jsonStr, headersJson);
          if (raw) return JSON.parse(raw);
        } else if (typeof window.AndroidNative.postJson === 'function') {
          const raw = window.AndroidNative.postJson(url, jsonStr);
          if (raw) return JSON.parse(raw);
        }
      } catch (e) {
        console.warn('AndroidNative bridge error:', e);
      }
    }

    throw new Error('Network request failed');
  }

  async function nativeGetUrl(url, headersObj) {
    // 1. Non-blocking asynchronous fetch
    try {
      const resp = await fetch(url, {
        headers: headersObj || {},
        signal: AbortSignal.timeout(5000)
      });
      if (resp.ok) return await resp.text();
    } catch (e) {
      console.warn('Async fetch get error, trying bridge fallback:', e.message);
    }

    // 2. Java bridge fallback
    if (window.AndroidNative) {
      const headersJson = headersObj ? JSON.stringify(headersObj) : null;
      try {
        if (headersJson && typeof window.AndroidNative.getUrlWithHeaders === 'function') {
          const raw = window.AndroidNative.getUrlWithHeaders(url, headersJson);
          if (raw) return raw;
        } else if (typeof window.AndroidNative.getUrl === 'function') {
          const raw = window.AndroidNative.getUrl(url);
          if (raw) return raw;
        }
      } catch (e) {
        console.warn('AndroidNative getUrl error:', e);
      }
    }

    throw new Error('Network get failed');
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
      if (track.directUrl) return track.directUrl;
      if (track.source === 'local') {
        const cached = localBlobTracks.get(track.filepath || track.id);
        if (cached) return cached;
      }
      let videoId = String(track.id || '').replace(/^yt:/, '');
      if (!videoId) return '';

      // If it's a search query placeholder
      if (videoId.startsWith('search_') || videoId.startsWith('ytsearch:')) {
        const cleanQ = videoId.replace(/^search_/, '').replace(/^ytsearch:/, '');
        const found = await window.api.searchTracks(decodeURIComponent(cleanQ));
        if (found && found.length && found[0].id) {
          videoId = String(found[0].id).replace(/^yt:/, '');
          track.id = `yt:${videoId}`;
        }
      }

      // 1. YouTube Innertube with ANDROID_VR client (Fastest, zero cookies needed, works 100%)
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

      // 2. YouTube Innertube with VISIONOS client
      try {
        const headers = {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
          'X-Youtube-Client-Name': '101',
          'X-Youtube-Client-Version': '1.02',
          'Origin': 'https://www.youtube.com'
        };
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
          videoId: videoId
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

      // 3. Fallback to Invidious instances
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
      crossfadeSeconds: 0,
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
