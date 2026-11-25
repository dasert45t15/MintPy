// ============================================================================
// MintPy Desktop UI Motion & Audio-Reactive FX Engine (60fps GPU Accelerated)
// - Live WebAudio Radial Spectrum Halo around Home Vinyl
// - Interactive 3D Card Tilt & Specular Light Sheen
// - Tactile Pointer Ripples & Heart-Spark Particle Bursts
// - Cinematic Theme Veil Crossfade & Directional View Transitions
// ============================================================================
(function () {
  'use strict';

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.mintpyFX = { flashThemeVeil: () => {}, setViewDirection: () => {}, ensureVinylHalo: () => {} };
    return;
  }

  const VIEW_ORDER = ['home', 'search', 'favorites', 'playlists', 'library', 'history', 'settings'];
  let lastViewIdx = 0;

  // --- 1. Directional View Choreography ---
  function setViewDirection(nextView) {
    const baseName = String(nextView || '').startsWith('playlist-') ? 'playlists' : String(nextView || 'home');
    const idx = VIEW_ORDER.indexOf(baseName);
    const dir = (idx === -1 || idx >= lastViewIdx) ? 1 : -1;
    if (idx !== -1) lastViewIdx = idx;
    document.documentElement.style.setProperty('--mp-view-shift', `${dir * 16}px`);
  }

  // --- 2. Cinematic Theme Crossfade Veil ---
  let veilEl = null;
  let veilTimer = null;
  function flashThemeVeil() {
    if (document.body.classList.contains('mini-mode')) return;
    if (!veilEl) {
      veilEl = document.createElement('div');
      veilEl.className = 'mp-theme-veil';
      document.body.appendChild(veilEl);
    }
    veilEl.classList.remove('active');
    void veilEl.offsetWidth;
    veilEl.classList.add('active');
    clearTimeout(veilTimer);
    veilTimer = setTimeout(() => veilEl.classList.remove('active'), 420);
  }

  // --- 3. Pointer Ripple on Buttons & Nav ---
  const RIPPLE_SELECTOR = '.play-btn, .ctrl-btn, .nav-btn, .search-btn, .bar-tool-btn, .mini-ctrl';
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const btn = e.target.closest(RIPPLE_SELECTOR);
    if (!btn || btn.disabled) return;
    const rect = btn.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const ripple = document.createElement('span');
    ripple.className = 'mp-ripple';
    const size = Math.max(rect.width, rect.height) * 1.65;
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    setTimeout(() => ripple.remove(), 620);
  }, { passive: true });

  // --- 4. Heart Spark Particle Burst on Favorite Click ---
  function spawnSparkBurst(x, y) {
    const container = document.createElement('div');
    container.className = 'mp-spark-burst';
    container.style.left = `${x}px`;
    container.style.top = `${y}px`;
    const count = 8;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('i');
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.35;
      const dist = 20 + Math.random() * 18;
      p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
      p.style.setProperty('--rot', `${Math.round(Math.random() * 180)}deg`);
      container.appendChild(p);
    }
    document.body.appendChild(container);
    setTimeout(() => container.remove(), 580);
  }

  document.addEventListener('click', (e) => {
    const fav = e.target.closest('.fav-btn');
    if (!fav) return;
    // Trigger burst when newly favoriting (before or right as toggle runs)
    const rect = fav.getBoundingClientRect();
    spawnSparkBurst(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, true);

  // --- 5. Interactive 3D Perspective Card Tilt & Glare ---
  const TILT_SELECTOR = '.rec-card, .pl-row';
  let activeTiltEl = null;

  document.addEventListener('pointermove', (e) => {
    if (document.body.classList.contains('mini-mode')) return;
    const card = e.target.closest(TILT_SELECTOR);
    if (activeTiltEl && activeTiltEl !== card) {
      activeTiltEl.style.transform = '';
      activeTiltEl.classList.remove('is-tilting');
      activeTiltEl = null;
    }
    if (!card) return;
    activeTiltEl = card;
    const r = card.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const nx = (e.clientX - r.left) / r.width - 0.5;
    const ny = (e.clientY - r.top) / r.height - 0.5;
    const rotY = (nx * 9).toFixed(2);
    const rotX = (-ny * 9).toFixed(2);
    card.classList.add('is-tilting');
    card.style.setProperty('--glare-x', `${Math.round((nx + 0.5) * 100)}%`);
    card.style.setProperty('--glare-y', `${Math.round((ny + 0.5) * 100)}%`);
    card.style.transform = `perspective(750px) rotateX(${rotX}deg) rotateY(${rotY}deg) translateY(-3px) scale(1.015)`;
  }, { passive: true });

  window.addEventListener('pointerleave', () => {
    if (activeTiltEl) {
      activeTiltEl.style.transform = '';
      activeTiltEl.classList.remove('is-tilting');
      activeTiltEl = null;
    }
  });

  // --- 6. Live WebAudio Radial Spectrum Halo around Home Vinyl ---
  let freqData = null;
  const BARS = 52;
  const smoothBins = new Float32Array(BARS);
  let accentCache = '#a5202d';
  let accentLastRead = 0;

  function getAccentColor(now) {
    if (now - accentLastRead > 800) {
      accentLastRead = now;
      const val = getComputedStyle(document.documentElement).getPropertyValue('--red').trim();
      if (val) accentCache = val;
    }
    return accentCache;
  }

  function ensureVinylHalo() {
    const vinyl = document.querySelector('.home-vinyl');
    if (!vinyl) return null;
    let canvas = vinyl.parentElement.querySelector('.mp-vinyl-halo-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'mp-vinyl-halo-canvas';
      canvas.width = 420;
      canvas.height = 420;
      canvas.setAttribute('aria-hidden', 'true');
      vinyl.parentElement.insertBefore(canvas, vinyl);
    }
    return canvas;
  }

  function renderHaloLoop(now) {
    requestAnimationFrame(renderHaloLoop);
    if (document.hidden || document.body.classList.contains('mini-mode')) return;

    const canvas = ensureVinylHalo();
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const player = window.mintpyPlayer;
    const playing = !!(player && player.isPlaying && player.isPlaying());
    const analyser = player && player.getAnalyser ? player.getAnalyser() : null;

    if (playing && analyser) {
      if (!freqData || freqData.length !== analyser.frequencyBinCount) {
        freqData = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(freqData);
      for (let i = 0; i < BARS; i++) {
        const binIdx = Math.min(freqData.length - 1, Math.floor((i / BARS) * (freqData.length * 0.62)) + 1);
        const norm = (freqData[binIdx] || 0) / 255;
        smoothBins[i] += (norm - smoothBins[i]) * 0.28;
      }
    } else {
      const idleWave = playing ? 0.22 : 0.03;
      for (let i = 0; i < BARS; i++) {
        const target = playing
          ? idleWave + 0.16 * Math.sin(now * 0.005 + i * 0.45)
          : 0.02 + 0.015 * Math.sin(now * 0.002 + i * 0.3);
        smoothBins[i] += (target - smoothBins[i]) * 0.12;
      }
    }

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const baseRadius = 148;
    const accent = getAccentColor(now);

    ctx.clearRect(0, 0, w, h);

    // Subtle breathing aura ring
    let avg = 0;
    for (let i = 0; i < BARS; i++) avg += smoothBins[i];
    avg /= BARS;

    ctx.save();
    ctx.strokeStyle = accent;
    ctx.globalAlpha = playing ? (0.14 + avg * 0.32) : 0.06;
    ctx.lineWidth = 2 + avg * 5;
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius - 2 + avg * 8, 0, Math.PI * 2);
    ctx.stroke();

    // Radial rounded frequency bars
    ctx.lineCap = 'round';
    ctx.lineWidth = 3.2;
    const rotOffset = now * 0.00025;
    for (let i = 0; i < BARS; i++) {
      const val = smoothBins[i];
      const len = 3 + val * 36;
      const angle = (i / BARS) * Math.PI * 2 + rotOffset;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      ctx.globalAlpha = playing ? (0.24 + val * 0.68) : 0.12;
      ctx.beginPath();
      ctx.moveTo(cx + cos * baseRadius, cy + sin * baseRadius);
      ctx.lineTo(cx + cos * (baseRadius + len), cy + sin * (baseRadius + len));
      ctx.stroke();
    }
    ctx.restore();
  }

  requestAnimationFrame(renderHaloLoop);

  window.mintpyFX = {
    flashThemeVeil,
    setViewDirection,
    ensureVinylHalo,
    spawnSparkBurst
  };
})();
