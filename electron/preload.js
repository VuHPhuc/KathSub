// Preload — runs before renderer. Uses contextBridge for secure IPC.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

console.log('[Preload] Loading...');

contextBridge.exposeInMainWorld('electron', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),

  // Safe file path resolution for Drag & Drop in Electron >= 28
  getPathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch (_) {}
    return file ? (file.path || '') : '';
  },

  // File dialogs
  openVideo:        ()     => ipcRenderer.invoke('open-video'),
  saveSubtitleFile: (name) => ipcRenderer.invoke('save-subtitle-file', name),
  saveVideoFile:    (name) => ipcRenderer.invoke('save-video-file', name),

  // FFmpeg
  extractAudio:   (videoPath) => ipcRenderer.invoke('extract-audio', videoPath),
  exportSubtitle: (data)      => ipcRenderer.invoke('export-subtitle', data),
  burnSubtitles:  (data)      => ipcRenderer.invoke('burn-subtitles', data),

  // Whisper
  transcribeApi:   (data) => ipcRenderer.invoke('transcribe-api', data),
  transcribeLocal: (data) => ipcRenderer.invoke('transcribe-local', data),

  // Translate
  listOllamaModels:   ()     => ipcRenderer.invoke('list-ollama-models'),
  translateSubtitles: (data) => ipcRenderer.invoke('translate-subtitles', data),

  // Event subscriptions
  on(channel, callback) {
    const allowed = ['burn-progress', 'transcribe-progress', 'window-state'];
    if (!allowed.includes(channel)) return () => {};
    const fn = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});

console.log('[Preload] window.electron set successfully via contextBridge!');
