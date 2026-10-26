// MintPy Mobile Controller - v5.3.8
// Standalone mobile player logic decoupled from PC Electron.

(function () {
  'use strict';

  // State
  let queue = [];
  let currentIndex = -1;
  let currentTrack = null;
  let isPlaying = false;
  let isShuffle = false;
  let isRepeat = false;
  let currentView = 'home';
  let seekDragging = false;

  const bridge = window.api;

  // Audio Deck (Native HTML5 Audio without CORS restrictions)
  const audio = new Audio();
  audio.loop = false;
  audio.volume = 1.0;

  // Settings state
  let settings = {
    appearance: 'dark',
    style: 'zen',
    volumeNormalize: false,
    eqBands: { low: 0, mid: 0, high: 0 },
    crossfadeSeconds: 0
  };

  // Helper DOM selectors
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  function icon(name) {
    return `<svg class="ico"><use href="#ico-${name}"/></svg>`;
  }

  function fmtTime(sec) {
    if (!sec || isNaN(sec) || !isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function safeArtwork(url) {
    return url && typeof url === 'string' && url.trim() ? url : '../assets/mintpy-logo.png';
  }

  // --- AUDIO SETUP & EVENTS ---
  function setupAudio() {
    audio.ontimeupdate = () => {
      updateTimelineUI();
      if (window.mintpyLyrics && window.mintpyLyrics.onTimeUpdate) {
        window.mintpyLyrics.onTimeUpdate(audio.currentTime);
      }
    };

    audio.onloadedmetadata = () => {
      updateTimelineUI();
    };

    audio.ondurationchange = () => {
      updateTimelineUI();
    };

    audio.onplay = () => {
      isPlaying = true;
      if (currentTrack) bridge.recordHistory(currentTrack);
      updateGlobalUI();
    };

    audio.onpause = () => {
      isPlaying = false;
      updateGlobalUI();
    };

    audio.onended = () => {
      if (isRepeat) {
        playTrack(currentTrack, currentIndex);
      } else {
        nextTrack();
      }
    };

    audio.onerror = () => {
      console.warn('Audio playback error:', audio.error?.message || 'unknown');
      isPlaying = false;
      updateGlobalUI();
      if (queue.length > 1) {
        setTimeout(() => nextTrack(), 1000);
      }
    };
  }

  // --- PLAYBACK CONTROL ---
  async function playTrack(track, index, newQueue = null) {
    if (!track) return;
    if (newQueue) queue = [...newQueue];
    currentIndex = index;
    currentTrack = track;
    isPlaying = false;

    updateGlobalUI();
    bridge.savePlaybackState({ queue, currentIndex });

    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();

      // Resolve stream URL via Mobile Bridge
      const streamUrl = await bridge.getTrackAudioUrl(track);
      if (!streamUrl) {
        throw new Error('Unable to resolve audio stream');
      }

      audio.src = streamUrl;
      const playPromise = audio.play();
      if (playPromise) await playPromise;

      isPlaying = true;
      updateGlobalUI();
      if (window.mintpyLyrics && window.mintpyLyrics.onTrackChange) {
        window.mintpyLyrics.onTrackChange(track);
      }
    } catch (e) {
      console.error('Playback failed:', e);
      isPlaying = false;
      updateGlobalUI();
    }
  }

  function togglePlay() {
    if (!audio.src && currentTrack) {
      return playTrack(currentTrack, currentIndex);
    }
    if (!audio.src && queue.length) {
      return playTrack(queue[0], 0);
    }
    if (!audio.src) return;

    if (audio.paused) {
      audio.play().catch(console.warn);
    } else {
      audio.pause();
    }
  }

  function nextTrack() {
    if (!queue.length) return;
    let nextIdx = currentIndex + 1;
    if (nextIdx >= queue.length) {
      if (isRepeat) nextIdx = 0;
      else return;
    }
    playTrack(queue[nextIdx], nextIdx);
  }

  function prevTrack() {
    if (!queue.length) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    let prevIdx = currentIndex - 1;
    if (prevIdx < 0) prevIdx = queue.length - 1;
    playTrack(queue[prevIdx], prevIdx);
  }

  function toggleShuffle() {
    isShuffle = !isShuffle;
    if (isShuffle && queue.length > 1) {
      const cur = currentIndex >= 0 ? queue[currentIndex] : null;
      const rest = queue.filter((_, i) => i !== currentIndex);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      queue = cur ? [cur, ...rest] : rest;
      currentIndex = cur ? 0 : -1;
    }
    updateGlobalUI();
  }

  function toggleRepeat() {
    isRepeat = !isRepeat;
    audio.loop = false;
    updateGlobalUI();
  }

  function seekTo(fraction) {
    if (!audio.duration || !isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, fraction * audio.duration));
    updateTimelineUI();
  }

  // --- UI SYNC ---
  function updateTimelineUI() {
    const cur = audio.currentTime || 0;
    const dur = audio.duration && isFinite(audio.duration) ? audio.duration : (currentTrack?.duration || 0);
    const pct = dur > 0 ? (cur / dur) * 100 : 0;

    // Home timeline elements
    const fill = $('#homeSeekFill');
    const curEl = $('#homeCurTime');
    const totEl = $('#homeTotTime');
    const thumb = $('#homeSeekThumb');
    if (fill) fill.style.width = `${pct}%`;
    if (thumb) thumb.style.left = `${pct}%`;
    if (curEl) curEl.textContent = fmtTime(cur);
    if (totEl) totEl.textContent = fmtTime(dur);

    // Mini player progress fill
    const miniFill = $('#miniProgressFill');
    if (miniFill) miniFill.style.width = `${pct}%`;
  }

  function updateGlobalUI() {
    // 1. Home View Turntable & Play button
    const homeCover = $('#homeCover');
    const homeVinyl = $('#homeVinyl');
    const homeVinylLabel = $('#homeVinylLabel');
    const homeTitle = $('#homeTitle');
    const homeArtist = $('#homeArtist');
    const homePlayBtn = $('#homePlayBtn');
    const homeShuffleBtn = $('#homeShuffleBtn');
    const homeRepeatBtn = $('#homeRepeatBtn');
    const homeFavBtn = $('#homeFavBtn');

    if (homeCover && currentTrack) {
      homeCover.src = safeArtwork(currentTrack.artwork);
      if (homeVinylLabel) homeVinylLabel.src = safeArtwork(currentTrack.artwork);
      if (homeTitle) homeTitle.textContent = currentTrack.title || 'Untitled';
      if (homeArtist) homeArtist.textContent = currentTrack.artist || 'Unknown';
    }

    if (homeVinyl) {
      homeVinyl.classList.toggle('playing', isPlaying);
    }

    if (homePlayBtn) {
      homePlayBtn.innerHTML = isPlaying ? icon('pause') : icon('play');
    }
    if (homeShuffleBtn) {
      homeShuffleBtn.classList.toggle('active', isShuffle);
    }
    if (homeRepeatBtn) {
      homeRepeatBtn.classList.toggle('active', isRepeat);
    }

    if (homeFavBtn && currentTrack) {
      bridge.getFavorites().then(favs => {
        const isFaved = favs.some(f => f.id === currentTrack.id);
        homeFavBtn.innerHTML = isFaved ? icon('heart') : icon('heart-o');
        homeFavBtn.classList.toggle('active', isFaved);
      });
    }

    // 2. Mini Player
    const miniPlayer = $('#miniPlayer');
    const miniArt = $('#miniArt');
    const miniTitle = $('#miniTitle');
    const miniArtist = $('#miniArtist');
    const miniPlayBtn = $('#miniPlayBtn');
    const miniArtDisc = $('#miniArtDisc');

    if (currentView !== 'home' && currentTrack) {
      miniPlayer.classList.add('visible');
      miniArt.src = safeArtwork(currentTrack.artwork);
      miniTitle.textContent = currentTrack.title || 'Untitled';
      miniArtist.textContent = currentTrack.artist || 'Unknown';
      miniPlayBtn.innerHTML = isPlaying ? icon('pause') : icon('play');
      if (miniArtDisc) miniArtDisc.classList.toggle('playing', isPlaying);
    } else {
      miniPlayer.classList.remove('visible');
    }

    // 3. Android MediaSession & Notification Lockscreen
    if (window.updateMobileMediaSession) {
      window.updateMobileMediaSession(currentTrack, isPlaying);
    }
  }

  // --- VIEW ROUTING ---
  function navigate(viewName) {
    currentView = viewName;
    $$('.nav-tab').forEach(t => {
      const isTab = t.dataset.view === viewName || (viewName === 'history' && t.dataset.view === 'favorites');
      t.classList.toggle('active', isTab);
    });

    const root = $('#viewRoot');
    root.innerHTML = '';

    if (viewName === 'home') renderHome(root);
    else if (viewName === 'search') renderSearch(root);
    else if (viewName === 'favorites') renderFavorites(root, 'favorites');
    else if (viewName === 'history') renderFavorites(root, 'history');
    else if (viewName === 'playlists') renderPlaylists(root);
    else if (viewName === 'settings') renderSettings(root);

    updateGlobalUI();
  }

  // ==================== HOME VIEW RENDERER ====================
  function renderHome(container) {
    const artUrl = safeArtwork(currentTrack?.artwork);
    const ttl = currentTrack?.title || 'Nothing playing';
    const art = currentTrack?.artist || 'Choose a track in Search';

    container.innerHTML = `
      <div class="home-container">
        <!-- Turntable Stage: Vinyl is strictly smaller than cover so it never protrudes top/bottom -->
        <div class="home-art-stage">
          <img class="home-cover" id="homeCover" src="${artUrl}" alt="Album Art">
          <div class="home-vinyl ${isPlaying ? 'playing' : ''}" id="homeVinyl">
            <img class="home-vinyl-label" id="homeVinylLabel" src="${artUrl}" alt="Vinyl Label">
            <span class="home-vinyl-hole"></span>
          </div>
        </div>

        <!-- Track Metadata -->
        <div class="home-track-meta">
          <h2 class="home-title" id="homeTitle">${esc(ttl)}</h2>
          <span class="home-artist" id="homeArtist">${esc(art)}</span>
        </div>

        <!-- Timeline -->
        <div class="home-timeline">
          <div class="timeline-bar" id="homeSeekBar">
            <div class="timeline-track">
              <div class="timeline-fill" id="homeSeekFill"></div>
            </div>
            <div class="timeline-thumb" id="homeSeekThumb"></div>
          </div>
          <div class="timeline-time">
            <span id="homeCurTime">0:00</span>
            <span id="homeTotTime">0:00</span>
          </div>
        </div>

        <!-- Primary Controls -->
        <div class="home-controls">
          <button class="home-ctrl-btn ${isShuffle ? 'active' : ''}" id="homeShuffleBtn" title="Перемешать">
            ${icon('shuffle')}
          </button>
          <button class="home-ctrl-btn" id="homePrevBtn" title="Предыдущий">
            ${icon('prev')}
          </button>
          <button class="home-play-btn" id="homePlayBtn" title="Воспроизведение">
            ${isPlaying ? icon('pause') : icon('play')}
          </button>
          <button class="home-ctrl-btn" id="homeNextBtn" title="Следующий">
            ${icon('next')}
          </button>
          <button class="home-ctrl-btn ${isRepeat ? 'active' : ''}" id="homeRepeatBtn" title="Повтор">
            ${icon('repeat')}
          </button>
        </div>

        <!-- Secondary Actions -->
        <div class="home-sub-actions">
          <button class="home-sub-btn" id="homeFavBtn">
            ${icon('heart-o')} <span>В избранное</span>
          </button>
          <button class="home-sub-btn" id="homeAddToPlBtn">
            ${icon('add-to-list')} <span>В плейлист</span>
          </button>
          <button class="home-sub-btn" id="homeLyricsBtn">
            ${icon('lyrics')} <span>Текст</span>
          </button>
        </div>
      </div>
    `;

    // Bind Home UI
    $('#homePlayBtn').onclick = togglePlay;
    const coverEl = $('#homeCover');
    if (coverEl) coverEl.onclick = togglePlay;
    const vinylEl = $('#homeVinyl');
    if (vinylEl) vinylEl.onclick = togglePlay;
    $('#homePrevBtn').onclick = prevTrack;
    $('#homeNextBtn').onclick = nextTrack;
    $('#homeShuffleBtn').onclick = toggleShuffle;
    $('#homeRepeatBtn').onclick = toggleRepeat;

    $('#homeFavBtn').onclick = async () => {
      if (!currentTrack) return;
      const favs = await bridge.getFavorites();
      const isFaved = favs.some(f => f.id === currentTrack.id);
      if (isFaved) {
        await bridge.removeFavorite(currentTrack.id);
      } else {
        await bridge.addFavorite(currentTrack);
      }
      updateGlobalUI();
    };

    const addToPlBtn = $('#homeAddToPlBtn');
    if (addToPlBtn) {
      addToPlBtn.onclick = async () => {
        if (!currentTrack) return;
        const pls = await bridge.getPlaylists();
        if (!pls.length) {
          const name = window.prompt('Нет плейлистов. Создайте первый:');
          if (name && name.trim()) {
            const newPl = await bridge.createPlaylist(name.trim());
            await bridge.addToPlaylist(newPl.id, currentTrack);
            alert(`Трек добавлен в "${name.trim()}"`);
          }
          return;
        }
        const names = pls.map((p, i) => `${i + 1}. ${p.name} (${p.tracks?.length || 0})`).join('\n');
        const choice = window.prompt(`Выберите плейлист (введите номер):\n${names}`);
        if (choice) {
          const idx = parseInt(choice, 10) - 1;
          if (idx >= 0 && idx < pls.length) {
            await bridge.addToPlaylist(pls[idx].id, currentTrack);
            alert(`Трек добавлен в "${pls[idx].name}"`);
          }
        }
      };
    }

    const lyrBtn = $('#homeLyricsBtn');
    if (lyrBtn) {
      lyrBtn.onclick = () => window.mintpyLyrics && window.mintpyLyrics.toggle();
    }

    const seekBar = $('#homeSeekBar');
    const handleSeek = (e) => {
      const rect = seekBar.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      seekTo(frac);
    };

    seekBar.onmousedown = (e) => { seekDragging = true; handleSeek(e); };
    seekBar.ontouchstart = (e) => { seekDragging = true; handleSeek(e); };
    window.onmousemove = (e) => { if (seekDragging) handleSeek(e); };
    window.ontouchmove = (e) => { if (seekDragging) handleSeek(e); };
    window.onmouseup = () => { seekDragging = false; };
    window.ontouchend = () => { seekDragging = false; };

    updateTimelineUI();
  }

  // ==================== SEARCH VIEW RENDERER ====================
  let lastSearchQuery = '';
  let lastSearchResults = [];

  function renderSearch(container) {
    container.innerHTML = `
      <div class="search-container">
        <div class="search-box-row">
          <svg class="search-input-icon"><use href="#ico-search"/></svg>
          <input type="text" class="search-input" id="mobileSearchInput" placeholder="Поиск треков или исполнителей..." value="${esc(lastSearchQuery)}">
          <button class="search-go-btn" id="mobileSearchBtn">Найти</button>
        </div>
        <div class="track-list" id="searchResults">
          ${lastSearchResults.length ? '' : '<div class="empty-state"><h3>Найдите музыку</h3><p>Введите запрос для мгновенного поиска</p></div>'}
        </div>
      </div>
    `;

    const input = $('#mobileSearchInput');
    const btn = $('#mobileSearchBtn');
    const resultsContainer = $('#searchResults');

    if (lastSearchResults.length) {
      renderTrackRows(resultsContainer, lastSearchResults);
    }

    const doSearch = async () => {
      const q = input.value.trim();
      if (!q) return;
      lastSearchQuery = q;
      resultsContainer.innerHTML = '<div class="empty-state"><p>Поиск треков...</p></div>';

      try {
        const tracks = await bridge.searchTracks(q);
        lastSearchResults = tracks;
        if (!tracks || !tracks.length) {
          resultsContainer.innerHTML = '<div class="empty-state"><h3>Ничего не найдено</h3><p>Попробуйте другой запрос</p></div>';
          return;
        }
        renderTrackRows(resultsContainer, tracks);
      } catch (e) {
        resultsContainer.innerHTML = `<div class="empty-state"><h3>Ошибка поиска</h3><p>${esc(e.message)}</p></div>`;
      }
    };

    btn.onclick = doSearch;
    input.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  }

  function renderTrackRows(container, tracks) {
    container.innerHTML = tracks.map((t, idx) => `
      <div class="track-row ${currentTrack?.id === t.id ? 'active' : ''}" data-idx="${idx}">
        <img class="track-thumb" src="${safeArtwork(t.artwork)}" alt="">
        <div class="track-info">
          <span class="track-ttl">${esc(t.title)}</span>
          <span class="track-art">${esc(t.artist)}</span>
        </div>
        <span class="track-dur">${fmtTime(t.duration)}</span>
        <button class="track-action-btn fav-btn" data-id="${esc(t.id)}" title="Любимое">
          ${icon('heart-o')}
        </button>
      </div>
    `).join('');

    // Update favorite heart icons
    bridge.getFavorites().then(favs => {
      const favSet = new Set(favs.map(f => f.id));
      container.querySelectorAll('.fav-btn').forEach(b => {
        if (favSet.has(b.dataset.id)) {
          b.classList.add('faved');
          b.innerHTML = icon('heart');
        }
      });
    });

    container.onclick = async (e) => {
      const favBtn = e.target.closest('.fav-btn');
      if (favBtn) {
        e.stopPropagation();
        const row = favBtn.closest('.track-row');
        const idx = parseInt(row.dataset.idx, 10);
        const t = tracks[idx];
        const isFaved = favBtn.classList.contains('faved');
        if (isFaved) {
          await bridge.removeFavorite(t.id);
          favBtn.classList.remove('faved');
          favBtn.innerHTML = icon('heart-o');
        } else {
          await bridge.addFavorite(t);
          favBtn.classList.add('faved');
          favBtn.innerHTML = icon('heart');
        }
        return;
      }

      const row = e.target.closest('.track-row');
      if (row) {
        const idx = parseInt(row.dataset.idx, 10);
        playTrack(tracks[idx], idx, tracks);
      }
    };
  }

  // ==================== FAVORITES & HISTORY VIEW RENDERER ====================
  async function renderFavorites(container, initialTab = 'favorites') {
    let currentTab = initialTab;
    const favs = await bridge.getFavorites();
    const history = await bridge.getHistory();

    function renderTab() {
      const isFav = currentTab === 'favorites';
      const count = isFav ? favs.length : history.length;
      container.innerHTML = `
        <div class="search-container">
          <div class="sub-nav-segment">
            <button class="sub-nav-btn ${isFav ? 'active' : ''}" id="tabFavsBtn">
              ${icon('heart')} <span>Любимое (${favs.length})</span>
            </button>
            <button class="sub-nav-btn ${!isFav ? 'active' : ''}" id="tabHistBtn">
              ${icon('history')} <span>История (${history.length})</span>
            </button>
          </div>

          <div style="display:flex;align-items:center;justify-content:space-between;padding:0 2px;">
            <h2 style="font-family:var(--font-serif);font-size:18px;">
              ${isFav ? 'Любимые треки' : 'История прослушивания'}
            </h2>
            ${!isFav && history.length ? `
              <button class="search-go-btn" id="clearHistBtn" style="height:32px;padding:0 10px;font-size:12px;background:rgba(239,68,68,0.2);color:#ef4444;border:1px solid rgba(239,68,68,0.4);">
                Очистить
              </button>
            ` : ''}
          </div>

          <div class="track-list" id="favListResults">
            ${count ? '' : `<div class="empty-state"><h3>${isFav ? 'Список пуст' : 'История пуста'}</h3><p>${isFav ? 'Добавляйте понравившиеся треки сердечком' : 'Здесь появятся недавно воспроизведённые треки'}</p></div>`}
          </div>
        </div>
      `;

      $('#tabFavsBtn').onclick = () => { currentTab = 'favorites'; renderTab(); };
      $('#tabHistBtn').onclick = () => { currentTab = 'history'; renderTab(); };

      const clearBtn = $('#clearHistBtn');
      if (clearBtn) {
        clearBtn.onclick = async () => {
          if (confirm('Очистить историю прослушивания?')) {
            await bridge.clearHistory();
            history.length = 0;
            renderTab();
          }
        };
      }

      const listEl = $('#favListResults');
      if (isFav && favs.length) {
        renderTrackRows(listEl, favs);
      } else if (!isFav && history.length) {
        renderTrackRows(listEl, history);
      }
    }

    renderTab();
  }

  // ==================== PLAYLISTS VIEW RENDERER ====================
  async function renderPlaylists(container) {
    const pls = await bridge.getPlaylists();
    container.innerHTML = `
      <div class="search-container">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <h2 style="font-family:var(--font-serif);font-size:18px;margin:0;">Плейлисты (${pls.length})</h2>
          <div style="display:flex;gap:6px;">
            <button class="search-go-btn" id="importToggleBtn" style="height:34px;padding:0 10px;font-size:12px;" title="Импорт плейлиста из Яндекс / Spotify / YouTube">
              ${icon('import')} Импорт
            </button>
            <button class="search-go-btn" id="exportAllPlBtn" style="height:34px;padding:0 10px;font-size:12px;" title="Экспорт всех плейлистов">
              ${icon('download')}
            </button>
            <button class="search-go-btn" id="newPlBtn" style="height:34px;padding:0 10px;font-size:13px;">+ Создать</button>
          </div>
        </div>

        <!-- Import Form -->
        <div class="import-card" id="importCard" style="display:none;background:var(--surface-hover);border-radius:var(--radius-sm);padding:12px;margin:10px 0;border:1px solid rgba(255,255,255,0.08);">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px;display:flex;align-items:center;gap:6px;">
            ${icon('link')} Импорт плейлиста или альбома
          </div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.4;">
            Вставьте ссылку из <b>Яндекс Музыки</b>, <b>Spotify</b> или <b>YouTube Music</b>:
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="url" id="importUrlInput" class="search-input" placeholder="https://..." style="flex:1;height:38px;font-size:13px;">
            <button class="search-go-btn" id="doImportBtn" style="height:38px;padding:0 14px;font-size:13px;white-space:nowrap;">Загрузить</button>
          </div>
          <div id="importStatus" style="font-size:12px;margin-top:8px;display:none;line-height:1.4;"></div>
        </div>

        ${currentTrack ? `
        <div style="margin:10px 0 6px;padding:10px 12px;background:var(--surface-hover);border-radius:var(--radius-sm);display:flex;align-items:center;gap:10px;">
          <img src="${safeArtwork(currentTrack.artwork)}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;color:var(--muted);margin-bottom:2px;">Добавить текущий трек в:</div>
            <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(currentTrack.title)}</div>
          </div>
        </div>
        ` : ''}
        <div class="track-list" id="plContainer">
          ${pls.length ? '' : '<div class="empty-state"><h3>Нет плейлистов</h3><p>Создайте свой первый плейлист или импортируйте по ссылке</p></div>'}
        </div>
      </div>
    `;

    // Import Toggle and Submit
    const importToggleBtn = $('#importToggleBtn');
    const importCard = $('#importCard');
    const importUrlInput = $('#importUrlInput');
    const doImportBtn = $('#doImportBtn');
    const importStatus = $('#importStatus');

    if (importToggleBtn && importCard) {
      importToggleBtn.onclick = () => {
        const isHidden = importCard.style.display === 'none';
        importCard.style.display = isHidden ? 'block' : 'none';
        if (isHidden && importUrlInput) importUrlInput.focus();
      };
    }

    if (doImportBtn && importUrlInput && importStatus) {
      const handleImport = async () => {
        const url = importUrlInput.value.trim();
        if (!url) {
          importStatus.style.display = 'block';
          importStatus.style.color = '#ff6b6b';
          importStatus.textContent = 'Вставьте ссылку на плейлист или альбом';
          return;
        }

        doImportBtn.disabled = true;
        doImportBtn.textContent = '...';
        importStatus.style.display = 'block';
        importStatus.style.color = 'var(--gold, #ffd166)';
        importStatus.textContent = 'Подключение и загрузка треков...';

        try {
          const res = await bridge.importPlaylistFromUrl(url);
          importStatus.style.color = '#06d6a0';
          importStatus.textContent = `Плейлист "${res.name}" успешно импортирован (${res.trackCount} треков)!`;
          importUrlInput.value = '';
          setTimeout(() => {
            renderPlaylistDetail(container, res);
          }, 800);
        } catch (err) {
          importStatus.style.color = '#ff6b6b';
          importStatus.textContent = err.message || 'Ошибка импорта';
        } finally {
          doImportBtn.disabled = false;
          doImportBtn.textContent = 'Загрузить';
        }
      };

      doImportBtn.onclick = handleImport;
      importUrlInput.onkeydown = (e) => {
        if (e.key === 'Enter') handleImport();
      };
    }

    // Export all playlists
    const exportAllBtn = $('#exportAllPlBtn');
    if (exportAllBtn) {
      exportAllBtn.onclick = () => {
        if (!pls.length) { alert('Нет плейлистов для экспорта'); return; }
        const dump = { mintpy_playlists: pls, exported_at: new Date().toISOString() };
        const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mintpy-playlists-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      };
    }

    $('#newPlBtn').onclick = async () => {
      const name = window.prompt('Название нового плейлиста:');
      if (name && name.trim()) {
        await bridge.createPlaylist(name.trim());
        renderPlaylists(container);
      }
    };

    if (pls.length) {
      const plCont = $('#plContainer');
      plCont.innerHTML = pls.map(p => `
        <div class="track-row" data-plid="${esc(p.id)}">
          <div style="width:44px;height:44px;border-radius:var(--radius-sm);background:var(--surface-hover);display:flex;align-items:center;justify-content:center;color:var(--accent);">
            ${icon('playlist')}
          </div>
          <div class="track-info">
            <span class="track-ttl">${esc(p.name)}</span>
            <span class="track-art">${p.tracks ? p.tracks.length : 0} треков</span>
          </div>
          ${currentTrack ? `
          <button class="track-action-btn pl-add-btn" data-plid="${esc(p.id)}" title="Добавить текущий трек">
            ${icon('plus')}
          </button>
          ` : ''}
          <button class="track-action-btn pl-export-btn" data-plid="${esc(p.id)}" title="Экспорт плейлиста">
            ${icon('download')}
          </button>
          <button class="track-action-btn pl-del-btn" data-plid="${esc(p.id)}" title="Удалить">
            ${icon('trash')}
          </button>
        </div>
      `).join('');

      plCont.onclick = async (e) => {
        // Add current track to playlist
        const addBtn = e.target.closest('.pl-add-btn');
        if (addBtn) {
          e.stopPropagation();
          if (currentTrack) {
            await bridge.addToPlaylist(addBtn.dataset.plid, currentTrack);
            renderPlaylists(container);
          }
          return;
        }

        // Export single playlist
        const expBtn = e.target.closest('.pl-export-btn');
        if (expBtn) {
          e.stopPropagation();
          const pl = pls.find(p => p.id === expBtn.dataset.plid);
          if (pl) {
            const dump = { mintpy_playlist: pl, exported_at: new Date().toISOString() };
            const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `mintpy-playlist-${pl.name.replace(/[^a-zA-Zа-яА-Я0-9]/g, '_')}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }
          return;
        }

        // Delete playlist
        const delBtn = e.target.closest('.pl-del-btn');
        if (delBtn) {
          e.stopPropagation();
          if (window.confirm('Удалить этот плейлист?')) {
            await bridge.deletePlaylist(delBtn.dataset.plid);
            renderPlaylists(container);
          }
          return;
        }

        // Open playlist detail
        const row = e.target.closest('.track-row');
        if (row) {
          const pl = pls.find(p => p.id === row.dataset.plid);
          if (pl) {
            renderPlaylistDetail(container, pl);
          }
        }
      };
    }
  }

  // ==================== PLAYLIST DETAIL VIEW ====================
  async function renderPlaylistDetail(container, playlist) {
    const tracks = playlist.tracks || [];
    container.innerHTML = `
      <div class="search-container">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <button class="track-action-btn" id="plBackBtn" title="Назад" style="width:36px;height:36px;">
            ${icon('back')}
          </button>
          <div style="flex:1;min-width:0;">
            <h2 style="font-family:var(--font-serif);font-size:17px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(playlist.name)}</h2>
            <span style="font-size:12px;color:var(--muted);">${tracks.length} треков</span>
          </div>
          <button class="search-go-btn" id="plPlayAllBtn" style="height:34px;padding:0 12px;font-size:12px;" ${!tracks.length ? 'disabled' : ''}>
            ${icon('play')} Играть
          </button>
          <button class="search-go-btn" id="plExportBtn" style="height:34px;padding:0 10px;font-size:12px;" title="Экспорт">
            ${icon('download')}
          </button>
        </div>
        <div class="track-list" id="plDetailTracks">
          ${tracks.length ? '' : '<div class="empty-state"><h3>Плейлист пуст</h3><p>Добавьте треки через поиск или с главного экрана</p></div>'}
        </div>
      </div>
    `;

    $('#plBackBtn').onclick = () => renderPlaylists(container);

    $('#plPlayAllBtn').onclick = () => {
      if (tracks.length) {
        playTrack(tracks[0], 0, tracks);
      }
    };

    $('#plExportBtn').onclick = () => {
      const dump = { mintpy_playlist: playlist, exported_at: new Date().toISOString() };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mintpy-playlist-${playlist.name.replace(/[^a-zA-Zа-яА-Я0-9]/g, '_')}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

    if (tracks.length) {
      const listEl = $('#plDetailTracks');
      listEl.innerHTML = tracks.map((t, i) => `
        <div class="track-row" data-idx="${i}">
          <img class="track-thumb" src="${safeArtwork(t.artwork)}" alt="">
          <div class="track-info">
            <span class="track-ttl">${esc(t.title)}</span>
            <span class="track-art">${esc(t.artist)}${t.duration ? ' · ' + fmtTime(t.duration) : ''}</span>
          </div>
          <button class="track-action-btn pl-remove-btn" data-idx="${i}" title="Удалить из плейлиста">
            ${icon('trash')}
          </button>
        </div>
      `).join('');

      listEl.onclick = async (e) => {
        const rmBtn = e.target.closest('.pl-remove-btn');
        if (rmBtn) {
          e.stopPropagation();
          const idx = parseInt(rmBtn.dataset.idx, 10);
          const track = tracks[idx];
          if (track) {
            await bridge.removeFromPlaylist(playlist.id, track.id);
            // Re-fetch playlist
            const pls = await bridge.getPlaylists();
            const updated = pls.find(p => p.id === playlist.id);
            if (updated) {
              renderPlaylistDetail(container, updated);
            } else {
              renderPlaylists(container);
            }
          }
          return;
        }

        const row = e.target.closest('.track-row');
        if (row) {
          const idx = parseInt(row.dataset.idx, 10);
          playTrack(tracks[idx], idx, tracks);
        }
      };
    }
  }

  // ==================== SETTINGS VIEW (CLEAN MOBILE) ====================
  function renderSettings(container) {
    const styles = [
      { id: 'zen', name: 'Zen', emoji: '🎋' },
      { id: 'lofi', name: 'Lo-Fi', emoji: '☕' },
      { id: 'synthwave', name: 'Synthwave', emoji: '🌆' },
      { id: 'ocean', name: 'Ocean', emoji: '🌊' },
      { id: 'forest', name: 'Forest', emoji: '🌲' },
      { id: 'aurora', name: 'Aurora', emoji: '✨' }
    ];

    container.innerHTML = `
      <div class="settings-container">
        <!-- 1. Style Theme -->
        <div class="settings-group">
          <div class="group-title">🎨 Тема оформления</div>
          <div class="style-grid">
            ${styles.map(s => `
              <div class="style-card ${settings.style === s.id ? 'active' : ''}" data-style="${s.id}">
                <span>${s.name} ${s.emoji}</span>
                ${settings.style === s.id ? icon('check') : ''}
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 2. Appearance -->
        <div class="settings-group">
          <div class="group-title">🌓 Цветовая схема</div>
          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-title">Режим</span>
              <span class="setting-desc">Тёмное или светлое оформление</span>
            </div>
            <div class="segmented-control">
              <button class="segment-btn ${settings.appearance === 'dark' ? 'active' : ''}" data-app="dark">Тёмная</button>
              <button class="segment-btn ${settings.appearance === 'light' ? 'active' : ''}" data-app="light">Светлая</button>
            </div>
          </div>
        </div>

        <!-- 3. Audio & Equalizer -->
        <div class="settings-group">
          <div class="group-title">🎚️ Звук и Эквалайзер</div>
          
          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-title">Нормализация громкости</span>
              <span class="setting-desc">Выравнивание громкости треков</span>
            </div>
            <input type="checkbox" id="setNorm" ${settings.volumeNormalize ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--accent);">
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-title">Кроссфейд</span>
              <span class="setting-desc" id="crossfadeVal">${settings.crossfadeSeconds || 0} сек</span>
            </div>
            <input type="range" id="setCrossfade" min="0" max="10" step="1" value="${settings.crossfadeSeconds || 0}" style="width:120px;accent-color:var(--accent);">
          </div>

          <div class="eq-sliders" style="margin-top:6px;">
            <div class="eq-row">
              <span class="eq-name">Бас</span>
              <input type="range" class="eq-slider" id="eqLow" min="-12" max="12" step="1" value="${settings.eqBands?.low || 0}">
              <span class="eq-val" id="eqLowVal">${settings.eqBands?.low || 0}dB</span>
            </div>
            <div class="eq-row">
              <span class="eq-name">Средние</span>
              <input type="range" class="eq-slider" id="eqMid" min="-12" max="12" step="1" value="${settings.eqBands?.mid || 0}">
              <span class="eq-val" id="eqMidVal">${settings.eqBands?.mid || 0}dB</span>
            </div>
            <div class="eq-row">
              <span class="eq-name">Высокие</span>
              <input type="range" class="eq-slider" id="eqHigh" min="-12" max="12" step="1" value="${settings.eqBands?.high || 0}">
              <span class="eq-val" id="eqHighVal">${settings.eqBands?.high || 0}dB</span>
            </div>
          </div>
        </div>

        <!-- 4. Transfer Music / Import Playlist -->
        <div class="settings-group">
          <div class="group-title">🔗 Перенос музыки / Импорт плейлиста</div>
          <div class="setting-desc" style="margin-bottom:8px;">
            Вставьте ссылку на открытый плейлист или альбом из <b>Яндекс Музыки</b>, <b>Spotify</b> или <b>YouTube Music</b>.
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="url" id="settingsImportInput" class="search-input" placeholder="https://..." style="flex:1;height:38px;font-size:13px;">
            <button class="action-btn" id="settingsImportBtn" style="height:38px;padding:0 14px;font-size:13px;white-space:nowrap;">Импорт</button>
          </div>
          <div id="settingsImportStatus" style="font-size:12px;margin-top:8px;display:none;line-height:1.4;"></div>
        </div>

        <!-- 5. Backup & Restore -->
        <div class="settings-group">
          <div class="group-title">💾 Резервная копия</div>
          <div class="setting-desc">Экспорт избранного, плейлистов и настроек в JSON файл.</div>
          <div class="backup-actions">
            <button class="action-btn" id="exportBackupBtn">Экспорт JSON</button>
            <button class="action-btn" id="importBackupBtn">Импорт JSON</button>
          </div>
        </div>

        <!-- 6. App Info -->
        <div class="settings-group">
          <div class="group-title">ℹ️ О MintPy Mobile</div>
          <div class="setting-desc" style="line-height:1.6;">
            <strong>MintPy Mobile v5.3.8</strong><br>
            Автор: <strong>Иван Dasert</strong><br>
            Портативный дзэн-плеер с фоновыми атмосферами.
          </div>
        </div>
      </div>
    `;

    // Bind Settings
    $$('.style-card').forEach(card => {
      card.onclick = () => {
        applyStyle(card.dataset.style);
        renderSettings(container);
      };
    });

    $$('.segment-btn[data-app]').forEach(btn => {
      btn.onclick = () => {
        applyAppearance(btn.dataset.app);
        renderSettings(container);
      };
    });

    $('#setNorm').onchange = (e) => {
      settings.volumeNormalize = e.target.checked;
      bridge.saveSettings(settings);
    };

    $('#setCrossfade').oninput = (e) => {
      const v = Number(e.target.value);
      settings.crossfadeSeconds = v;
      $('#crossfadeVal').textContent = `${v} сек`;
      bridge.saveSettings(settings);
    };

    const bindEq = (id, band, valId) => {
      const el = $(id);
      if (el) {
        el.oninput = (e) => {
          const v = Number(e.target.value);
          if (!settings.eqBands) settings.eqBands = {};
          settings.eqBands[band] = v;
          $(valId).textContent = `${v > 0 ? '+' : ''}${v}dB`;
          bridge.saveSettings(settings);
        };
      }
    };
    bindEq('#eqLow', 'low', '#eqLowVal');
    bindEq('#eqMid', 'mid', '#eqMidVal');
    bindEq('#eqHigh', 'high', '#eqHighVal');

    const setImportBtn = $('#settingsImportBtn');
    const setImportInput = $('#settingsImportInput');
    const setImportStatus = $('#settingsImportStatus');
    if (setImportBtn && setImportInput && setImportStatus) {
      const handleSettingsImport = async () => {
        const url = setImportInput.value.trim();
        if (!url) return;
        setImportBtn.disabled = true;
        setImportBtn.textContent = '...';
        setImportStatus.style.display = 'block';
        setImportStatus.style.color = 'var(--gold, #ffd166)';
        setImportStatus.textContent = 'Загрузка треков из сервиса...';
        try {
          const res = await bridge.importPlaylistFromUrl(url);
          setImportStatus.style.color = '#06d6a0';
          setImportStatus.textContent = `Успешно: "${res.name}" (${res.trackCount} треков)!`;
          setImportInput.value = '';
        } catch (err) {
          setImportStatus.style.color = '#ff6b6b';
          setImportStatus.textContent = err.message || 'Ошибка импорта';
        } finally {
          setImportBtn.disabled = false;
          setImportBtn.textContent = 'Импорт';
        }
      };
      setImportBtn.onclick = handleSettingsImport;
      setImportInput.onkeydown = e => { if (e.key === 'Enter') handleSettingsImport(); };
    }

    $('#exportBackupBtn').onclick = () => bridge.exportBackup();
    $('#importBackupBtn').onclick = () => bridge.importBackup();
  }

  function applyStyle(styleName) {
    settings.style = styleName;
    document.documentElement.setAttribute('data-style', styleName);
    document.body.setAttribute('data-style', styleName);
    const appEl = $('.mobile-app');
    if (appEl) appEl.setAttribute('data-style', styleName);
    const styleTags = {
      zen: 'Zen 🎋', lofi: 'Lo-Fi ☕', synthwave: 'Synthwave 🌆',
      ocean: 'Ocean 🌊', forest: 'Forest 🌲', aurora: 'Aurora ✨'
    };
    const tag = $('#headerStyleTag');
    if (tag) tag.textContent = styleTags[styleName] || styleName;
    bridge.saveSettings(settings);
  }

  function updateThemeButtonUI() {
    const ico = $('#headerThemeIco');
    if (!ico) return;
    const isDark = settings.appearance === 'dark';
    ico.innerHTML = `<use href="#ico-${isDark ? 'sun' : 'moon'}"/>`;
    const btn = $('#headerThemeBtn');
    if (btn) btn.title = isDark ? 'Переключить на светлую тему' : 'Переключить на тёмную тему';
  }

  function toggleTheme() {
    const newMode = settings.appearance === 'dark' ? 'light' : 'dark';
    applyAppearance(newMode);
    updateThemeButtonUI();
  }

  function applyAppearance(mode) {
    settings.appearance = mode;
    document.documentElement.setAttribute('data-theme', mode);
    document.body.setAttribute('data-theme', mode);
    const appEl = $('.mobile-app');
    if (appEl) appEl.setAttribute('data-theme', mode);
    updateThemeButtonUI();
    bridge.saveSettings(settings);
  }

  // --- INITIALIZATION ---
  async function init() {
    setupAudio();

    // Load saved settings
    settings = await bridge.getSettings();
    applyStyle(settings.style || 'zen');
    applyAppearance(settings.appearance || 'dark');
    updateThemeButtonUI();

    // Restore last playback state
    const savedState = await bridge.getPlaybackState();
    if (savedState && Array.isArray(savedState.queue) && savedState.queue.length) {
      queue = savedState.queue;
      currentIndex = Math.max(0, Math.min(queue.length - 1, savedState.currentIndex || 0));
      currentTrack = queue[currentIndex] || null;
    }

    // Bind Navigation
    $$('.nav-tab').forEach(tab => {
      tab.onclick = () => navigate(tab.dataset.view);
    });

    // Bind Mini Player
    $('#miniPlayerOpen').onclick = () => navigate('home');
    $('#miniPlayBtn').onclick = togglePlay;
    $('#miniNextBtn').onclick = nextTrack;

    // Header Action Buttons (Theme Switcher, History, Ambient Soundscapes, Sleep Timer)
    const themeBtn = $('#headerThemeBtn');
    if (themeBtn) themeBtn.onclick = toggleTheme;

    const histBtn = $('#headerHistoryBtn');
    if (histBtn) histBtn.onclick = () => navigate('history');

    const ambBtn = $('#headerAmbientBtn');
    if (ambBtn) ambBtn.onclick = () => window.mintpyAmbient && window.mintpyAmbient.toggle();

    const sleepBtn = $('#headerSleepBtn');
    if (sleepBtn) sleepBtn.onclick = () => window.mintpySleepTimer && window.mintpySleepTimer.toggle();

    // Global references for helper modules (sleep-timer, lyrics, ambient)
    window.audio = audio;
    window.togglePlay = togglePlay;
    window.isPlaying = isPlaying;

    // MediaSession Bridge Commands
    bridge.onMediaCommand((cmd) => {
      if (cmd === 'play-pause') togglePlay();
      else if (cmd === 'next-track') nextTrack();
      else if (cmd === 'prev-track') prevTrack();
    });

    // Render initial Home view
    navigate('home');
    console.log('MintPy Mobile App ready.');
  }

  window.addEventListener('DOMContentLoaded', init);
})();
