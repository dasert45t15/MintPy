// ============================================================================
// MintPy Mobile YouTube Search & Resilient Multi-Client Stream Resolver
// Uses ANDROID_VR (PO-token-free) -> ANDROID -> IOS -> WEB_REMIX -> Piped API.
// ============================================================================
(function () {
  'use strict';

  const U = window.MintPyUtils || {};
  const STREAM_CACHE_TTL_MS = 25 * 60 * 1000;
  const streamUrlCache = new Map();
  const streamInFlight = new Map();

  const PLAYER_CLIENTS = [
    {
      name: 'ANDROID_VR 1.60.19',
      endpoint: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        'X-Youtube-Client-Name': '28',
        'X-Youtube-Client-Version': '1.60.19'
      },
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.60.19',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        androidSdkVersion: 32,
        osName: 'Android',
        osVersion: '12L',
        hl: 'en',
        gl: 'US'
      }
    },
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Origin': 'https://music.youtube.com',
        'Referer': 'https://music.youtube.com/',
        'X-Youtube-Client-Name': '67',
        'X-Youtube-Client-Version': '1.20240601.01.00'
      },
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20240601.01.00',
        hl: 'en',
        gl: 'US'
      }
    }
  ];

  const PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de'
  ];

  function createYouTubeResolver(net) {
    async function searchTracks(query) {
      if (!query || typeof query !== 'string') return [];
      const cleanQ = query.trim();
      if (!cleanQ) return [];

      // 1. Direct YouTube Innertube Search
      try {
        const data = await net.postJson('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20240601.00.00',
              hl: 'ru',
              gl: 'RU'
            }
          },
          query: cleanQ
        });
        const tracks = U.parseInnertubeSearch ? U.parseInnertubeSearch(data, 30) : [];
        if (tracks.length > 0) return tracks;
      } catch (err) {
        console.warn('Innertube search error, trying fallback:', err.message || err);
      }

      // 2. Fallback: Piped search API
      for (const base of PIPED_INSTANCES) {
        try {
          const raw = await net.getUrl(`${base}/search?q=${encodeURIComponent(cleanQ)}&filter=music_songs`);
          if (!raw) continue;
          const json = JSON.parse(raw);
          const items = Array.isArray(json?.items) ? json.items : [];
          const out = items
            .filter((i) => i && i.url && i.url.includes('v='))
            .slice(0, 25)
            .map((i) => {
              const m = String(i.url).match(/v=([a-zA-Z0-9_-]{11})/);
              return m ? {
                id: `yt:${m[1]}`,
                title: i.title || 'YouTube Track',
                artist: i.uploaderName || 'YouTube',
                artwork: i.thumbnail || '../assets/mintpy-logo.png',
                duration: Number(i.duration) || 0,
                source: 'youtube'
              } : null;
            })
            .filter(Boolean);
          if (out.length > 0) return out;
        } catch {}
      }

      // 3. Fallback: YouTube Suggest Queries
      try {
        const rawJson = await net.getUrl(`https://suggestqueries-clients6.youtube.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(cleanQ)}`);
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
      } catch {}

      return [];
    }

    async function extractVerifiedStream(json, userAgent) {
      const sd = json && json.streamingData;
      if (!sd) return '';

      const adaptive = (sd.adaptiveFormats || [])
        .filter((f) => f && f.url && ((f.mimeType || '').startsWith('audio/') || (f.mimeType || '').includes('audio/mp4') || (f.mimeType || '').includes('audio/webm')))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const bestAdaptive = adaptive.find((f) => (f.mimeType || '').includes('audio/mp4')) || adaptive[0] || null;

      const progFormats = (sd.formats || []).filter((f) => f && f.url && (f.mimeType || '').includes('video/mp4'));
      const itag18 = progFormats.find((f) => f.itag === 18);
      const progressiveCandidates = itag18 ? [itag18, ...progFormats.filter((f) => f !== itag18)] : progFormats;

      if (net.hasStreamProbe()) {
        if (bestAdaptive && await net.probeStream(bestAdaptive.url, userAgent)) {
          return net.wrapProxyStream(bestAdaptive.url, userAgent, bestAdaptive.mimeType || 'audio/mp4');
        }
        for (const f of progressiveCandidates) {
          if (await net.probeStream(f.url, userAgent)) {
            return net.wrapProxyStream(f.url, userAgent, f.mimeType || 'video/mp4');
          }
        }
        return '';
      }

      if (progressiveCandidates.length > 0) {
        return net.wrapProxyStream(progressiveCandidates[0].url, userAgent, progressiveCandidates[0].mimeType || 'video/mp4');
      }
      if (bestAdaptive) {
        return net.wrapProxyStream(bestAdaptive.url, userAgent, bestAdaptive.mimeType || 'audio/mp4');
      }
      return '';
    }

    async function resolveStreamUrl(track, localBlobTracks) {
      if (!track) return '';
      if (track.source === 'local') {
        if (track.directUrl) return track.directUrl;
        const cachedLocal = localBlobTracks.get(track.filepath || track.id);
        if (cachedLocal) return cachedLocal;
      }

      const cacheKey = String(track.id || '');
      const cached = streamUrlCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < STREAM_CACHE_TTL_MS) {
        return cached.url;
      }
      if (streamInFlight.has(cacheKey)) {
        return streamInFlight.get(cacheKey);
      }

      const promise = (async () => {
        let videoId = cacheKey.replace(/^yt:/, '');
        if (!videoId) return '';

        if (videoId.startsWith('search_') || videoId.startsWith('ytsearch:')) {
          const cleanQ = videoId.replace(/^search_/, '').replace(/^ytsearch:/, '').replace(/_\d+$/, '');
          const found = await searchTracks(decodeURIComponent(cleanQ));
          if (found.length && found[0].id) {
            videoId = String(found[0].id).replace(/^yt:/, '');
            track.id = `yt:${videoId}`;
          }
        } else if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
          const query = `${track.artist || ''} - ${track.title || ''}`.trim() || videoId;
          const found = await searchTracks(query);
          if (found.length && found[0].id) {
            videoId = String(found[0].id).replace(/^yt:/, '');
            track.id = `yt:${videoId}`;
          }
        }

        const directCache = streamUrlCache.get(`yt:${videoId}`);
        if (directCache && Date.now() - directCache.ts < STREAM_CACHE_TTL_MS) {
          return directCache.url;
        }

        // 1. Multi-client Innertube resolution
        for (const cfg of PLAYER_CLIENTS) {
          try {
            const json = await net.postJson(cfg.endpoint, {
              context: { client: cfg.client },
              videoId,
              contentCheckOk: true,
              racyCheckOk: true
            }, cfg.headers);
            const verifiedUrl = await extractVerifiedStream(json, cfg.headers['User-Agent']);
            if (verifiedUrl) {
              const entry = { url: verifiedUrl, ts: Date.now() };
              if (streamUrlCache.size > 120) streamUrlCache.clear();
              streamUrlCache.set(cacheKey, entry);
              streamUrlCache.set(`yt:${videoId}`, entry);
              return verifiedUrl;
            }
          } catch (err) {
            console.warn(`Innertube ${cfg.name} resolve skipped:`, err.message || err);
          }
        }

        // 2. Fallback: Piped streams endpoint if all direct Innertube clients fail
        for (const base of PIPED_INSTANCES) {
          try {
            const raw = await net.getUrl(`${base}/streams/${encodeURIComponent(videoId)}`);
            if (!raw) continue;
            const json = JSON.parse(raw);
            const audioStreams = (json?.audioStreams || [])
              .filter((s) => s && s.url)
              .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            const best = audioStreams.find((s) => (s.mimeType || '').includes('mp4')) || audioStreams[0];
            if (best && best.url) {
              const proxied = net.wrapProxyStream(best.url, 'Mozilla/5.0', best.mimeType || 'audio/mp4');
              const entry = { url: proxied, ts: Date.now() };
              streamUrlCache.set(cacheKey, entry);
              streamUrlCache.set(`yt:${videoId}`, entry);
              return proxied;
            }
          } catch {}
        }

        return '';
      })();

      streamInFlight.set(cacheKey, promise);
      try {
        return await promise;
      } finally {
        streamInFlight.delete(cacheKey);
      }
    }

    function invalidateStream(trackId) {
      if (!trackId) return;
      const clean = String(trackId).replace(/^yt:/, '');
      streamUrlCache.delete(trackId);
      streamUrlCache.delete(clean);
      streamUrlCache.delete(`yt:${clean}`);
    }

    return {
      searchTracks,
      resolveStreamUrl,
      invalidateStream
    };
  }

  window.MintPyMobileYouTube = { createYouTubeResolver };
})();
