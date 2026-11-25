// ============================================================================
// MintPy Mobile Themes, Equalizer Presets & Playback Speed Config
// ============================================================================
(function () {
  'use strict';

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

  window.MintPyMobileThemes = {
    THEME_LIST,
    EQ_PRESETS,
    SPEED_OPTIONS
  };
})();
