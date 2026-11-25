// MintPy Mobile Controller - v5.4.6
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
  let lastAnimatedTrackId = null;
  let lastPlayIconState = null;

  const bridge = window.api;

  // Dual-Deck Audio Engine (Native HTML5 Audio for gapless preload & crossfade)
  const deckA = new Audio();
  const deckB = new Audio();
  [deckA, deckB].forEach(d => {
    d.loop = false;
    d.volume = 1.0;
    d.preload = 'auto';
  });
  let audio = deckA;
  let spareAudio = deckB;

  // Native Android Service MediaPlayer state (for HTTP streams running reliably in background)
  const hasNativePlayer = !!(window.AndroidNative && typeof window.AndroidNative.nativePlayUrl === 'function');
  let usingNativeAudio = false;
  let nativeCurrentTime = 0;
  let nativeDuration = 0;
  let nativePaused = true;
  let nativeHasSource = false;

  // Settings state
  let settings = {
    appearance: 'dark',
    style: 'zen',
    volumeNormalize: false,
    eqBands: { low: 0, mid: 0, high: 0 },
    crossfadeSeconds: 5,
    dynamicArtBg: false,
    playbackSpeed: 1.0
  };

  const THEME_LIST = [
    { id: 'zen', name: 'Zen', emoji: '🎋' },
    { id: 'lofi', name: 'Lo-Fi', emoji: '☕' },
    { id: 'synthwave', name: 'Synthwave', emoji: '🌆' },
    { id: 'ocean', name: 'Ocean', emoji: '🌊' },
    { id: 'forest', name: 'Forest', emoji: '🌲' },
    { id: 'aurora', name: 'Aurora', emoji: '✨' },
    { id: 'sakura', name: 'Sakura Night', emoji: '🌸' },
    { id: 'midnight', name: 'Midnight Gold', emoji: '🌙' },
    { id: 'cyber', name: 'Cyberpunk', emoji: '⚡' }
  ];

  const EQ_PRESETS = [
    { id: 'flat', label: 'Ровный', bands: { low: 0, mid: 0, high: 0 } },
    { id: 'bass', label: 'Бас+', bands: { low: 8, mid: 0, high: 2 } },
    { id: 'vocal', label: 'Вокал', bands: { low: -2, mid: 6, high: 4 } },
    { id: 'rock', label: 'Рок', bands: { low: 6, mid: 2, high: 6 } },
    { id: 'night', label: 'Ночь', bands: { low: 4, mid: -2, high: -3 } }
  ];

  const SPEED_OPTIONS = [0.85, 1.0, 1.15, 1.25, 1.5];

  function updateDynamicArtBg() {
    const el = $('#dynamicArtBg');
    if (!el) return;
    const art = currentTrack && typeof currentTrack.artwork === 'string' ? currentTrack.artwork.trim() : '';
    if (settings.dynamicArtBg && art && !art.includes('mintpy-logo')) {
      el.style.backgroundImage = `url("${art.replace(/"/g, '%22')}")`;
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  }

  function syncNativeEq() {
    const b = settings.eqBands || {};
    const low = Number(b.low) || 0;
    const mid = Number(b.mid) || 0;
    const high = Number(b.high) || 0;
    if (window.AndroidNative && typeof window.AndroidNative.nativeSetEq === 'function') {
      try { window.AndroidNative.nativeSetEq(low, mid, high); } catch (_) {}
    }
  }

  function syncPlaybackSpeed() {
    const spd = Math.max(0.5, Math.min(2.0, Number(settings.playbackSpeed) || 1.0));
    settings.playbackSpeed = spd;
    [deckA, deckB].forEach(d => { try { d.playbackRate = spd; } catch (_) {} });
    if (window.AndroidNative && typeof window.AndroidNative.nativeSetPlaybackSpeed === 'function') {
      try { window.AndroidNative.nativeSetPlaybackSpeed(spd); } catch (_) {}
    }
  }

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

  function triggerAnim(el, cls, timeoutMs = 450) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    const cleanup = () => {
      el.classList.remove(cls);
      el.removeEventListener('animationend', cleanup);
    };
    el.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, timeoutMs);
  }

  function showToast(msg, type = 'info') {
    let container = document.getElementById('mintpy-mobile-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'mintpy-mobile-toast-container';
      Object.assign(container.style, {
        position: 'fixed',
        bottom: '84px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '99999',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '8px',
        pointerEvents: 'none',
        width: 'max-content',
        maxWidth: 'calc(100vw - 32px)'
      });
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    const bgMap = {
      error: 'rgba(220, 38, 38, 0.92)',
      success: 'rgba(16, 185, 129, 0.92)',
      info: 'rgba(24, 24, 27, 0.92)'
    };
    const borderMap = {
      error: 'rgba(248, 113, 113, 0.35)',
      success: 'rgba(52, 211, 153, 0.35)',
      info: 'rgba(255, 255, 255, 0.14)'
    };

    Object.assign(toast.style, {
      background: bgMap[type] || bgMap.info,
      border: `1px solid ${borderMap[type] || borderMap.info}`,
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
      color: '#ffffff',
      padding: '10px 16px',
      borderRadius: '14px',
      fontSize: '13px',
      fontWeight: '500',
      lineHeight: '1.35',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.38)',
      opacity: '0',
      transform: 'translateY(12px) scale(0.96)',
      transition: 'opacity 0.28s cubic-bezier(0.16, 1, 0.3, 1), transform 0.28s cubic-bezier(0.16, 1, 0.3, 1)',
      textAlign: 'center',
      wordBreak: 'break-word'
    });
    toast.textContent = msg;
    container.appendChild(toast);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0) scale(1)';
      });
    });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px) scale(0.96)';
      setTimeout(() => {
        toast.remove();
        if (container.childElementCount === 0) container.remove();
      }, 300);
    }, 3500);
  }

  // --- DUAL-DECK CROSSFADE & AUTO-QUEUE ---
  let crossfadeTimer = null;
  let isCrossfading = false;
  let preloadedTrackKey = null;
  let isPreloadingNext = false;
  let isAutoQueueing = false;
  let lastAutoQueuedTrackKey = null;
  let consecutiveFailures = 0;
  let playSessionId = 0;
  let failHandledSession = -1;
  let skipTimer = null;

  function handlePlaybackFailure(sessionId, desc) {
    if (sessionId !== playSessionId || failHandledSession === sessionId) return;
    failHandledSession = sessionId;
    if (skipTimer) {
      clearTimeout(skipTimer);
      skipTimer = null;
    }
    if (currentTrack && bridge.invalidateTrackStream) {
      bridge.invalidateTrackStream(currentTrack.id);
    }
    isPlaying = false;
    updateGlobalUI();
    consecutiveFailures++;
    const canSkip = queue.length > 1 || isRepeat;
    if (consecutiveFailures >= 3 || !canSkip) {
      consecutiveFailures = 0;
      showToast(`Не удалось воспроизвести: ${desc}`, 'error');
      return;
    }
    showToast(`Ошибка трека (${desc}), переключаем...`, 'error');
    skipTimer = setTimeout(() => {
      if (sessionId === playSessionId) nextTrack();
    }, 1500);
  }

  function getTrackKey(track) {
    if (!track) return '';
    return String(track.id || track.videoId || track.url || `${track.artist || ''}-${track.title || ''}`);
  }

  function cancelCrossfade() {
    if (crossfadeTimer) {
      clearInterval(crossfadeTimer);
      crossfadeTimer = null;
    }
    isCrossfading = false;
    preloadedTrackKey = null;
    isPreloadingNext = false;
    if (typeof spareAudio !== 'undefined' && spareAudio) {
      try {
        spareAudio.pause();
        spareAudio.removeAttribute('src');
        spareAudio.load();
        spareAudio.volume = 1.0;
      } catch (_) {}
    }
    if (audio) {
      audio.volume = 1.0;
    }
  }

  async function maybeAutoQueueRecommended(remaining) {
    if (isAutoQueueing || !currentTrack) return;
    if (currentIndex + 1 < queue.length) return;
    if (typeof remaining === 'number' && remaining > 25) return;

    const currentKey = getTrackKey(currentTrack);
    if (lastAutoQueuedTrackKey === currentKey) return;

    isAutoQueueing = true;
    lastAutoQueuedTrackKey = currentKey;

    try {
      const [historyList, favoritesList] = await Promise.all([
        bridge.getHistory ? bridge.getHistory().catch(() => []) : Promise.resolve([]),
        bridge.getFavorites ? bridge.getFavorites().catch(() => []) : Promise.resolve([])
      ]);

      const artistCounts = new Map();
      const bumpArtist = (artist, weight = 1) => {
        if (!artist || typeof artist !== 'string') return;
        const clean = artist.split(',')[0].trim();
        if (!clean) return;
        artistCounts.set(clean, (artistCounts.get(clean) || 0) + weight);
      };

      (favoritesList || []).slice(0, 15).forEach((t) => bumpArtist(t?.artist, 2));
      (historyList || []).slice(0, 20).forEach((t) => bumpArtist(t?.artist, 1));
      bumpArtist(currentTrack.artist, 3);

      let seedArtist = currentTrack.artist || '';
      let maxWeight = -1;
      for (const [artist, weight] of artistCounts.entries()) {
        if (weight > maxWeight) {
          maxWeight = weight;
          seedArtist = artist;
        }
      }

      if (!seedArtist || !bridge.searchTracks) return;

      const results = await bridge.searchTracks(`${seedArtist} mix`);
      if (!Array.isArray(results) || results.length === 0) return;

      const existingKeys = new Set(queue.map(getTrackKey));
      const additions = [];
      for (const item of results) {
        const key = getTrackKey(item);
        if (key && !existingKeys.has(key)) {
          existingKeys.add(key);
          additions.push(item);
          if (additions.length >= 3) break;
        }
      }

      if (additions.length > 0) {
        queue.push(...additions);
        bridge.savePlaybackState({ queue, currentIndex });
        if (typeof updateGlobalUI === 'function') updateGlobalUI();
        showToast('✨ Добавили треки по вашему вкусу в конец очереди', 'info');
      }
    } catch (e) {
      console.warn('Auto-queue failed:', e);
    } finally {
      isAutoQueueing = false;
    }
  }

  async function checkAndPreloadNextTrack() {
    const paused = usingNativeAudio ? nativePaused : (!audio || audio.paused);
    const dur = usingNativeAudio ? (nativeDuration || currentTrack?.duration || 0) : (audio ? audio.duration : 0);
    const cur = usingNativeAudio ? nativeCurrentTime : (audio ? audio.currentTime : 0);
    if (!dur || !isFinite(dur) || paused || isCrossfading) return;
    const remaining = dur - cur;
    if (remaining > 25 || remaining <= 0) return;

    if (currentIndex + 1 >= queue.length) {
      await maybeAutoQueueRecommended(remaining);
    }

    const nextIdx = currentIndex + 1 < queue.length ? currentIndex + 1 : (isRepeat ? 0 : -1);
    if (nextIdx < 0 || !queue[nextIdx]) return;

    const nextTrackData = queue[nextIdx];
    const nextKey = getTrackKey(nextTrackData);
    if (preloadedTrackKey === nextKey || isPreloadingNext) return;

    isPreloadingNext = true;
    try {
      const url = await bridge.getTrackAudioUrl(nextTrackData);
      if (!url || isCrossfading) return;
      preloadedTrackKey = nextKey;
      if (usingNativeAudio) return;
      spareAudio.preload = 'auto';
      spareAudio.src = url;
      spareAudio.volume = 0;
      spareAudio.load();
    } catch (e) {
      console.warn('Preload next track failed:', e);
      preloadedTrackKey = null;
    } finally {
      isPreloadingNext = false;
    }
  }

  async function maybeCrossfade() {
    if (usingNativeAudio) return;
    if (isCrossfading || !audio || !audio.duration || !isFinite(audio.duration) || audio.paused) return;
    const cfSeconds = Number(typeof settings !== 'undefined' && settings?.crossfadeSeconds != null ? settings.crossfadeSeconds : 5);
    if (cfSeconds <= 0) return;

    const remaining = audio.duration - audio.currentTime;
    if (remaining > cfSeconds || remaining <= 0.15) return;

    if (currentIndex + 1 >= queue.length && !isRepeat) return;
    const nextIdx = currentIndex + 1 < queue.length ? currentIndex + 1 : 0;
    const nextTrackData = queue[nextIdx];
    if (!nextTrackData) return;

    isCrossfading = true;
    const nextKey = getTrackKey(nextTrackData);

    try {
      if (!spareAudio.src || preloadedTrackKey !== nextKey) {
        const url = await bridge.getTrackAudioUrl(nextTrackData);
        if (!url || !isCrossfading) {
          isCrossfading = false;
          return;
        }
        preloadedTrackKey = nextKey;
        spareAudio.preload = 'auto';
        spareAudio.src = url;
        spareAudio.volume = 0;
        spareAudio.load();
      }

      if (spareAudio.readyState < 2) {
        await new Promise((resolve, reject) => {
          const onReady = () => { cleanup(); resolve(); };
          const onErr = (err) => { cleanup(); reject(err); };
          const timer = setTimeout(() => { cleanup(); resolve(); }, 2500);
          const cleanup = () => {
            clearTimeout(timer);
            spareAudio.removeEventListener('canplay', onReady);
            spareAudio.removeEventListener('loadeddata', onReady);
            spareAudio.removeEventListener('error', onErr);
          };
          spareAudio.addEventListener('canplay', onReady, { once: true });
          spareAudio.addEventListener('loadeddata', onReady, { once: true });
          spareAudio.addEventListener('error', onErr, { once: true });
        });
      }

      if (!isCrossfading) return;

      spareAudio.volume = 0;
      const playPromise = spareAudio.play();
      if (playPromise) await playPromise;

      const durationMs = Math.max(500, Math.min(cfSeconds, Math.max(0.5, audio.duration - audio.currentTime)) * 1000);
      const stepMs = 50;
      const totalSteps = Math.max(1, Math.round(durationMs / stepMs));
      let step = 0;

      crossfadeTimer = setInterval(() => {
        if (!isCrossfading) {
          clearInterval(crossfadeTimer);
          crossfadeTimer = null;
          return;
        }

        step += 1;
        const progress = Math.min(1, step / totalSteps);
        audio.volume = Math.max(0, Math.min(1, 1 - progress));
        spareAudio.volume = Math.max(0, Math.min(1, progress));

        if (progress >= 1) {
          clearInterval(crossfadeTimer);
          crossfadeTimer = null;

          audio.pause();
          audio.removeAttribute('src');
          audio.load();

          [audio, spareAudio] = [spareAudio, audio];
          audio.volume = 1.0;
          spareAudio.volume = 1.0;

          isCrossfading = false;
          preloadedTrackKey = null;

          currentIndex = nextIdx;
          currentTrack = queue[currentIndex];
          isPlaying = true;

          bridge.savePlaybackState({ queue, currentIndex });
          if (currentTrack) bridge.recordHistory(currentTrack);
          updateGlobalUI();
          updateTimelineUI();

          if (window.mintpyLyrics && window.mintpyLyrics.onTrackChange) {
            window.mintpyLyrics.onTrackChange(currentTrack);
          }
          if (typeof updateMediaSession === 'function') {
            updateMediaSession(currentTrack);
          }

          if (currentIndex + 1 >= queue.length) {
            maybeAutoQueueRecommended(audio.duration || 0);
          }
        }
      }, stepMs);
    } catch (e) {
      console.warn('Crossfade failed:', e);
      isCrossfading = false;
      if (audio) audio.volume = 1.0;
    }
  }

  // --- AUDIO SETUP & EVENTS ---
  function setupAudio() {
    window.__mintpyNativeAudioEvent = function (event, posMs, durMs, playing) {
      if (!usingNativeAudio && !(event === 'sync' && nativeHasSource)) return;
      nativeCurrentTime = Math.max(0, (Number(posMs) || 0) / 1000);
      if (Number(durMs) > 0) nativeDuration = Number(durMs) / 1000;

      if (event === 'prepared') {
        consecutiveFailures = 0;
        updateTimelineUI();
      } else if (event === 'play') {
        nativePaused = false;
        isPlaying = true;
        if (currentTrack) bridge.recordHistory(currentTrack);
        updateGlobalUI();
        updateTimelineUI();
      } else if (event === 'pause') {
        nativePaused = true;
        isPlaying = false;
        updateGlobalUI();
        updateTimelineUI();
      } else if (event === 'timeupdate') {
        nativePaused = !playing;
        isPlaying = !!playing;
        updateTimelineUI();
        checkAndPreloadNextTrack();
        if (window.mintpyLyrics && window.mintpyLyrics.onTimeUpdate) {
          window.mintpyLyrics.onTimeUpdate(nativeCurrentTime);
        }
      } else if (event === 'sync') {
        nativePaused = !playing;
        isPlaying = !!playing;
        updateGlobalUI();
        updateTimelineUI();
      } else if (event === 'ended') {
        nativePaused = true;
        isPlaying = false;
        updateGlobalUI();
        if (isRepeat) {
          playTrack(currentTrack, currentIndex);
        } else {
          nextTrack();
        }
      } else if (event === 'error') {
        nativePaused = true;
        isPlaying = false;
        handlePlaybackFailure(playSessionId, 'Ошибка аудио (' + posMs + '/' + durMs + ')');
      }
    };

    const decks = typeof deckA !== 'undefined' && typeof deckB !== 'undefined' ? [deckA, deckB] : [audio, spareAudio].filter(Boolean);
    decks.forEach((deck) => {
      deck.ontimeupdate = () => {
        if (deck === audio) {
          updateTimelineUI();
          checkAndPreloadNextTrack();
          maybeCrossfade();
          if (window.mintpyLyrics && window.mintpyLyrics.onTimeUpdate) {
            window.mintpyLyrics.onTimeUpdate(audio.currentTime);
          }
        }
      };

      deck.onloadedmetadata = () => {
        if (deck === audio) updateTimelineUI();
      };

      deck.ondurationchange = () => {
        if (deck === audio) updateTimelineUI();
      };

      deck.onplay = () => {
        if (deck === audio) {
          isPlaying = true;
          if (currentTrack) bridge.recordHistory(currentTrack);
          updateGlobalUI();
        }
      };

      deck.onpause = () => {
        if (deck === audio && !isCrossfading) {
          isPlaying = false;
          updateGlobalUI();
        }
      };

      deck.onended = () => {
        if (deck === audio && !isCrossfading) {
          if (isRepeat) {
            playTrack(currentTrack, currentIndex);
          } else {
            nextTrack();
          }
        }
      };

      deck.onerror = () => {
        if (!deck.src || deck.src === window.location.href) return;
        if (deck !== audio) return;
        const err = deck.error;
        const codeMap = { 1: 'Прервано', 2: 'Сбой сети (DPI/блок)', 3: 'Ошибка декодирования', 4: 'Формат не поддерживается' };
        const desc = err ? (codeMap[err.code] || ('Код ' + err.code)) : 'Сбой аудио';
        console.warn('Audio playback error:', desc, deck.src);
        handlePlaybackFailure(playSessionId, desc);
      };
    });
  }

  // --- PLAYBACK CONTROL ---
  async function playTrack(track, index, newQueue = null) {
    cancelCrossfade();
    audio.volume = 1.0;
    if (!track) return;
    const sessionId = ++playSessionId;
    if (skipTimer) {
      clearTimeout(skipTimer);
      skipTimer = null;
    }
    if (newQueue) {
      queue = [...newQueue];
      consecutiveFailures = 0;
    }
    currentIndex = index;
    currentTrack = track;
    isPlaying = false;

    updateGlobalUI();
    bridge.savePlaybackState({ queue, currentIndex });

    try {
      audio.pause();

      // Resolve stream URL via Mobile Bridge
      const streamUrl = await bridge.getTrackAudioUrl(track);
      if (sessionId !== playSessionId) return;
      if (!streamUrl) {
        throw new Error('Поток не найден: ' + (track.title || track.id));
      }

      if (hasNativePlayer && (streamUrl.startsWith('http://') || streamUrl.startsWith('https://'))) {
        usingNativeAudio = true;
        nativeHasSource = true;
        nativeCurrentTime = 0;
        nativeDuration = Number(track.duration) || 0;
        nativePaused = false;
        try { audio.pause(); } catch (_) {}

        window.AndroidNative.nativePlayUrl(
          streamUrl,
          track.title || 'MintPy',
          track.artist || '',
          track.album || 'MintPy',
          track.artwork || '',
          Number(track.duration) || 0
        );

        consecutiveFailures = 0;
        isPlaying = true;
        updateGlobalUI();
        if (window.mintpyLyrics && window.mintpyLyrics.onTrackChange) {
          window.mintpyLyrics.onTrackChange(track);
        }
        const nextIdx = currentIndex + 1;
        if (nextIdx < queue.length && bridge.prefetchTrack) {
          setTimeout(() => bridge.prefetchTrack(queue[nextIdx]), 800);
        }
        return;
      }

      if (usingNativeAudio && window.AndroidNative && typeof window.AndroidNative.nativeStopPlayer === 'function') {
        window.AndroidNative.nativeStopPlayer();
      }
      usingNativeAudio = false;
      nativeHasSource = false;

      audio.src = streamUrl;
      audio.load();
      audio.volume = 1.0;
      audio.playbackRate = Math.max(0.5, Math.min(2.0, Number(settings.playbackSpeed) || 1.0));
      const playPromise = audio.play();
      if (playPromise) await playPromise;
      if (sessionId !== playSessionId) return;

      consecutiveFailures = 0;
      isPlaying = true;
      updateGlobalUI();
      if (window.mintpyLyrics && window.mintpyLyrics.onTrackChange) {
        window.mintpyLyrics.onTrackChange(track);
      }
      const nextIdx = currentIndex + 1;
      if (nextIdx < queue.length && bridge.prefetchTrack) {
        setTimeout(() => bridge.prefetchTrack(queue[nextIdx]), 800);
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error('Playback failed:', e);
      handlePlaybackFailure(sessionId, e.message || 'Сбой воспроизведения');
    }
  }

  function togglePlay() {
    cancelCrossfade();
    audio.volume = 1.0;
    if (usingNativeAudio) {
      if (!nativeHasSource && currentTrack) {
        return playTrack(currentTrack, currentIndex);
      }
      if (nativePaused) {
        if (window.AndroidNative && window.AndroidNative.nativeResume) window.AndroidNative.nativeResume();
      } else {
        if (window.AndroidNative && window.AndroidNative.nativePause) window.AndroidNative.nativePause();
      }
      return;
    }
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
    cancelCrossfade();
    audio.volume = 1.0;
    if (!queue.length) return;
    let nextIdx = currentIndex + 1;
    if (nextIdx >= queue.length) {
      if (isRepeat) nextIdx = 0;
      else return;
    }
    playTrack(queue[nextIdx], nextIdx);
  }

  function prevTrack() {
    cancelCrossfade();
    audio.volume = 1.0;
    if (!queue.length) return;
    const curPos = usingNativeAudio ? nativeCurrentTime : (audio.currentTime || 0);
    if (curPos > 3) {
      if (usingNativeAudio) {
        if (window.AndroidNative && window.AndroidNative.nativeSeekTo) window.AndroidNative.nativeSeekTo(0);
        nativeCurrentTime = 0;
        updateTimelineUI();
      } else {
        audio.currentTime = 0;
      }
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
    cancelCrossfade();
    audio.volume = 1.0;
    const dur = usingNativeAudio ? (nativeDuration || currentTrack?.duration || 0) : (audio.duration || 0);
    if (!dur || !isFinite(dur)) return;
    const target = Math.max(0, Math.min(dur, fraction * dur));
    if (usingNativeAudio) {
      nativeCurrentTime = target;
      if (window.AndroidNative && window.AndroidNative.nativeSeekTo) {
        window.AndroidNative.nativeSeekTo(target);
      }
      updateTimelineUI(true);
      return;
    }
    audio.currentTime = target;
    updateTimelineUI(true);
  }

  // --- UI SYNC ---
  function updateTimelineUI(forcePos = false) {
    const cur = usingNativeAudio ? nativeCurrentTime : (audio.currentTime || 0);
    const dur = usingNativeAudio
      ? (nativeDuration || currentTrack?.duration || 0)
      : (audio.duration && isFinite(audio.duration) ? audio.duration : (currentTrack?.duration || 0));
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

    if (!usingNativeAudio && window.updateMobilePositionState) {
      window.updateMobilePositionState({ duration: dur, position: cur }, forcePos);
    }
  }

  function syncMobileTrackRows() {
    const curKey = currentTrack ? String(currentTrack.id || '') : '';
    $$('#viewRoot .track-row[data-track-id]').forEach(r => {
      const act = !!curKey && r.dataset.trackId === curKey;
      r.classList.toggle('active', act);
      const eq = r.querySelector('.m-eq-bars');
      if (eq) eq.classList.toggle('paused', !isPlaying);
    });
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

    const trackKey = currentTrack ? getTrackKey(currentTrack) : null;
    const trackChanged = !!currentTrack && trackKey !== lastAnimatedTrackId;
    if (trackKey) {
      lastAnimatedTrackId = trackKey;
    } else {
      lastAnimatedTrackId = null;
    }

    if (homeCover && currentTrack) {
      homeCover.src = safeArtwork(currentTrack.artwork);
      if (homeVinylLabel) homeVinylLabel.src = safeArtwork(currentTrack.artwork);
      if (homeTitle) homeTitle.textContent = currentTrack.title || 'Untitled';
      if (homeArtist) homeArtist.textContent = currentTrack.artist || 'Unknown';
      if (trackChanged) {
        triggerAnim(homeCover, 'track-swap', 400);
        triggerAnim(homeTitle, 'track-swap', 340);
        triggerAnim(homeArtist, 'track-swap', 340);
      }
    }

    if (homeVinyl) {
      homeVinyl.classList.toggle('playing', isPlaying);
    }
    const homeStage = $('.home-art-stage');
    if (homeStage) {
      homeStage.classList.toggle('playing', isPlaying);
    }
    updateDynamicArtBg();

    const playStateChanged = lastPlayIconState !== isPlaying;
    if (playStateChanged) {
      lastPlayIconState = isPlaying;
    }

    if (homePlayBtn) {
      homePlayBtn.innerHTML = isPlaying ? icon('pause') : icon('play');
      homePlayBtn.classList.toggle('playing', isPlaying);
      if (playStateChanged) triggerAnim(homePlayBtn, 'icon-pop', 280);
    }
    if (homeShuffleBtn) {
      homeShuffleBtn.classList.toggle('active', isShuffle);
    }
    if (homeRepeatBtn) {
      homeRepeatBtn.classList.toggle('active', isRepeat);
    }

    if (homeFavBtn && currentTrack) {
      if (typeof bridge.isFavoriteSync === 'function') {
        const isFaved = bridge.isFavoriteSync(currentTrack.id);
        homeFavBtn.innerHTML = isFaved ? icon('heart') : icon('heart-o');
        homeFavBtn.classList.toggle('active', isFaved);
      } else {
        bridge.getFavorites().then(favs => {
          const isFaved = favs.some(f => f.id === currentTrack.id);
          homeFavBtn.innerHTML = isFaved ? icon('heart') : icon('heart-o');
          homeFavBtn.classList.toggle('active', isFaved);
        });
      }
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
      if (playStateChanged) triggerAnim(miniPlayBtn, 'icon-pop', 280);
      if (miniArtDisc) miniArtDisc.classList.toggle('playing', isPlaying);
    } else {
      miniPlayer.classList.remove('visible');
    }

    syncMobileTrackRows();
    window.isPlaying = isPlaying;

    // 3. Android MediaSession & Notification Lockscreen (handled natively by PlaybackService for stream tracks)
    if (!usingNativeAudio && window.updateMobileMediaSession) {
      window.updateMobileMediaSession(currentTrack, isPlaying, audio.currentTime || 0);
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
    root.scrollTop = 0;
    root.innerHTML = '';

    if (viewName === 'home') renderHome(root);
    else if (viewName === 'search') renderSearch(root);
    else if (viewName === 'favorites') renderFavorites(root, 'favorites');
    else if (viewName === 'history') renderFavorites(root, 'history');
    else if (viewName === 'playlists') renderPlaylists(root);
    else if (viewName === 'settings') renderSettings(root, true);

    updateGlobalUI();
  }

  // ==================== HOME VIEW RENDERER ====================
  function renderHome(container) {
    const artUrl = safeArtwork(currentTrack?.artwork);
    const ttl = currentTrack?.title || 'Nothing playing';
    const art = currentTrack?.artist || 'Choose a track in Search';

    container.innerHTML = `
      <div class="home-container view-enter">
        <!-- Turntable Stage: Vinyl is strictly smaller than cover so it never protrudes top/bottom -->
        <div class="home-art-stage ${isPlaying ? 'playing' : ''}" id="homeArtStage">
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
          <button class="home-sub-btn" id="homeQueueBtn">
            ${icon('queue')} <span>Очередь</span>
          </button>
          <button class="home-sub-btn" id="homeLyricsBtn">
            ${icon('lyrics')} <span>Текст</span>
          </button>
        </div>
      </div>
    `;

    // Bind Home UI + Horizontal Swipe Gestures on Stage
    let stageSwiped = false;
    const stageEl = $('#homeArtStage');
    if (stageEl) {
      let startX = 0;
      let startY = 0;
      stageEl.addEventListener('touchstart', (e) => {
        if (!e.touches || !e.touches[0]) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        stageSwiped = false;
      }, { passive: true });
      stageEl.addEventListener('touchend', (e) => {
        if (!e.changedTouches || !e.changedTouches[0]) return;
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          stageSwiped = true;
          stageEl.style.transform = `translateX(${dx < 0 ? -18 : 18}px)`;
          setTimeout(() => { if (stageEl) stageEl.style.transform = ''; }, 180);
          if (dx < 0) nextTrack();
          else prevTrack();
        }
      }, { passive: true });
    }

    const onStageTap = () => {
      if (stageSwiped) { stageSwiped = false; return; }
      togglePlay();
    };
    $('#homePlayBtn').onclick = togglePlay;
    const coverEl = $('#homeCover');
    if (coverEl) coverEl.onclick = onStageTap;
    const vinylEl = $('#homeVinyl');
    if (vinylEl) vinylEl.onclick = onStageTap;
    $('#homePrevBtn').onclick = prevTrack;
    $('#homeNextBtn').onclick = nextTrack;
    $('#homeShuffleBtn').onclick = toggleShuffle;
    $('#homeRepeatBtn').onclick = toggleRepeat;
    const queueBtn = $('#homeQueueBtn');
    if (queueBtn) queueBtn.onclick = openQueueSheet;

    $('#homeFavBtn').onclick = async () => {
      if (!currentTrack) return;
      const favBtn = $('#homeFavBtn');
      const favs = await bridge.getFavorites();
      const isFaved = favs.some(f => f.id === currentTrack.id);
      if (isFaved) {
        await bridge.removeFavorite(currentTrack.id);
      } else {
        await bridge.addFavorite(currentTrack);
        triggerAnim(favBtn, 'fav-pop', 400);
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

    seekBar.onmousedown = (e) => { seekDragging = true; seekBar.classList.add('seeking'); handleSeek(e); };
    seekBar.ontouchstart = (e) => { seekDragging = true; seekBar.classList.add('seeking'); handleSeek(e); };
    window.onmousemove = (e) => { if (seekDragging) handleSeek(e); };
    window.ontouchmove = (e) => { if (seekDragging) handleSeek(e); };
    window.onmouseup = () => { seekDragging = false; seekBar.classList.remove('seeking'); };
    window.ontouchend = () => { seekDragging = false; seekBar.classList.remove('seeking'); };
    window.ontouchcancel = () => { seekDragging = false; seekBar.classList.remove('seeking'); };

    updateTimelineUI();
  }

  function openQueueSheet() {
    const prev = document.getElementById('queueSheetOverlay');
    if (prev) prev.remove();

    const overlay = document.createElement('div');
    overlay.id = 'queueSheetOverlay';
    overlay.className = 'queue-sheet-overlay';

    const closeSheet = () => {
      if (overlay.classList.contains('closing')) return;
      overlay.classList.add('closing');
      setTimeout(() => overlay.remove(), 210);
    };

    overlay.innerHTML = `
      <div class="queue-sheet">
        <div class="queue-sheet-header">
          <div class="queue-sheet-title" id="qCountTitle">Очередь (${queue.length})</div>
          <div class="queue-sheet-actions">
            <button class="chip-btn" id="qShuffleBtn">${icon('shuffle')}</button>
            <button class="chip-btn" id="qClearBtn">Очистить</button>
            <button class="chip-btn" id="qCloseBtn">&times;</button>
          </div>
        </div>
        <div class="queue-list" id="qList"></div>
      </div>
    `;

    const renderList = (animateRows = false) => {
      const titleEl = overlay.querySelector('#qCountTitle');
      const listEl = overlay.querySelector('#qList');
      if (titleEl) titleEl.textContent = `Очередь (${queue.length})`;
      if (!listEl) return;

      listEl.innerHTML = queue.length ? queue.map((t, i) => `
        <div class="queue-item ${i === currentIndex ? 'current' : ''}${animateRows ? ' q-enter' : ''}" data-qidx="${i}"${animateRows ? ` style="--row-i:${Math.min(i, 12)}"` : ''}>
          <img src="${safeArtwork(t.artwork)}" alt="" loading="lazy">
          <div class="queue-item-meta">
            <div class="queue-item-title">${esc(t.title || 'Без названия')}</div>
            <div class="queue-item-artist">${esc(t.artist || '')}</div>
          </div>
          <span class="m-eq-bars ${isPlaying ? '' : 'paused'}" aria-hidden="true"><i></i><i></i><i></i></span>
          <button class="queue-remove-btn" data-qdel="${i}" title="Убрать">&times;</button>
        </div>
      `).join('') : '<div class="empty-state" style="padding:28px 12px;"><p>Очередь пуста</p></div>';
    };

    const closeBtn = overlay.querySelector('#qCloseBtn');
    if (closeBtn) closeBtn.onclick = closeSheet;

    const shufBtn = overlay.querySelector('#qShuffleBtn');
    if (shufBtn) shufBtn.onclick = () => { toggleShuffle(); renderList(false); };

    const clrBtn = overlay.querySelector('#qClearBtn');
    if (clrBtn) clrBtn.onclick = () => {
      if (currentTrack && currentIndex >= 0) {
        queue = [currentTrack];
        currentIndex = 0;
      } else {
        queue = [];
        currentIndex = -1;
      }
      bridge.savePlaybackState({ queue, currentIndex });
      updateGlobalUI();
      renderList(false);
    };

    const listEl = overlay.querySelector('#qList');
    if (listEl) {
      listEl.onclick = (e) => {
        const delBtn = e.target.closest('[data-qdel]');
        if (delBtn) {
          e.stopPropagation();
          const idx = parseInt(delBtn.dataset.qdel, 10);
          if (!Number.isFinite(idx) || idx < 0 || idx >= queue.length) return;
          queue.splice(idx, 1);
          if (queue.length === 0) {
            currentIndex = -1;
          } else if (idx < currentIndex) {
            currentIndex--;
          } else if (idx === currentIndex && currentIndex >= queue.length) {
            currentIndex = queue.length - 1;
          }
          bridge.savePlaybackState({ queue, currentIndex });
          updateGlobalUI();
          renderList(false);
          return;
        }
        const itemEl = e.target.closest('[data-qidx]');
        if (itemEl) {
          const idx = parseInt(itemEl.dataset.qidx, 10);
          if (queue[idx]) {
            playTrack(queue[idx], idx);
            renderList(false);
          }
        }
      };
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSheet();
    });

    document.body.appendChild(overlay);
    renderList(true);
  }

  // ==================== SEARCH VIEW RENDERER ====================
  let lastSearchQuery = '';
  let lastSearchResults = [];
  let searchSeq = 0;

  function renderSearch(container) {
    container.innerHTML = `
      <div class="search-container view-enter">
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
      const mySeq = ++searchSeq;
      lastSearchQuery = q;
      resultsContainer.innerHTML = '<div class="empty-state"><p>Поиск треков...</p></div>';

      try {
        const tracks = await bridge.searchTracks(q);
        if (mySeq !== searchSeq) return;
        lastSearchResults = tracks;
        if (!tracks || !tracks.length) {
          resultsContainer.innerHTML = '<div class="empty-state"><h3>Ничего не найдено</h3><p>Попробуйте другой запрос</p></div>';
          return;
        }
        renderTrackRows(resultsContainer, tracks);
      } catch (e) {
        if (mySeq !== searchSeq) return;
        resultsContainer.innerHTML = `<div class="empty-state"><h3>Ошибка поиска</h3><p>${esc(e.message)}</p></div>`;
      }
    };

    btn.onclick = doSearch;
    input.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  }

  function renderTrackRows(container, tracks) {
    container.innerHTML = tracks.map((t, idx) => `
      <div class="track-row ${currentTrack?.id === t.id ? 'active' : ''}" data-idx="${idx}" data-track-id="${esc(t.id)}" style="--row-i:${Math.min(idx, 12)}">
        <img class="track-thumb" loading="lazy" decoding="async" src="${safeArtwork(t.artwork)}" alt="">
        <div class="track-info">
          <span class="track-ttl">${esc(t.title)}</span>
          <span class="track-art">${esc(t.artist)}</span>
        </div>
        <span class="m-eq-bars ${isPlaying ? '' : 'paused'}" aria-hidden="true"><i></i><i></i><i></i></span>
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
          triggerAnim(favBtn, 'fav-pop', 400);
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

    function renderTab(isInitial = false) {
      const isFav = currentTab === 'favorites';
      const count = isFav ? favs.length : history.length;
      container.innerHTML = `
        <div class="search-container${isInitial ? ' view-enter' : ''}">
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

      $('#tabFavsBtn').onclick = () => { currentTab = 'favorites'; renderTab(false); };
      $('#tabHistBtn').onclick = () => { currentTab = 'history'; renderTab(false); };

      const clearBtn = $('#clearHistBtn');
      if (clearBtn) {
        clearBtn.onclick = async () => {
          if (confirm('Очистить историю прослушивания?')) {
            await bridge.clearHistory();
            history.length = 0;
            renderTab(false);
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

    renderTab(true);
  }

  // ==================== PLAYLISTS VIEW RENDERER ====================
  async function renderPlaylists(container) {
    const pls = await bridge.getPlaylists();
    container.innerHTML = `
      <div class="search-container view-enter">
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
        importCard.classList.toggle('open', isHidden);
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
      plCont.innerHTML = pls.map((p, idx) => `
        <div class="track-row" data-plid="${esc(p.id)}" style="--row-i:${Math.min(idx, 12)}">
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
      <div class="search-container view-enter">
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
        <div class="track-row ${currentTrack?.id === t.id ? 'active' : ''}" data-idx="${i}" data-track-id="${esc(t.id)}" style="--row-i:${Math.min(i, 12)}">
          <img class="track-thumb" loading="lazy" decoding="async" src="${safeArtwork(t.artwork)}" alt="">
          <div class="track-info">
            <span class="track-ttl">${esc(t.title)}</span>
            <span class="track-art">${esc(t.artist)}${t.duration ? ' · ' + fmtTime(t.duration) : ''}</span>
          </div>
          <span class="m-eq-bars ${isPlaying ? '' : 'paused'}" aria-hidden="true"><i></i><i></i><i></i></span>
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
  function renderSettings(container, animate = true) {
    const styles = THEME_LIST;
    const eq = settings.eqBands || { low: 0, mid: 0, high: 0 };
    const isPresetMatch = (p) =>
      Number(eq.low || 0) === p.bands.low &&
      Number(eq.mid || 0) === p.bands.mid &&
      Number(eq.high || 0) === p.bands.high;
    const curSpeed = Number(settings.playbackSpeed) || 1.0;

    container.innerHTML = `
      <div class="settings-container${animate ? ' view-enter' : ' no-enter'}">
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
          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-title">Динамический фон обложки</span>
              <span class="setting-desc">Размытый цветной фон из обложки трека</span>
            </div>
            <input type="checkbox" id="setDynamicArtBg" ${settings.dynamicArtBg ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--accent);">
          </div>
        </div>

        <!-- 2b. Quick Tools (moved from removed top bar) -->
        <div class="settings-group">
          <div class="group-title">✨ Инструменты</div>
          <div class="backup-actions" style="flex-wrap:wrap;">
            <button class="action-btn" id="setHistoryBtn">${icon('history')} <span>История</span></button>
            <button class="action-btn" id="setAmbientBtn">${icon('leaf')} <span>Атмосфера</span></button>
            <button class="action-btn" id="setSleepBtn">${icon('timer')} <span>Таймер сна</span></button>
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

          <div>
            <div class="setting-desc" style="margin-bottom:4px;">Скорость воспроизведения</div>
            <div class="chip-row" id="speedPresetRow">
              ${SPEED_OPTIONS.map(s => `
                <button class="chip-btn ${Math.abs(curSpeed - s) < 0.01 ? 'active' : ''}" data-speed="${s}">${s}x</button>
              `).join('')}
            </div>
          </div>

          <div>
            <div class="setting-desc" style="margin-bottom:4px;">Пресеты эквалайзера</div>
            <div class="chip-row" id="eqPresetRow">
              ${EQ_PRESETS.map(p => `
                <button class="chip-btn ${isPresetMatch(p) ? 'active' : ''}" data-eqpreset="${p.id}">${p.label}</button>
              `).join('')}
            </div>
          </div>

          <div class="eq-sliders" style="margin-top:6px;">
            <div class="eq-row">
              <span class="eq-name">Бас</span>
              <input type="range" class="eq-slider" id="eqLow" min="-12" max="12" step="1" value="${eq.low || 0}">
              <span class="eq-val" id="eqLowVal">${(eq.low || 0) > 0 ? '+' : ''}${eq.low || 0}dB</span>
            </div>
            <div class="eq-row">
              <span class="eq-name">Средние</span>
              <input type="range" class="eq-slider" id="eqMid" min="-12" max="12" step="1" value="${eq.mid || 0}">
              <span class="eq-val" id="eqMidVal">${(eq.mid || 0) > 0 ? '+' : ''}${eq.mid || 0}dB</span>
            </div>
            <div class="eq-row">
              <span class="eq-name">Высокие</span>
              <input type="range" class="eq-slider" id="eqHigh" min="-12" max="12" step="1" value="${eq.high || 0}">
              <span class="eq-val" id="eqHighVal">${(eq.high || 0) > 0 ? '+' : ''}${eq.high || 0}dB</span>
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
            <strong>MintPy Mobile v5.4.6</strong><br>
            Автор: <strong>Иван Dasert</strong><br>
            Портативный дзэн-плеер с фоновыми атмосферами.
          </div>
        </div>
      </div>
    `;

    container.querySelectorAll('.settings-group').forEach((g, idx) => {
      g.style.setProperty('--row-i', String(Math.min(idx, 7)));
    });

    // Bind Settings
    $$('.style-card').forEach(card => {
      card.onclick = () => {
        applyStyle(card.dataset.style);
        renderSettings(container, false);
      };
    });

    $$('.segment-btn[data-app]').forEach(btn => {
      btn.onclick = () => {
        applyAppearance(btn.dataset.app);
        renderSettings(container, false);
      };
    });

    const dynBgEl = $('#setDynamicArtBg');
    if (dynBgEl) {
      dynBgEl.onchange = (e) => {
        settings.dynamicArtBg = e.target.checked;
        updateDynamicArtBg();
        bridge.saveSettings(settings);
      };
    }

    const setHistBtn = $('#setHistoryBtn');
    if (setHistBtn) setHistBtn.onclick = () => navigate('history');

    const setAmbBtn = $('#setAmbientBtn');
    if (setAmbBtn) setAmbBtn.onclick = () => window.mintpyAmbient && window.mintpyAmbient.toggle();

    const setSleepBtn = $('#setSleepBtn');
    if (setSleepBtn) setSleepBtn.onclick = () => window.mintpySleepTimer && window.mintpySleepTimer.toggle();

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

    $$('[data-speed]').forEach(btn => {
      btn.onclick = () => {
        const s = Number(btn.dataset.speed) || 1.0;
        settings.playbackSpeed = s;
        syncPlaybackSpeed();
        bridge.saveSettings(settings);
        $$('[data-speed]').forEach(b => b.classList.toggle('active', b === btn));
      };
    });

    const refreshEqPresetHighlight = () => {
      const cur = settings.eqBands || {};
      $$('[data-eqpreset]').forEach(btn => {
        const p = EQ_PRESETS.find(x => x.id === btn.dataset.eqpreset);
        const match = !!(p && Number(cur.low || 0) === p.bands.low && Number(cur.mid || 0) === p.bands.mid && Number(cur.high || 0) === p.bands.high);
        btn.classList.toggle('active', match);
      });
    };

    $$('[data-eqpreset]').forEach(btn => {
      btn.onclick = () => {
        const p = EQ_PRESETS.find(x => x.id === btn.dataset.eqpreset);
        if (!p) return;
        settings.eqBands = { ...p.bands };
        const map = [['#eqLow', '#eqLowVal', p.bands.low], ['#eqMid', '#eqMidVal', p.bands.mid], ['#eqHigh', '#eqHighVal', p.bands.high]];
        map.forEach(([sliderSel, valSel, v]) => {
          const sl = $(sliderSel);
          const vl = $(valSel);
          if (sl) sl.value = v;
          if (vl) vl.textContent = `${v > 0 ? '+' : ''}${v}dB`;
        });
        refreshEqPresetHighlight();
        syncNativeEq();
        bridge.saveSettings(settings);
      };
    });

    const bindEq = (id, band, valId) => {
      const el = $(id);
      if (el) {
        el.oninput = (e) => {
          const v = Number(e.target.value);
          if (!settings.eqBands) settings.eqBands = {};
          settings.eqBands[band] = v;
          $(valId).textContent = `${v > 0 ? '+' : ''}${v}dB`;
          refreshEqPresetHighlight();
          syncNativeEq();
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
    const found = THEME_LIST.find(t => t.id === styleName);
    const tag = $('#headerStyleTag');
    if (tag) tag.textContent = found ? `${found.name} ${found.emoji}` : styleName;
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
    if (window.AndroidNative && typeof window.AndroidNative.setLightStatusBar === 'function') {
      try { window.AndroidNative.setLightStatusBar(mode === 'light'); } catch (_) {}
    }
    updateThemeButtonUI();
    bridge.saveSettings(settings);
  }

  // --- INITIALIZATION ---
  async function init() {
    setupAudio();

    // Load saved settings
    const loadedSettings = await bridge.getSettings();
    settings = {
      appearance: 'dark',
      style: 'zen',
      volumeNormalize: false,
      eqBands: { low: 0, mid: 0, high: 0 },
      crossfadeSeconds: 5,
      dynamicArtBg: false,
      playbackSpeed: 1.0,
      ...(loadedSettings || {})
    };
    applyStyle(settings.style || 'zen');
    applyAppearance(settings.appearance || 'dark');
    updateThemeButtonUI();
    syncNativeEq();
    syncPlaybackSpeed();
    updateDynamicArtBg();

    const styleTag = $('#headerStyleTag');
    if (styleTag) {
      styleTag.onclick = () => {
        const curIdx = THEME_LIST.findIndex(t => t.id === settings.style);
        const nextTheme = THEME_LIST[(curIdx + 1) % THEME_LIST.length];
        applyStyle(nextTheme.id);
        triggerAnim(styleTag, 'tag-pop', 360);
        showToast(`Тема: ${nextTheme.name} ${nextTheme.emoji}`, 'info');
        if (currentView === 'settings') renderSettings($('#viewRoot'), false);
      };
    }

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
    bridge.onMediaCommand((cmd, arg) => {
      if (cmd === 'play') {
        if (usingNativeAudio) {
          if (window.AndroidNative && window.AndroidNative.nativeResume) window.AndroidNative.nativeResume();
        } else if (audio.src && audio.paused) audio.play().catch(() => {});
        else if (!audio.src) togglePlay();
      } else if (cmd === 'pause') {
        if (usingNativeAudio) {
          if (window.AndroidNative && window.AndroidNative.nativePause) window.AndroidNative.nativePause();
        } else if (!audio.paused) audio.pause();
      } else if (cmd === 'play-pause') togglePlay();
      else if (cmd === 'next-track') nextTrack();
      else if (cmd === 'prev-track') prevTrack();
      else if (cmd === 'seek-to') {
        cancelCrossfade();
        audio.volume = 1.0;
        const target = Number(arg);
        if (usingNativeAudio) {
          const dur = nativeDuration || (currentTrack && Number(currentTrack.duration)) || 0;
          if (Number.isFinite(target) && dur > 0) {
            nativeCurrentTime = Math.max(0, Math.min(dur, target));
            if (window.AndroidNative && window.AndroidNative.nativeSeekTo) window.AndroidNative.nativeSeekTo(nativeCurrentTime);
            updateTimelineUI(true);
          }
        } else if (Number.isFinite(target) && audio.duration && isFinite(audio.duration)) {
          audio.currentTime = Math.max(0, Math.min(audio.duration, target));
          updateTimelineUI(true);
        }
      } else if (cmd === 'seek-by') {
        cancelCrossfade();
        audio.volume = 1.0;
        const delta = Number(arg);
        if (usingNativeAudio) {
          const dur = nativeDuration || (currentTrack && Number(currentTrack.duration)) || 0;
          if (Number.isFinite(delta) && dur > 0) {
            nativeCurrentTime = Math.max(0, Math.min(dur, nativeCurrentTime + delta));
            if (window.AndroidNative && window.AndroidNative.nativeSeekTo) window.AndroidNative.nativeSeekTo(nativeCurrentTime);
            updateTimelineUI(true);
          }
        } else if (Number.isFinite(delta) && audio.duration && isFinite(audio.duration)) {
          audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + delta));
          updateTimelineUI(true);
        }
      } else if (cmd === 'stop') {
        cancelCrossfade();
        if (usingNativeAudio && window.AndroidNative && window.AndroidNative.stopNativeMediaSession) {
          window.AndroidNative.stopNativeMediaSession();
          nativePaused = true;
        } else {
          audio.pause();
        }
        isPlaying = false;
        updateGlobalUI();
      }
    });

    // Render initial Home view
    navigate('home');
    console.log('MintPy Mobile App ready.');
  }

  window.addEventListener('DOMContentLoaded', init);
})();
