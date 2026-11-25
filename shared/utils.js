// ============================================================================
// MintPy Shared Core Utilities (UMD: Browser window.MintPyUtils + Node CommonJS)
// Single source of truth for version, formatting, LRC, and URL/API parsers.
// ============================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MintPyUtils = api;
    root.MINTPY_VERSION = api.VERSION;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  const VERSION = '6.0.0';

  const ESC_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
  }

  function fmtTime(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n < 0) return '0:00';
    const total = Math.floor(n);
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hrs > 0) {
      return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  function parseDurationText(durStr) {
    if (!durStr || typeof durStr !== 'string') return 0;
    const parts = durStr.trim().split(':').map(Number);
    if (parts.some((p) => !Number.isFinite(p) || p < 0)) return 0;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  function sanitizeLyricsQuery(str) {
    if (!str) return '';
    return String(str)
      .replace(/\s*[\(\[](?:official|video|audio|mv|remastered|remaster|lyrics?|lyric\s*video|visualizer|feat\.?|ft\.?|hd|4k|hq|live|prod\.?).*?[\)\]]/gi, '')
      .replace(/\s*(?:feat\.?|ft\.?)\s+[^|\-–—]+$/i, '')
      .replace(/\s*[\|]\s*.*$/, '')
      .trim();
  }

  function parseLrc(lrcText) {
    if (!lrcText || typeof lrcText !== 'string') return [];
    const lines = lrcText.split(/\r?\n/);
    const result = [];
    const timeRegex = /\[(\d{1,3}):(\d{2}(?:[.:]\d{1,3})?)\]/g;
    for (const rawLine of lines) {
      const matches = [...rawLine.matchAll(timeRegex)];
      if (!matches.length) continue;
      const text = rawLine.replace(timeRegex, '').trim();
      for (const m of matches) {
        const min = parseInt(m[1], 10);
        const sec = parseFloat(m[2].replace(':', '.'));
        if (Number.isFinite(min) && Number.isFinite(sec)) {
          result.push({ time: min * 60 + sec, text: text || '♪' });
        }
      }
    }
    return result.sort((a, b) => a.time - b.time);
  }

  function parseInnertubeSearch(data, maxItems = 30) {
    const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const tracks = [];
    const seen = new Set();
    for (const sec of sections) {
      const items = sec?.itemSectionRenderer?.contents || [];
      for (const it of items) {
        const v = it && it.videoRenderer;
        if (!v || !v.videoId || seen.has(v.videoId)) continue;
        seen.add(v.videoId);
        const title = v.title?.runs?.[0]?.text || v.title?.simpleText || '';
        if (!title) continue;
        const artist = v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || 'YouTube';
        const thumbs = v.thumbnail?.thumbnails || [];
        const artwork = thumbs.length ? thumbs[thumbs.length - 1].url : '';
        const duration = parseDurationText(v.lengthText?.simpleText || '');
        tracks.push({
          id: `yt:${v.videoId}`,
          title,
          artist,
          artwork,
          duration,
          source: 'youtube'
        });
        if (tracks.length >= maxItems) return tracks;
      }
    }
    return tracks;
  }

  function detectPlaylistProvider(rawInput) {
    let url = String(rawInput || '').trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    const lower = url.toLowerCase();
    if (lower.includes('spotify.com')) {
      return {
        provider: 'spotify',
        url,
        embedUrl: url.replace(/open\.spotify\.com\/(intl-[a-z]{2}\/)?/i, 'open.spotify.com/embed/')
      };
    }

    if (lower.includes('music.yandex.') || lower.includes('yandex.ru') || lower.includes('ya.ru')) {
      let yandexUser = '';
      let yandexKind = '';
      let yandexAlbumId = '';
      try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const plIdx = parts.indexOf('playlists');
        if (plIdx >= 0 && parts[plIdx + 1]) {
          yandexKind = parts[plIdx + 1];
          yandexUser = parts[plIdx - 1] || 'users';
        }
        const albIdx = parts.indexOf('album');
        if (albIdx >= 0 && parts[albIdx + 1]) {
          yandexAlbumId = parts[albIdx + 1];
        }
      } catch {}
      return { provider: 'yandex', url, yandexUser, yandexKind, yandexAlbumId };
    }

    let listId = '';
    let videoId = '';
    try {
      const u = new URL(url);
      listId = u.searchParams.get('list') || '';
      videoId = u.searchParams.get('v') || '';
      if (!videoId && u.hostname.includes('youtu.be')) {
        videoId = u.pathname.replace(/^\//, '').split('/')[0] || '';
      }
    } catch {
      const lm = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
      if (lm) listId = lm[1];
      const vm = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (vm) videoId = vm[1];
    }
    if (videoId && !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) videoId = '';
    return { provider: 'youtube', url, listId, videoId };
  }

  return {
    VERSION,
    esc,
    fmtTime,
    parseDurationText,
    sanitizeLyricsQuery,
    parseLrc,
    parseInnertubeSearch,
    detectPlaylistProvider
  };
});
