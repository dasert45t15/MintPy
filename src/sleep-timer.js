// ==================================================
// SLEEP TIMER MODULE (Fade-out & Auto-Pause)
// ==================================================
(function() {
  let timerInterval = null;
  let remainingSeconds = 0;
  let mode = null; // null | 'time' | 'end-of-track'
  let preFadeVolume = null;

  function setTimer(minutes) {
    clearTimer();
    if (!minutes) return;

    if (minutes === 'end') {
      mode = 'end-of-track';
      updateBadge('END');
      if (window.showToast) window.showToast('Sleep timer: stopping at end of track', 'info');
      return;
    }

    const mins = parseInt(minutes, 10);
    if (!mins || mins <= 0) return;

    mode = 'time';
    remainingSeconds = mins * 60;
    updateBadge(mins + 'm');
    if (window.showToast) window.showToast(`Sleep timer set for ${mins} minutes`, 'info');

    timerInterval = setInterval(() => {
      remainingSeconds--;
      if (remainingSeconds <= 0) {
        triggerSleep();
      } else {
        const m = Math.ceil(remainingSeconds / 60);
        updateBadge(m + 'm');

        // Soft fade out in the last 20 seconds
        if (remainingSeconds === 20) {
          softFadeOut(20);
        }
      }
    }, 1000);
  }

  function clearTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    remainingSeconds = 0;
    mode = null;
    preFadeVolume = null;
    updateBadge('');
  }

  function softFadeOut(durationSeconds) {
    if (window.gainNode && window.audioCtx) {
      preFadeVolume = window.gainNode.gain.value;
      try {
        window.gainNode.gain.cancelScheduledValues(window.audioCtx.currentTime);
        window.gainNode.gain.setValueAtTime(preFadeVolume, window.audioCtx.currentTime);
        window.gainNode.gain.linearRampToValueAtTime(0.001, window.audioCtx.currentTime + durationSeconds);
      } catch {}
    }
  }

  function triggerSleep() {
    clearTimer();
    if (window.isPlaying && typeof window.togglePlay === 'function') {
      window.togglePlay();
    }
    // Restore volume level for next session
    if (typeof window.applyVol === 'function') {
      setTimeout(() => window.applyVol(), 200);
    }
    if (window.showToast) window.showToast('Sleep timer expired. Goodnight 🌙', 'info');
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
          <div class="sleep-title"><span>🌙</span><b>Sleep Timer</b></div>
          <button class="sleep-close-btn" id="sleepCloseBtn">&times;</button>
        </header>
        <div class="sleep-options">
          <button class="sleep-opt" data-mins="15">15 minutes</button>
          <button class="sleep-opt" data-mins="30">30 minutes</button>
          <button class="sleep-opt" data-mins="45">45 minutes</button>
          <button class="sleep-opt" data-mins="60">60 minutes</button>
          <button class="sleep-opt" data-mins="end">End of current track</button>
          <button class="sleep-opt sleep-cancel" data-mins="0">Turn off timer</button>
        </div>
      </div>
    `;
    document.body.appendChild(menu);

    document.getElementById('sleepCloseBtn').onclick = closeSleepMenu;
    menu.onclick = e => { if (e.target === menu) closeSleepMenu(); };

    menu.querySelectorAll('.sleep-opt').forEach(btn => {
      btn.onclick = function() {
        const val = this.dataset.mins;
        if (val === '0') {
          clearTimer();
          if (window.showToast) window.showToast('Sleep timer disabled', 'info');
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
    if (menu && !menu.classList.contains('hidden')) closeSleepMenu();
    else openSleepMenu();
  }

  // Hook into track ended event for 'end-of-track' mode
  window.addEventListener('load', () => {
    createSleepMenu();
    if (window.audio) {
      window.audio.addEventListener('ended', () => {
        if (mode === 'end-of-track') {
          triggerSleep();
        }
      });
    }
  });

  window.mintpySleepTimer = {
    toggle: toggleSleepMenu,
    open: openSleepMenu,
    close: closeSleepMenu,
    set: setTimer,
    clear: clearTimer,
    getRemaining: () => remainingSeconds,
    getMode: () => mode
  };
})();
