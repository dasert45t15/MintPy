// ==================================================
// ZEN AMBIENT SOUNDSCAPES MODULE (WebAudio Synthesis)
// ==================================================
(function() {
  let ctx = null;
  let masterGain = null;
  let isInitialized = false;

  const layers = {
    rain: { name: 'Rain', icon: '🌧️', gainNode: null, vol: 0 },
    fire: { name: 'Campfire', icon: '🔥', gainNode: null, vol: 0 },
    wind: { name: 'Bamboo Wind', icon: '🍃', gainNode: null, vol: 0 },
    waves: { name: 'Ocean Waves', icon: '🌊', gainNode: null, vol: 0 }
  };

  // Generate 5s looped pink noise buffer
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

  // Generate 5s white noise buffer
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
    if (isInitialized && ctx) return;
    try {
      ctx = window.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = 1.0;
      masterGain.connect(ctx.destination);

      const pinkBuffer = createPinkNoiseBuffer(ctx);
      const whiteBuffer = createWhiteNoiseBuffer(ctx);

      // --- 1. RAIN ---
      const rainSource = ctx.createBufferSource();
      rainSource.buffer = pinkBuffer;
      rainSource.loop = true;
      const rainFilter = ctx.createBiquadFilter();
      rainFilter.type = 'lowpass';
      rainFilter.frequency.value = 1200;
      layers.rain.gainNode = ctx.createGain();
      layers.rain.gainNode.gain.value = layers.rain.vol;
      rainSource.connect(rainFilter);
      rainFilter.connect(layers.rain.gainNode);
      layers.rain.gainNode.connect(masterGain);
      rainSource.start();

      // --- 2. CAMPFIRE (Rumble + Random Crackles) ---
      const fireSource = ctx.createBufferSource();
      fireSource.buffer = pinkBuffer;
      fireSource.loop = true;
      const fireFilter = ctx.createBiquadFilter();
      fireFilter.type = 'lowpass';
      fireFilter.frequency.value = 280;
      layers.fire.gainNode = ctx.createGain();
      layers.fire.gainNode.gain.value = layers.fire.vol;
      fireSource.connect(fireFilter);
      fireFilter.connect(layers.fire.gainNode);
      layers.fire.gainNode.connect(masterGain);
      fireSource.start();

      // Campfire crackle timer
      setInterval(() => {
        if (!ctx || layers.fire.vol <= 0.01) return;
        if (Math.random() < 0.35) {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(800 + Math.random() * 2200, ctx.currentTime);
          g.gain.setValueAtTime(layers.fire.vol * 0.45, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.035);
          osc.connect(g);
          g.connect(masterGain);
          osc.start();
          osc.stop(ctx.currentTime + 0.04);
        }
      }, 90);

      // --- 3. WIND / BAMBOO (Pink noise + sweeping LFO) ---
      const windSource = ctx.createBufferSource();
      windSource.buffer = pinkBuffer;
      windSource.loop = true;
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.value = 420;
      windFilter.Q.value = 1.8;

      const windLFO = ctx.createOscillator();
      windLFO.type = 'sine';
      windLFO.frequency.value = 0.12; // slow 8-sec breath cycle
      const windLFOGain = ctx.createGain();
      windLFOGain.gain.value = 240;
      windLFO.connect(windLFOGain);
      windLFOGain.connect(windFilter.frequency);
      windLFO.start();

      layers.wind.gainNode = ctx.createGain();
      layers.wind.gainNode.gain.value = layers.wind.vol;
      windSource.connect(windFilter);
      windFilter.connect(layers.wind.gainNode);
      layers.wind.gainNode.connect(masterGain);
      windSource.start();

      // --- 4. OCEAN WAVES (White noise + deep surge LFO) ---
      const waveSource = ctx.createBufferSource();
      waveSource.buffer = whiteBuffer;
      waveSource.loop = true;
      const waveFilter = ctx.createBiquadFilter();
      waveFilter.type = 'lowpass';
      waveFilter.frequency.value = 400;

      const waveLFO = ctx.createOscillator();
      waveLFO.type = 'sine';
      waveLFO.frequency.value = 0.08; // 12-sec ocean tidal surge
      const waveLFOGain = ctx.createGain();
      waveLFOGain.gain.value = 650;
      waveLFO.connect(waveLFOGain);
      waveLFOGain.connect(waveFilter.frequency);
      waveLFO.start();

      layers.waves.gainNode = ctx.createGain();
      layers.waves.gainNode.gain.value = layers.waves.vol;
      waveSource.connect(waveFilter);
      waveFilter.connect(layers.waves.gainNode);
      layers.waves.gainNode.connect(masterGain);
      waveSource.start();

      isInitialized = true;
    } catch (e) {
      console.warn('Ambient WebAudio init failed:', e);
    }
  }

  function setLayerVolume(key, val) {
    initAudio();
    const clamped = Math.max(0, Math.min(1, parseFloat(val) || 0));
    layers[key].vol = clamped;
    if (layers[key].gainNode && ctx) {
      layers[key].gainNode.gain.setTargetAtTime(clamped * 0.7, ctx.currentTime, 0.05);
    }
    saveSettings();
    updateAmbientBadge();
  }

  function saveSettings() {
    const data = {};
    for (const [k, v] of Object.entries(layers)) data[k] = v.vol;
    try { localStorage.setItem('mintpy_ambient', JSON.stringify(data)); } catch {}
  }

  function loadSettings() {
    try {
      const data = JSON.parse(localStorage.getItem('mintpy_ambient') || '{}');
      for (const [k, v] of Object.entries(data)) {
        if (layers[k]) layers[k].vol = parseFloat(v) || 0;
      }
    } catch {}
    updateAmbientBadge();
  }

  function updateAmbientBadge() {
    const btn = document.getElementById('ambientBtn');
    if (!btn) return;
    const active = Object.values(layers).some(l => l.vol > 0.01);
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
        <p class="muted ambient-sub">Pure synthesized WebAudio nature soundscapes.</p>
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
          <button class="search-btn" id="ambientMuteAllBtn">Mute all</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('ambientCloseBtn').onclick = closeAmbientModal;
    modal.onclick = e => { if (e.target === modal) closeAmbientModal(); };

    modal.querySelectorAll('.ambient-row').forEach(row => {
      const key = row.dataset.key;
      const slider = row.querySelector('.ambient-slider');
      const valEl = row.querySelector('.ambient-val');
      slider.oninput = function() {
        setLayerVolume(key, this.value);
        valEl.textContent = Math.round(this.value * 100) + '%';
      };
    });

    document.getElementById('ambientMuteAllBtn').onclick = () => {
      for (const key of Object.keys(layers)) {
        setLayerVolume(key, 0);
      }
      modal.querySelectorAll('.ambient-slider').forEach(s => s.value = 0);
      modal.querySelectorAll('.ambient-val').forEach(v => v.textContent = '0%');
    };
  }

  function openAmbientModal() {
    createAmbientModal();
    const modal = document.getElementById('ambientModal');
    // Refresh slider positions from state
    modal.querySelectorAll('.ambient-row').forEach(row => {
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
  });

  window.mintpyAmbient = {
    toggle: toggleAmbientModal,
    open: openAmbientModal,
    close: closeAmbientModal,
    setVolume: setLayerVolume
  };
})();
