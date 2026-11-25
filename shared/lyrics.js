// ============================================================================
// MintPy Shared Synced Lyrics & Karaoke Engine (Desktop + Android Mobile)
// ============================================================================
(function () {
  'use strict';

  const U = window.MintPyUtils || {};
  const esc = U.esc || ((s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  const sanitizeQuery = U.sanitizeLyricsQuery || ((s) => String(s || '').trim());
  const parseLrc = U.parseLrc || (() => []);

  const lyricsCache = new Map();
  let currentParsed = [];
  let isLyricsOpen = false;
  let activeIndex = -1;
  let userScrolling = false;
  let scrollTimeout = null;
  let requestSeq = 0;

  function getActiveTrack() {
    if (window.mintpyPlayer && typeof window.mintpyPlayer.getCurrentTrack === 'function') {
      return window.mintpyPlayer.getCurrentTrack();
    }
    return window.currentTrack || null;
  }

  function getPlaybackTime() {
    if (window.mintpyPlayer && typeof window.mintpyPlayer.getCurrentTime === 'function') {
      return Number(window.mintpyPlayer.getCurrentTime()) || 0;
    }
    return Number(window.audio && window.audio.currentTime) || 0;
  }

  function seekPlayback(timeSec) {
    if (!Number.isFinite(timeSec) || timeSec < 0) return;
    if (window.mintpyPlayer && typeof window.mintpyPlayer.seekToSeconds === 'function') {
      window.mintpyPlayer.seekToSeconds(timeSec);
      return;
    }
    if (window.audio) {
      window.audio.currentTime = timeSec;
    }
  }

  async function fetchJsonUrl(url) {
    if (window.api && typeof window.api.fetchText === 'function') {
      const raw = await window.api.fetchText(url);
      if (raw) return JSON.parse(raw);
    }
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  }

  async function fetchLyrics(track) {
    if (!track || !track.title) return null;
    const cacheKey = track.id || `${track.title}::${track.artist || ''}`;
    if (lyricsCache.has(cacheKey)) return lyricsCache.get(cacheKey);

    const cleanTitle = sanitizeQuery(track.title);
    const cleanArtist = sanitizeQuery(track.artist);

    // 1. Exact match via LRCLIB
    try {
      const params = new URLSearchParams({
        track_name: cleanTitle || track.title,
        artist_name: cleanArtist || track.artist || ''
      });
      if (track.duration && Number.isFinite(track.duration) && track.duration > 0) {
        params.set('duration', String(Math.round(track.duration)));
      }
      const data = await fetchJsonUrl(`https://lrclib.net/api/get?${params}`);
      if (data && (data.syncedLyrics || data.plainLyrics)) {
        if (lyricsCache.size > 80) lyricsCache.clear();
        lyricsCache.set(cacheKey, data);
        return data;
      }
    } catch {}

    // 2. Search fallback via LRCLIB
    try {
      const query = `${cleanArtist} ${cleanTitle}`.trim() || track.title;
      const items = await fetchJsonUrl(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`);
      if (Array.isArray(items) && items.length) {
        const match = items.find((i) => i && i.syncedLyrics) || items[0];
        if (match) {
          if (lyricsCache.size > 80) lyricsCache.clear();
          lyricsCache.set(cacheKey, match);
          return match;
        }
      }
    } catch {}

    return null;
  }

  function markUserScrolling() {
    userScrolling = true;
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => { userScrolling = false; }, 3800);
  }

  function createLyricsOverlay() {
    if (document.getElementById('lyricsOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'lyricsOverlay';
    overlay.className = 'lyrics-overlay hidden';
    overlay.innerHTML = `
      <div class="lyrics-backdrop" id="lyricsBackdrop"></div>
      <div class="lyrics-card">
        <header class="lyrics-header">
          <div class="lyrics-track-info">
            <span class="lyrics-tag" id="lyricsModeTag">LYRICS</span>
            <h2 id="lyricsTrackTitle">No Track</h2>
            <p id="lyricsTrackArtist" class="muted">Unknown Artist</p>
          </div>
          <button class="lyrics-close-btn" id="lyricsCloseBtn" title="Close lyrics">&times;</button>
        </header>
        <div class="lyrics-scroll-area" id="lyricsScrollArea">
          <div class="lyrics-lines" id="lyricsLines">
            <div class="lyrics-loading">Loading lyrics...</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('lyricsCloseBtn').onclick = closeLyrics;
    overlay.onclick = (e) => {
      if (e.target === overlay) closeLyrics();
    };

    const scrollArea = document.getElementById('lyricsScrollArea');
    scrollArea.addEventListener('wheel', markUserScrolling, { passive: true });
    scrollArea.addEventListener('touchmove', markUserScrolling, { passive: true });
  }

  function openLyrics() {
    createLyricsOverlay();
    const overlay = document.getElementById('lyricsOverlay');
    overlay.classList.remove('hidden');
    isLyricsOpen = true;
    updateLyricsUI(getActiveTrack());
  }

  function closeLyrics() {
    const overlay = document.getElementById('lyricsOverlay');
    if (overlay) overlay.classList.add('hidden');
    isLyricsOpen = false;
  }

  function toggleLyrics() {
    if (isLyricsOpen) closeLyrics();
    else openLyrics();
  }

  async function updateLyricsUI(track) {
    if (!isLyricsOpen) return;
    createLyricsOverlay();
    const mySeq = ++requestSeq;
    const titleEl = document.getElementById('lyricsTrackTitle');
    const artistEl = document.getElementById('lyricsTrackArtist');
    const linesEl = document.getElementById('lyricsLines');
    const backdropEl = document.getElementById('lyricsBackdrop');
    const tagEl = document.getElementById('lyricsModeTag');

    if (!track) {
      titleEl.textContent = 'Нет активного трека';
      artistEl.textContent = 'Включите песню для показа текста';
      linesEl.innerHTML = '<div class="lyrics-empty">Выберите трек для воспроизведения</div>';
      currentParsed = [];
      return;
    }

    titleEl.textContent = track.title || 'Untitled';
    artistEl.textContent = track.artist || 'Unknown';
    backdropEl.style.backgroundImage = track.artwork ? `url("${track.artwork}")` : 'none';
    linesEl.innerHTML = '<div class="lyrics-loading">Поиск синхронизированного текста...</div>';
    activeIndex = -1;

    const data = await fetchLyrics(track);
    const nowTrack = getActiveTrack();
    if (mySeq !== requestSeq || !isLyricsOpen || (nowTrack && nowTrack.id !== track.id)) return;

    if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
      tagEl.textContent = 'NOT FOUND';
      linesEl.innerHTML = '<div class="lyrics-empty">Текст для этого трека не найден</div>';
      currentParsed = [];
      return;
    }

    if (data.syncedLyrics) {
      tagEl.textContent = 'SYNCED • KARAOKE';
      currentParsed = parseLrc(data.syncedLyrics);
      linesEl.innerHTML = currentParsed.map((item, i) => `
        <div class="lyric-line" data-index="${i}" data-time="${item.time}" style="--ly-i:${Math.min(i, 16)}">
          ${esc(item.text)}
        </div>
      `).join('');

      linesEl.onclick = (e) => {
        const line = e.target.closest('.lyric-line');
        if (!line) return;
        const time = parseFloat(line.dataset.time);
        if (Number.isFinite(time)) {
          userScrolling = false;
          seekPlayback(time);
          syncActiveLine(time, true);
        }
      };
      syncActiveLine(getPlaybackTime(), true);
    } else {
      tagEl.textContent = 'TEXT';
      currentParsed = [];
      const plainLines = String(data.plainLyrics).split(/\r?\n/);
      linesEl.innerHTML = plainLines.map((line, i) => `
        <div class="lyric-line plain" style="--ly-i:${Math.min(i, 16)}">${esc(line || ' ')}</div>
      `).join('');
    }
  }

  function syncActiveLine(currentTime, instant = false) {
    if (!isLyricsOpen || !currentParsed.length) return;
    let newIndex = -1;
    for (let i = currentParsed.length - 1; i >= 0; i--) {
      if (currentTime >= currentParsed[i].time - 0.22) {
        newIndex = i;
        break;
      }
    }
    if (newIndex === activeIndex && !instant) return;
    activeIndex = newIndex;

    const scrollArea = document.getElementById('lyricsScrollArea');
    const lines = document.querySelectorAll('.lyrics-lines .lyric-line');
    lines.forEach((line, i) => {
      line.classList.toggle('active', i === activeIndex);
      line.classList.toggle('passed', i < activeIndex);
      line.classList.toggle('near', Math.abs(i - activeIndex) === 1);
    });

    if (activeIndex >= 0 && !userScrolling && scrollArea) {
      const activeEl = lines[activeIndex];
      if (activeEl) {
        const targetTop = activeEl.offsetTop - (scrollArea.clientHeight * 0.42) + (activeEl.clientHeight * 0.5);
        scrollArea.scrollTo({
          top: Math.max(0, targetTop),
          behavior: instant ? 'auto' : 'smooth'
        });
      }
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    createLyricsOverlay();
  });

  window.mintpyLyrics = {
    open: openLyrics,
    close: closeLyrics,
    toggle: toggleLyrics,
    onTrackChange: updateLyricsUI,
    onTimeUpdate: syncActiveLine
  };
})();
