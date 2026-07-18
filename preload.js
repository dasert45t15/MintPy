const { contextBridge, ipcRenderer } = require('electron');
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
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  setOpacity: (value) => ipcRenderer.send('set-window-opacity', value),
  checkYtDlp: () => ipcRenderer.invoke('yt-dlp-status')
});
