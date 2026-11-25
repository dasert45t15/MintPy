// ============================================================================
// MintPy Shared Sleep Timer (Smooth Fade-Out & End-of-Track Auto-Pause)
// Works seamlessly across Desktop WebAudio and Android Native PlaybackService.
// ============================================================================
(function () {
  'use strict';

  let timerInterval = null;
  let remainingSeconds = 0;
  let mode = null; // null | 'time' | 'end-of-track'
  let preFadeVolume = null;

  function applyFadeFactor(factor) {
    const f = Math.max(0, Math.min(1, factor));
    if (window.mintpyPlayer && typeof window.mintpyPlayer.setSleepFade === 'function') {
      window.mintpyPlayer.setSleepFade(f);
      return;
    }
    if (window.gainNode && window.audioCtx) {
      if (preFadeVolume === null) preFadeVolume = window.gainNode.gain.value;
      try {
        window.gainNode.gain.setTargetAtTime(Math.max(0.001, preFadeVolume * f), window.audioCtx.currentTime, 0.25);
      } catch {}
    } else if (window.audio) {
      if (preFadeVolume === null) preFadeVolume = window.audio.volume;
      window.audio.volume = Math.max(0, preFadeVolume * f);
    }
  }

  function restoreAudioGain() {
    if (window.mintpyPlayer && typeof window.mintpyPlayer.setSleepFade === 'function') {
      window.mintpyPlayer.setSleepFade(1.0);
    } else if (typeof window.applyVol === 'function') {
      window.applyVol();
    } else if (window.audio && preFadeVolume !== null) {
      window.audio.volume = preFadeVolume;
    }
    preFadeVolume = null;
  }

  function pausePlaybackForSleep() {
    if (window.mintpyPlayer && typeof window.mintpyPlayer.pause === 'function') {
      window.mintpyPlayer.pause();
      return;
    }
    if (window.isPlaying && typeof window.togglePlay === 'function') {
      window.togglePlay();
    } else if (window.audio && !window.audio.paused) {
      window.audio.pause();
    }
  }

  function setTimer(minutes) {
    clearTimer(true);
    if (!minutes) return;

    if (minutes === 'end') {
      mode = 'end-of-track';
      updateBadge('END');
      if (window.showToast) window.showToast('Таймер сна: пауза в конце трека', 'info');
      return;
    }

    const mins = parseInt(minutes, 10);
    if (!mins || mins <= 0) return;

    mode = 'time';
    remainingSeconds = mins * 60;
    updateBadge(mins + 'm');
    if (window.showToast) window.showToast(`Таймер сна: ${mins} мин.`, 'info');

    timerInterval = setInterval(() => {
      remainingSeconds--;
      if (remainingSeconds <= 0) {
        triggerSleep();
        return;
      }
      if (remainingSeconds < 60) {
        updateBadge(remainingSeconds + 's');
      } else {
        updateBadge(Math.ceil(remainingSeconds / 60) + 'm');
      }
      if (remainingSeconds <= 20) {
        applyFadeFactor(remainingSeconds / 20);
      }
    }, 1000);
  }

  function clearTimer(silentRestore = false) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    remainingSeconds = 0;
    mode = null;
    if (!silentRestore) restoreAudioGain();
    else preFadeVolume = null;
    updateBadge('');
  }

  function triggerSleep() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    remainingSeconds = 0;
    mode = null;
    updateBadge('');
    pausePlaybackForSleep();
    setTimeout(restoreAudioGain, 300);
    if (window.showToast) window.showToast('Таймер сна сработал. Спокойной ночи 🌙', 'info');
  }

  function onTrackEndedCheck() {
    if (mode === 'end-of-track') {
      triggerSleep();
      return true;
    }
    return false;
  }

  function updateBadge(text) {
    const badge = document.getElementById('sleepTimerBadge');
    const btn = document.getElementById('sleepTimerBtn');
    if (badge) {
      badge.textContent = text;
      badge.style.display = text ? 'inline-block' : 'none';
    }
    if (btn) {
      btn.classList.toggle('active', Boolean(text));
    }
  }

  function createSleepMenu() {
    if (document.getElementById('sleepMenu')) return;
    const menu = document.createElement('div');
    menu.id = 'sleepMenu';
    menu.className = 'sleep-menu hidden';
    menu.innerHTML = `
      <div class="sleep-popup">
        <header class="sleep-header">
          <div class="sleep-title"><span>🌙</span><b>Таймер сна</b></div>
          <button class="sleep-close-btn" id="sleepCloseBtn">&times;</button>
        </header>
        <div class="sleep-options">
          <button class="sleep-opt" data-mins="15">15 минут</button>
          <button class="sleep-opt" data-mins="30">30 минут</button>
          <button class="sleep-opt" data-mins="45">45 минут</button>
          <button class="sleep-opt" data-mins="60">60 минут</button>
          <button class="sleep-opt" data-mins="end">До конца текущего трека</button>
          <button class="sleep-opt sleep-cancel" data-mins="0">Отключить таймер</button>
        </div>
      </div>
    `;
    document.body.appendChild(menu);

    document.getElementById('sleepCloseBtn').onclick = closeSleepMenu;
    menu.onclick = (e) => { if (e.target === menu) closeSleepMenu(); };

    menu.querySelectorAll('.sleep-opt').forEach((btn) => {
      btn.onclick = function () {
        const val = this.dataset.mins;
        if (val === '0') {
          clearTimer();
          if (window.showToast) window.showToast('Таймер сна выключен', 'info');
        } else {
          setTimer(val);
        }
        closeSleepMenu();
      };
    });
  }

  function openSleepMenu() {
    createSleepMenu();
    const menu = document.getElementById('sleepMenu');
    menu.classList.remove('hidden');
  }

  function closeSleepMenu() {
    const menu = document.getElementById('sleepMenu');
    if (menu) menu.classList.add('hidden');
  }

  function toggleSleepMenu() {
    const menu = document.getElementById('sleepMenu');
    if (modalIsVisible(menu)) closeSleepMenu();
    else openSleepMenu();
  }

  function modalIsVisible(el) {
    return Boolean(el && !el.classList.contains('hidden'));
  }

  window.addEventListener('DOMContentLoaded', () => {
    createSleepMenu();
  });

  window.mintpySleepTimer = {
    toggle: toggleSleepMenu,
    open: openSleepMenu,
    close: closeSleepMenu,
    set: setTimer,
    clear: clearTimer,
    onTrackEnded: onTrackEndedCheck,
    getRemaining: () => remainingSeconds,
    getMode: () => mode
  };
})();
