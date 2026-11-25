#pragma once

namespace mintpy {

inline const wchar_t* kInjectedBridgeJs = LR"JS(
(function() {
  if (window.api) return;
  if (!window.chrome || !window.chrome.webview) return;

  const pending = new Map();
  let nextId = 1;
  const listeners = new Map();

  function emit(event, payload) {
    const arr = listeners.get(event);
    if (!arr) return;
    for (const fn of arr) {
      try { fn(payload); } catch (e) { console.error('Event listener error:', event, e); }
    }
  }

  function onEvent(event, cb) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(cb);
    return () => {
      const arr = listeners.get(event);
      if (!arr) return;
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  window.chrome.webview.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.event) {
      emit(msg.event, msg.payload);
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'Native operation failed'));
    }
  });

  function invoke(op, args) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      window.chrome.webview.postMessage({ id, op, args: args || {} });
    });
  }

  function invokeWithFiles(op, files) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      if (typeof window.chrome.webview.postMessageWithAdditionalObjects === 'function') {
        window.chrome.webview.postMessageWithAdditionalObjects({ id, op }, files);
      } else {
        pending.delete(id);
        resolve([]);
      }
    });
  }

  window.api = {
    isCppNative: true,
    win: (action) => window.chrome.webview.postMessage({ op: 'win-control', args: { action } }),
    searchTracks: (q) => invoke('search-tracks', { q }),
    pickFolder: () => invoke('pick-folder'),
    scanFolder: (folderPath) => invoke('scan-folder', { folderPath }),
    onScanProgress: (cb) => onEvent('scan-progress', cb),
    getFavorites: () => invoke('get-favorites'),
    addFavorite: (track) => invoke('add-favorite', { track }),
    removeFavorite: (trackId) => invoke('remove-favorite', { trackId }),
    getPlaylists: () => invoke('get-playlists'),
    createPlaylist: (name) => invoke('create-playlist', { name }),
    deletePlaylist: (playlistId) => invoke('delete-playlist', { playlistId }),
    renamePlaylist: (playlistId, name) => invoke('rename-playlist', { playlistId, name }),
    getPlaylistTracks: (playlistId) => invoke('get-playlist-tracks', { playlistId }),
    addToPlaylist: (playlistId, track) => invoke('add-to-playlist', { playlistId, track }),
    removeFromPlaylist: (playlistId, trackId) => invoke('remove-from-playlist', { playlistId, trackId }),
    importPlaylistFromUrl: (url) => invoke('import-playlist-from-url', { url }),
    resolveSearchTrack: (track) => invoke('resolve-search-track', { track }),
    getSettings: () => invoke('get-settings'),
    saveSettings: (settings) => invoke('save-settings', { settings }),
    setOpacity: (value) => window.chrome.webview.postMessage({ op: 'set-window-opacity', args: { value } }),
    setGlobalMute: (acc) => invoke('set-global-mute', { acc }),
    onGlobalMute: (cb) => onEvent('global-mute-triggered', cb),
    checkYtDlp: () => invoke('yt-dlp-status'),
    getStreamInfo: () => invoke('get-stream-info'),
    getLibrary: () => invoke('get-library'),
    getMissingLibraryTracks: () => invoke('get-missing-library-tracks'),
    removeMissingLibraryTracks: (paths) => invoke('remove-missing-library-tracks', { paths }),
    getPlaybackState: () => invoke('get-playback-state'),
    savePlaybackState: (state) => invoke('save-playback-state', { state }),
    getHistory: () => invoke('get-history'),
    recordHistory: (track) => invoke('record-history', { track }),
    clearHistory: () => invoke('clear-history'),
    removeHistoryTrack: (trackId) => invoke('remove-history-track', { trackId }),
    exportBackup: () => invoke('export-backup'),
    importBackup: () => invoke('import-backup'),
    onMediaCommand: (cb) => onEvent('media-command', cb),
    pickPetImage: () => invoke('pick-pet-image'),
    getCustomPets: () => invoke('get-custom-pets'),
    deleteCustomPet: (file) => invoke('delete-custom-pet', { file }),
    getPetDataUrl: (file) => invoke('get-pet-data-url', { file }),
    setupComplete: (options) => invoke('setup:complete', { options }),
    setupSetWindowMode: (mode) => invoke('setup:set-window-mode', { mode }),
    setDiscordActivity: (activity) => invoke('discord:set-activity', { activity }),
    setDiscordEnabled: (enabled) => invoke('discord:set-enabled', { enabled }),
    getPathForFile: (file) => file?.path || '',
    importDroppedFiles: (paths) => invoke('audio:import-dropped-files', { paths }),
    importDroppedFileObjects: (files) => invokeWithFiles('audio:import-dropped-file-objects', files),
    setMiniMode: (isMini) => invoke('window:set-mini-mode', { isMini }),
    getMiniMode: () => invoke('window:get-mini-mode'),
    onMiniModeChange: (cb) => onEvent('window:mini-mode-changed', cb)
  };

  // Native frameless window drag & maximize via Win32 SC_MOVE
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, a, .wb, .mini-wb, .mini-ctrl, .mini-scrubber-track, .mini-cover-container')) return;
    const dragRegion = e.target.closest('.drag-bar, .mini-topbar, .mini-body');
    if (dragRegion) {
      window.chrome.webview.postMessage({ op: '__startDrag' });
    }
  });
  window.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, .wb')) return;
    if (e.target.closest('.drag-bar')) {
      window.chrome.webview.postMessage({ op: 'win-control', args: { action: 'maximize' } });
    }
  });
})();
)JS";

}  // namespace mintpy
