// ==================================================
// SYNCED LYRICS MODULE (LRCLIB Integration & Zen Karaoke)
// ==================================================
(function() {
  const lyricsCache = new Map();
  let currentLyrics = null;
  let currentParsed = [];
  let isLyricsOpen = false;
  let activeIndex = -1;
  let userScrolling = false;
  let scrollTimeout = null;

  // Clean title/artist for maximum match rate on LRCLIB
  function sanitizeQuery(str) {
    if (!str) return '';
    return str
      .replace(/\s*[\(\[](?:official|video|audio|mv|remastered|lyrics?|visualizer|feat\.|ft\.|hd|4k|hq).*?[\)\]]/gi, '')
      .replace(/[\|\-–—].*$/, '')
      .trim();
  }

  async function fetchLyrics(track) {
    if (!track || !track.title) return null;
    const cacheKey = track.id || (track.title + '::' + track.artist);
    if (lyricsCache.has(cacheKey)) return lyricsCache.get(cacheKey);

    const cleanTitle = sanitizeQuery(track.title);
    const cleanArtist = sanitizeQuery(track.artist);

    // 1. Try exact match
    try {
      const params = new URLSearchParams({
        track_name: cleanTitle,
        artist_name: cleanArtist
      });
      if (track.duration && Number.isFinite(track.duration)) {
        params.set('duration', Math.round(track.duration));
      }
      const res = await fetch(`https://lrclib.net/api/get?${params}`);
      if (res.ok) {
        const data = await res.json();
        if (data && (data.syncedLyrics || data.plainLyrics)) {
          lyricsCache.set(cacheKey, data);
          return data;
        }
      }
    } catch {}

    // 2. Try search query fallback
    try {
      const query = `${cleanArtist} ${cleanTitle}`.trim();
      const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const items = await res.json();
        if (Array.isArray(items) && items.length) {
          const match = items.find(i => i.syncedLyrics) || items[0];
          lyricsCache.set(cacheKey, match);
          return match;
        }
      }
    } catch {}

    return null;
  }

  function parseLrc(lrcText) {
    if (!lrcText) return [];
    const lines = lrcText.split(/\r?\n/);
    const result = [];
    const timeRegex = /\[(\d{2}):(\d{2}(?:\.\d{1,3})?)\]/g;
    for (const rawLine of lines) {
      const matches = [...rawLine.matchAll(timeRegex)];
      if (!matches.length) continue;
      const text = rawLine.replace(timeRegex, '').trim();
      for (const m of matches) {
        const min = parseInt(m[1], 10);
        const sec = parseFloat(m[2]);
        result.push({ time: min * 60 + sec, text: text || '♪' });
      }
    }
    return result.sort((a, b) => a.time - b.time);
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
    overlay.onclick = e => {
      if (e.target === overlay) closeLyrics();
    };

    const scrollArea = document.getElementById('lyricsScrollArea');
    scrollArea.addEventListener('wheel', () => {
      userScrolling = true;
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => { userScrolling = false; }, 3500);
    }, { passive: true });
  }

  function openLyrics() {
    createLyricsOverlay();
    const overlay = document.getElementById('lyricsOverlay');
    overlay.classList.remove('hidden');
    isLyricsOpen = true;
    updateLyricsUI(window.currentTrack);
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
    const titleEl = document.getElementById('lyricsTrackTitle');
    const artistEl = document.getElementById('lyricsTrackArtist');
    const linesEl = document.getElementById('lyricsLines');
    const backdropEl = document.getElementById('lyricsBackdrop');
    const tagEl = document.getElementById('lyricsModeTag');

    if (!track) {
      titleEl.textContent = 'No track playing';
      artistEl.textContent = 'Play a song to view lyrics';
      linesEl.innerHTML = '<div class="lyrics-empty">Select a track to start playback</div>';
      return;
    }

    titleEl.textContent = track.title || 'Untitled';
    artistEl.textContent = track.artist || 'Unknown';
    if (track.artwork) {
      backdropEl.style.backgroundImage = `url("${track.artwork}")`;
    } else {
      backdropEl.style.backgroundImage = 'none';
    }

    linesEl.innerHTML = '<div class="lyrics-loading">Searching lyrics from LRCLIB...</div>';
    activeIndex = -1;

    const data = await fetchLyrics(track);
    if (!isLyricsOpen || window.currentTrack?.id !== track.id) return;

    if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
      tagEl.textContent = 'NOT FOUND';
      linesEl.innerHTML = '<div class="lyrics-empty">No lyrics found for this song</div>';
      currentLyrics = null;
      currentParsed = [];
      return;
    }

    currentLyrics = data;
    if (data.syncedLyrics) {
      tagEl.textContent = 'SYNCED • KARAOKE';
      currentParsed = parseLrc(data.syncedLyrics);
      linesEl.innerHTML = currentParsed.map((item, i) => `
        <div class="lyric-line" data-index="${i}" data-time="${item.time}">
          ${escapeHtml(item.text)}
        </div>
      `).join('');

      linesEl.onclick = e => {
        const line = e.target.closest('.lyric-line');
        if (!line) return;
        const time = parseFloat(line.dataset.time);
        if (Number.isFinite(time) && window.audio) {
          window.audio.currentTime = time;
          userScrolling = false;
        }
      };
      syncActiveLine(window.audio?.currentTime || 0);
    } else {
      tagEl.textContent = 'TEXT';
      currentParsed = [];
      const plainLines = data.plainLyrics.split(/\r?\n/);
      linesEl.innerHTML = plainLines.map(line => `
        <div class="lyric-line plain">${escapeHtml(line || ' ')}</div>
      `).join('');
    }
  }

  function syncActiveLine(currentTime) {
    if (!isLyricsOpen || !currentParsed.length) return;
    // Find active line: last line whose time <= currentTime
    const newIndex = currentParsed.findLastIndex(l => currentTime >= l.time - 0.25);
    if (newIndex === activeIndex) return;
    activeIndex = newIndex;

    const lines = document.querySelectorAll('.lyrics-lines .lyric-line');
    lines.forEach((line, i) => {
      line.classList.toggle('active', i === activeIndex);
      line.classList.toggle('passed', i < activeIndex);
    });

    if (activeIndex >= 0 && !userScrolling) {
      const activeEl = lines[activeIndex];
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Hook into playback updates
  window.addEventListener('load', () => {
    createLyricsOverlay();
    if (window.audio) {
      window.audio.addEventListener('timeupdate', () => {
        if (isLyricsOpen) syncActiveLine(window.audio.currentTime);
      });
    }
  });

  window.mintpyLyrics = {
    open: openLyrics,
    close: closeLyrics,
    toggle: toggleLyrics,
    onTrackChange: updateLyricsUI,
    onTimeUpdate: syncActiveLine
  };
})();
