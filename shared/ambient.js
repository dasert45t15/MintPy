// ============================================================================
// MintPy Shared Zen Ambient Soundscapes (Pure WebAudio Synthesis)
// ============================================================================
(function () {
  'use strict';

  const STORAGE_KEY = 'mintpy_ambient';
  let ctx = null;
  let masterGain = null;
  let isInitialized = false;
  let crackleTimer = null;

  const layers = {
    rain: { name: 'Дождь', icon: '🌧️', gainNode: null, vol: 0 },
    fire: { name: 'Костёр', icon: '🔥', gainNode: null, vol: 0 },
    wind: { name: 'Бамбуковый ветер', icon: '🍃', gainNode: null, vol: 0 },
    waves: { name: 'Океанский прибой', icon: '🌊', gainNode: null, vol: 0 },
    night: { name: 'Ночной цикадный сад', icon: '🌙', gainNode: null, vol: 0 }
  };

  function createPinkNoiseBuffer(audioCtx) {
    const bufferSize = audioCtx.sampleRate * 5;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    return buffer;
  }

  function createWhiteNoiseBuffer(audioCtx) {
    const bufferSize = audioCtx.sampleRate * 5;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.15;
    }
    return buffer;
  }

  function initAudio() {
    if (isInitialized && ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      ctx = window.audioCtx || new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      masterGain = ctx.createGain();
      masterGain.gain.value = 1.0;
      masterGain.connect(ctx.destination);

      const pinkBuffer = createPinkNoiseBuffer(ctx);
      const whiteBuffer = createWhiteNoiseBuffer(ctx);

      // 1. Rain
      const rainSource = ctx.createBufferSource();
      rainSource.buffer = pinkBuffer;
      rainSource.loop = true;
      const rainFilter = ctx.createBiquadFilter();
      rainFilter.type = 'lowpass';
      rainFilter.frequency.value = 1250;
      layers.rain.gainNode = ctx.createGain();
      layers.rain.gainNode.gain.value = layers.rain.vol * 0.7;
      rainSource.connect(rainFilter);
      rainFilter.connect(layers.rain.gainNode);
      layers.rain.gainNode.connect(masterGain);
      rainSource.start();

      // 2. Campfire
      const fireSource = ctx.createBufferSource();
      fireSource.buffer = pinkBuffer;
      fireSource.loop = true;
      const fireFilter = ctx.createBiquadFilter();
      fireFilter.type = 'lowpass';
      fireFilter.frequency.value = 280;
      layers.fire.gainNode = ctx.createGain();
      layers.fire.gainNode.gain.value = layers.fire.vol * 0.7;
      fireSource.connect(fireFilter);
      fireFilter.connect(layers.fire.gainNode);
      layers.fire.gainNode.connect(masterGain);
      fireSource.start();

      if (crackleTimer) clearInterval(crackleTimer);
      crackleTimer = setInterval(() => {
        if (!ctx || ctx.state !== 'running') return;
        if (layers.fire.vol > 0.01 && Math.random() < 0.34) {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(820 + Math.random() * 2100, ctx.currentTime);
          g.gain.setValueAtTime(layers.fire.vol * 0.42, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.036);
          osc.connect(g);
          g.connect(masterGain);
          osc.start();
          osc.stop(ctx.currentTime + 0.04);
        }
        if (layers.night.vol > 0.01 && Math.random() < 0.22) {
          const chirp = ctx.createOscillator();
          const cg = ctx.createGain();
          chirp.type = 'sine';
          const baseFreq = 4150 + Math.random() * 450;
          chirp.frequency.setValueAtTime(baseFreq, ctx.currentTime);
          cg.gain.setValueAtTime(0.0001, ctx.currentTime);
          cg.gain.linearRampToValueAtTime(layers.night.vol * 0.08, ctx.currentTime + 0.018);
          cg.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.075);
          chirp.connect(cg);
          cg.connect(masterGain);
          chirp.start();
          chirp.stop(ctx.currentTime + 0.08);
        }
      }, 95);

      // 3. Bamboo Wind
      const windSource = ctx.createBufferSource();
      windSource.buffer = pinkBuffer;
      windSource.loop = true;
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.value = 420;
      windFilter.Q.value = 1.8;
      const windLFO = ctx.createOscillator();
      windLFO.type = 'sine';
      windLFO.frequency.value = 0.12;
      const windLFOGain = ctx.createGain();
      windLFOGain.gain.value = 240;
      windLFO.connect(windLFOGain);
      windLFOGain.connect(windFilter.frequency);
      windLFO.start();
      layers.wind.gainNode = ctx.createGain();
      layers.wind.gainNode.gain.value = layers.wind.vol * 0.7;
      windSource.connect(windFilter);
      windFilter.connect(layers.wind.gainNode);
      layers.wind.gainNode.connect(masterGain);
      windSource.start();

      // 4. Ocean Waves
      const waveSource = ctx.createBufferSource();
      waveSource.buffer = whiteBuffer;
      waveSource.loop = true;
      const waveFilter = ctx.createBiquadFilter();
      waveFilter.type = 'lowpass';
      waveFilter.frequency.value = 400;
      const waveLFO = ctx.createOscillator();
      waveLFO.type = 'sine';
      waveLFO.frequency.value = 0.08;
      const waveLFOGain = ctx.createGain();
      waveLFOGain.gain.value = 650;
      waveLFO.connect(waveLFOGain);
      waveLFOGain.connect(waveFilter.frequency);
      waveLFO.start();
      layers.waves.gainNode = ctx.createGain();
      layers.waves.gainNode.gain.value = layers.waves.vol * 0.7;
      waveSource.connect(waveFilter);
      waveFilter.connect(layers.waves.gainNode);
      layers.waves.gainNode.connect(masterGain);
      waveSource.start();

      // 5. Night Garden Air
      const nightSource = ctx.createBufferSource();
      nightSource.buffer = pinkBuffer;
      nightSource.loop = true;
      const nightFilter = ctx.createBiquadFilter();
      nightFilter.type = 'bandpass';
      nightFilter.frequency.value = 2400;
      nightFilter.Q.value = 3.2;
      layers.night.gainNode = ctx.createGain();
      layers.night.gainNode.gain.value = layers.night.vol * 0.22;
      nightSource.connect(nightFilter);
      nightFilter.connect(layers.night.gainNode);
      layers.night.gainNode.connect(masterGain);
      nightSource.start();

      isInitialized = true;
    } catch (e) {
      console.warn('Ambient WebAudio init failed:', e);
    }
  }

  function setLayerVolume(key, val) {
    if (!layers[key]) return;
    initAudio();
    const clamped = Math.max(0, Math.min(1, parseFloat(val) || 0));
    layers[key].vol = clamped;
    if (layers[key].gainNode && ctx) {
      const mult = key === 'night' ? 0.22 : 0.7;
      layers[key].gainNode.gain.setTargetAtTime(clamped * mult, ctx.currentTime, 0.06);
    }
    saveSettings();
    updateAmbientBadge();
  }

  function saveSettings() {
    const data = {};
    for (const [k, v] of Object.entries(layers)) data[k] = v.vol;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
  }

  function loadSettings() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const [k, v] of Object.entries(data)) {
        if (layers[k]) layers[k].vol = Math.max(0, Math.min(1, parseFloat(v) || 0));
      }
    } catch {}
    updateAmbientBadge();
  }

  function updateAmbientBadge() {
    const btn = document.getElementById('ambientBtn');
    if (!btn) return;
    const active = Object.values(layers).some((l) => l.vol > 0.01);
    btn.classList.toggle('active', active);
  }

  function createAmbientModal() {
    if (document.getElementById('ambientModal')) return;
    const modal = document.createElement('div');
    modal.id = 'ambientModal';
    modal.className = 'ambient-modal hidden';
    modal.innerHTML = `
      <div class="ambient-popup">
        <header class="ambient-header">
          <div class="ambient-title">
            <span>🍃</span>
            <b>Zen Atmosphere</b>
          </div>
          <button class="ambient-close-btn" id="ambientCloseBtn">&times;</button>
        </header>
        <p class="muted ambient-sub">Живой процедурный синтез звуков природы (WebAudio).</p>
        <div class="ambient-layers">
          ${Object.entries(layers).map(([key, item]) => `
            <div class="ambient-row" data-key="${key}">
              <span class="ambient-icon">${item.icon}</span>
              <span class="ambient-label">${item.name}</span>
              <input type="range" class="ambient-slider" min="0" max="1" step="0.02" value="${item.vol}">
              <span class="ambient-val">${Math.round(item.vol * 100)}%</span>
            </div>
          `).join('')}
        </div>
        <div class="ambient-footer">
          <button class="search-btn" id="ambientMuteAllBtn">Выключить всё</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('ambientCloseBtn').onclick = closeAmbientModal;
    modal.onclick = (e) => { if (e.target === modal) closeAmbientModal(); };

    modal.querySelectorAll('.ambient-row').forEach((row) => {
      const key = row.dataset.key;
      const slider = row.querySelector('.ambient-slider');
      const valEl = row.querySelector('.ambient-val');
      slider.oninput = function () {
        setLayerVolume(key, this.value);
        valEl.textContent = Math.round(this.value * 100) + '%';
      };
    });

    document.getElementById('ambientMuteAllBtn').onclick = () => {
      for (const key of Object.keys(layers)) {
        setLayerVolume(key, 0);
      }
      modal.querySelectorAll('.ambient-slider').forEach((s) => { s.value = 0; });
      modal.querySelectorAll('.ambient-val').forEach((v) => { v.textContent = '0%'; });
    };
  }

  function openAmbientModal() {
    createAmbientModal();
    const modal = document.getElementById('ambientModal');
    modal.querySelectorAll('.ambient-row').forEach((row) => {
      const key = row.dataset.key;
      const slider = row.querySelector('.ambient-slider');
      const valEl = row.querySelector('.ambient-val');
      slider.value = layers[key].vol;
      valEl.textContent = Math.round(layers[key].vol * 100) + '%';
    });
    modal.classList.remove('hidden');
  }

  function closeAmbientModal() {
    const modal = document.getElementById('ambientModal');
    if (modal) modal.classList.add('hidden');
  }

  function toggleAmbientModal() {
    const modal = document.getElementById('ambientModal');
    if (modal && !modal.classList.contains('hidden')) closeAmbientModal();
    else openAmbientModal();
  }

  window.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    createAmbientModal();
    if (Object.values(layers).some((l) => l.vol > 0.01)) {
      const resumeOnce = () => {
        initAudio();
        window.removeEventListener('pointerdown', resumeOnce);
      };
      window.addEventListener('pointerdown', resumeOnce, { once: true });
    }
  });

  window.mintpyAmbient = {
    toggle: toggleAmbientModal,
    open: openAmbientModal,
    close: closeAmbientModal,
    setVolume: setLayerVolume
  };
})();
