// ============================================================================
// MintPy Mobile Touch Choreography & Gesture Engine (Purpose-Built for Android)
// - Finger-Tracked Swipe-to-Skip on Home Turntable Stage & Sticky Mini-Player
// - Directional Tab Slide Transitions (Left / Right)
// - GPU Touch-Point Ripples & Heart Spark Particle Bursts
// - Smooth Theme Crossfade Veil
// ============================================================================
(function () {
  'use strict';

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.mintpyMobileFX = { flashThemeVeil: () => {}, setTabDirection: () => {} };
    return;
  }

  const TAB_ORDER = { home: 0, search: 1, favorites: 2, history: 2, playlists: 3, settings: 4 };
  let lastTabIdx = 0;

  // --- 1. Directional Bottom-Nav Tab Slide ---
  function setTabDirection(nextView) {
    const key = String(nextView || 'home');
    const idx = TAB_ORDER[key] !== undefined ? TAB_ORDER[key] : 3;
    const dir = idx >= lastTabIdx ? 1 : -1;
    lastTabIdx = idx;
    document.documentElement.style.setProperty('--m-slide-x', `${dir * 22}px`);
  }

  // --- 2. Theme Crossfade Veil ---
  let veilEl = null;
  let veilTimer = null;
  function flashThemeVeil() {
    if (!veilEl) {
      veilEl = document.createElement('div');
      veilEl.className = 'm-theme-veil';
      document.body.appendChild(veilEl);
    }
    veilEl.classList.remove('active');
    void veilEl.offsetWidth;
    veilEl.classList.add('active');
    clearTimeout(veilTimer);
    veilTimer = setTimeout(() => veilEl.classList.remove('active'), 360);
  }

  // --- 3. Native-Feel Touch Ripple ---
  const RIPPLE_TARGETS = '.nav-tab, .home-play-btn, .home-ctrl-btn, .home-sub-btn, .style-card, .action-btn, .search-go-btn, .chip-btn';
  document.addEventListener('pointerdown', (e) => {
    const target = e.target.closest(RIPPLE_TARGETS);
    if (!target || target.disabled) return;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const ripple = document.createElement('span');
    ripple.className = 'm-touch-ripple';
    const size = Math.max(rect.width, rect.height) * 1.6;
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    target.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    setTimeout(() => ripple.remove(), 550);
  }, { passive: true });

  // --- 4. Heart Spark Particle Burst ---
  function spawnHeartBurst(x, y) {
    const wrap = document.createElement('div');
    wrap.className = 'm-spark-burst';
    wrap.style.left = `${x}px`;
    wrap.style.top = `${y}px`;
    const count = 7;
    for (let i = 0; i < count; i++) {
      const s = document.createElement('i');
      const ang = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.3;
      const dist = 18 + Math.random() * 14;
      s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
      s.style.setProperty('--dy', `${Math.sin(ang) * dist}px`);
      wrap.appendChild(s);
    }
    document.body.appendChild(wrap);
    setTimeout(() => wrap.remove(), 520);
  }

  document.addEventListener('click', (e) => {
    const fav = e.target.closest('.fav-btn, #homeFavBtn');
    if (!fav) return;
    const rect = fav.getBoundingClientRect();
    spawnHeartBurst(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, true);

  // --- 5. Finger-Tracked Horizontal Swipe-to-Skip on Turntable Stage & Mini-Player ---
  let dragTarget = null;
  let startX = 0;
  let startY = 0;
  let deltaX = 0;
  let axisLocked = null; // 'x' | 'y' | null

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const stage = e.target.closest('.home-art-stage, #miniPlayerOpen');
    if (!stage) return;
    dragTarget = stage;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    deltaX = 0;
    axisLocked = null;
    dragTarget.style.transition = 'none';
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!dragTarget || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    if (!axisLocked) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      axisLocked = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
      if (axisLocked === 'y') {
        dragTarget.style.transition = '';
        dragTarget.style.transform = '';
        dragTarget = null;
        return;
      }
    }

    deltaX = dx;
    const damped = Math.sign(dx) * Math.min(110, Math.abs(dx) * 0.72);
    const rot = (damped * 0.045).toFixed(2);
    const fade = Math.max(0.55, 1 - Math.abs(damped) / 220);
    dragTarget.style.transform = `translate3d(${damped.toFixed(1)}px, 0, 0) rotate(${rot}deg)`;
    dragTarget.style.opacity = fade.toFixed(2);
  }, { passive: true });

  function finishSwipe() {
    if (!dragTarget) return;
    const el = dragTarget;
    const dx = deltaX;
    dragTarget = null;
    axisLocked = null;
    deltaX = 0;

    const player = window.mintpyPlayer;
    if (Math.abs(dx) >= 62 && player) {
      const outX = dx < 0 ? -140 : 140;
      el.style.transition = 'transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease';
      el.style.transform = `translate3d(${outX}px, 0, 0) scale(0.94)`;
      el.style.opacity = '0.25';
      setTimeout(() => {
        el.style.transition = 'transform 0.32s var(--ease-spring), opacity 0.24s ease';
        el.style.transform = '';
        el.style.opacity = '';
        if (dx < 0 && player.next) player.next();
        else if (dx > 0 && player.prev) player.prev();
      }, 170);
    } else {
      el.style.transition = 'transform 0.34s var(--ease-spring), opacity 0.22s ease';
      el.style.transform = '';
      el.style.opacity = '';
    }
  }

  document.addEventListener('touchend', finishSwipe, { passive: true });
  document.addEventListener('touchcancel', finishSwipe, { passive: true });

  window.mintpyMobileFX = {
    flashThemeVeil,
    setTabDirection,
    spawnHeartBurst
  };
})();
