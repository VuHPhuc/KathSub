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
  importSubtitle:   ()     => ipcRenderer.invoke('import-subtitle'),
  saveVideoFile:    (name) => ipcRenderer.invoke('save-video-file', name),

  // FFmpeg
  extractAudio:   (videoPath) => ipcRenderer.invoke('extract-audio', videoPath),
  exportSubtitle: (data)      => ipcRenderer.invoke('export-subtitle', data),
  burnSubtitles:  (data)      => ipcRenderer.invoke('burn-subtitles', data),

  // Whisper
  transcribeApi:   (data) => ipcRenderer.invoke('transcribe-api', data),
  transcribeLocal: (data) => ipcRenderer.invoke('transcribe-local', data),

  // OCR: read subtitles burned into the video picture
  ocrVideo:         (data) => ipcRenderer.invoke('ocr-video', data),
  ocrVisionModels:  ()     => ipcRenderer.invoke('ocr-vision-models'),

  // Translate
  translateSubtitles: (data) => ipcRenderer.invoke('translate-subtitles', data),

  // Stops the running extract / transcribe / translate step
  cancelJob: () => ipcRenderer.invoke('cancel-job'),

  // Ollama setup
  ollamaStatus:  ()      => ipcRenderer.invoke('ollama-status'),
  ollamaInstall: ()      => ipcRenderer.invoke('ollama-install'),
  ollamaStart:   ()      => ipcRenderer.invoke('ollama-start'),
  ollamaPull:    (model) => ipcRenderer.invoke('ollama-pull', model),
  ollamaCancel:  ()      => ipcRenderer.invoke('ollama-cancel'),

  // Model cache (renderer sends group keys / Ollama model names, never paths)
  modelCacheInfo:    ()      => ipcRenderer.invoke('model-cache-info'),
  modelCacheDelete:  (key)   => ipcRenderer.invoke('model-cache-delete', key),
  ollamaDeleteModel: (name)  => ipcRenderer.invoke('ollama-delete-model', name),

  // App updates
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall:  () => ipcRenderer.invoke('update-install'),
  updateOpenPage: () => ipcRenderer.invoke('update-open-page'),

  // Event subscriptions
  on(channel, callback) {
    const allowed = ['burn-progress', 'transcribe-progress', 'ollama-setup-progress', 'window-state', 'update-status'];
    if (!allowed.includes(channel)) return () => {};
    const fn = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});

console.log('[Preload] window.electron set successfully via contextBridge!');
