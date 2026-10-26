const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('api', {
  win: (action) => ipcRenderer.send('win-control', action),
  searchTracks: (q) => ipcRenderer.invoke('search-tracks', q),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  onScanProgress: (callback) => {
    const listener = (_, msg) => callback(msg);
    ipcRenderer.on('scan-progress', listener);
    return () => ipcRenderer.removeListener('scan-progress', listener);
  },
  getFavorites: () => ipcRenderer.invoke('get-favorites'),
  addFavorite: (track) => ipcRenderer.invoke('add-favorite', track),
  removeFavorite: (trackId) => ipcRenderer.invoke('remove-favorite', trackId),
  getPlaylists: () => ipcRenderer.invoke('get-playlists'),
  createPlaylist: (name) => ipcRenderer.invoke('create-playlist', name),
  deletePlaylist: (playlistId) => ipcRenderer.invoke('delete-playlist', playlistId),
  getPlaylistTracks: (playlistId) => ipcRenderer.invoke('get-playlist-tracks', playlistId),
  addToPlaylist: (playlistId, track) => ipcRenderer.invoke('add-to-playlist', playlistId, track),
  removeFromPlaylist: (playlistId, trackId) => ipcRenderer.invoke('remove-from-playlist', playlistId, trackId),
  importPlaylistFromUrl: (url) => ipcRenderer.invoke('import-playlist-from-url', url),
  resolveSearchTrack: (track) => ipcRenderer.invoke('resolve-search-track', track),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  setOpacity: (value) => ipcRenderer.send('set-window-opacity', value),
  setGlobalMute: (acc) => ipcRenderer.invoke('set-global-mute', acc),
  onGlobalMute: (callback) => { ipcRenderer.on('global-mute-triggered', () => callback()); },
  checkYtDlp: () => ipcRenderer.invoke('yt-dlp-status'),
  getStreamInfo: () => ipcRenderer.invoke('get-stream-info'),
  getLibrary: () => ipcRenderer.invoke('get-library'),
  getMissingLibraryTracks: () => ipcRenderer.invoke('get-missing-library-tracks'),
  removeMissingLibraryTracks: paths => ipcRenderer.invoke('remove-missing-library-tracks', paths),
  getPlaybackState: () => ipcRenderer.invoke('get-playback-state'),
  savePlaybackState: state => ipcRenderer.invoke('save-playback-state', state),
  getHistory: () => ipcRenderer.invoke('get-history'),
  recordHistory: track => ipcRenderer.invoke('record-history', track),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  removeHistoryTrack: (trackId) => ipcRenderer.invoke('remove-history-track', trackId),
  exportBackup: () => ipcRenderer.invoke('export-backup'),
  importBackup: () => ipcRenderer.invoke('import-backup'),
  onMediaCommand: callback => { ipcRenderer.on('media-command', (_, command) => callback(command)); },
  pickPetImage: () => ipcRenderer.invoke('pick-pet-image'),
  getCustomPets: () => ipcRenderer.invoke('get-custom-pets'),
  deleteCustomPet: (file) => ipcRenderer.invoke('delete-custom-pet', file),
  getPetDataUrl: (file) => ipcRenderer.invoke('get-pet-data-url', file),
  setupComplete: (options) => ipcRenderer.invoke('setup:complete', options),
  setupSetWindowMode: (mode) => ipcRenderer.invoke('setup:set-window-mode', mode),

  // Discord Rich Presence
  setDiscordActivity: (activity) => ipcRenderer.invoke('discord:set-activity', activity),
  setDiscordEnabled: (enabled) => ipcRenderer.invoke('discord:set-enabled', enabled),

  // Drag & Drop
  getPathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch {}
    return file?.path || '';
  },
  importDroppedFiles: (paths) => ipcRenderer.invoke('audio:import-dropped-files', paths),

  // Mini-Player Mode
  setMiniMode: (isMini) => ipcRenderer.invoke('window:set-mini-mode', isMini),
  getMiniMode: () => ipcRenderer.invoke('window:get-mini-mode'),
  onMiniModeChange: (callback) => {
    const listener = (_, val) => callback(val);
    ipcRenderer.on('window:mini-mode-changed', listener);
    return () => ipcRenderer.removeListener('window:mini-mode-changed', listener);
  }
});
