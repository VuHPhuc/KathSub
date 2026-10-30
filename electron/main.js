const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs   = require('fs');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');

const isDev = process.env.NODE_ENV === 'development';

// ── Register media:// scheme as standard, secure, and streamable ─────────────
// MUST be called before app.ready for HTML5 video range requests to work!
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

let mainWindow = null;

let updaterService = null;
try {
  updaterService = require('./services/updater');
} catch (err) {
  console.error('[Updater] Failed to load service:', err.message);
}

function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  console.log('[Main] Preload path:', preloadPath);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#111214',
    icon: path.join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false, // Allows local media playback seamlessly
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Prevent drag-and-drop navigation
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  // Enable F12 to toggle DevTools even in production
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // Debug crash events
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[Electron Main] Render process gone:', details);
  });
  mainWindow.webContents.on('preload-error', (event, path, error) => {
    console.error('[Electron Main] Preload error at path:', path, 'Error:', error);
  });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[Electron Main] Page failed to load:', errorDescription, 'Code:', errorCode, 'URL:', validatedURL);
  });

  // ── Window controls ───────────────────────────────────────────────────────
  ipcMain.on('window-minimize', () => mainWindow?.minimize());
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on('window-close', () => mainWindow?.close());

  mainWindow.on('maximize',   () => mainWindow?.webContents.send('window-state', 'maximized'));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-state', 'normal'));
  mainWindow.on('close', () => {
    if (ffmpegService && typeof ffmpegService.cancelAll === 'function') {
      ffmpegService.cancelAll();
    }
  });
  mainWindow.on('closed',     () => { mainWindow = null; });
}

app.on('before-quit', () => {
  if (ffmpegService && typeof ffmpegService.cancelAll === 'function') {
    ffmpegService.cancelAll();
  }
});

process.on('uncaughtException', (err) => {
  if (err?.message?.includes('Object has been destroyed')) {
    // Cửa sổ đã đóng trong lúc IPC progress đang gửi dở, bỏ qua an toàn
    return;
  }
  console.error('[Main UncaughtException]:', err);
});

// Register media:// protocol for serving local video files with byte-range streaming (HTTP 206 Partial Content)
app.whenReady().then(() => {
  protocol.handle('media', async (request) => {
    try {
      let raw = request.url.replace(/^media:\/\/local\//i, '').replace(/^media:\/\//i, '');
      let filePath = decodeURIComponent(raw);
      // Fix Windows drive letter if colon was stripped: e.g. "D/folder" -> "D:/folder"
      if (/^[a-zA-Z]\//.test(filePath)) {
        filePath = filePath[0] + ':/' + filePath.slice(2);
      }
      filePath = path.resolve(filePath);
      if (!fs.existsSync(filePath)) {
        console.error('[media protocol] File not found on disk:', filePath);
        return new Response('File not found', { status: 404 });
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = request.headers.get('range');

      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.mp4': 'video/mp4',
        '.m4v': 'video/mp4',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
      };
      const contentType = mimeTypes[ext] || 'video/mp4';

      if (range) {
        // Parse HTTP Range header: e.g. "bytes=1048576-" or "bytes=0-1048576"
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10) || 0;
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;
        const fileStream = fs.createReadStream(filePath, { start, end });

        return new Response(Readable.toWeb(fileStream), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize.toString(),
            'Content-Type': contentType,
          },
        });
      } else {
        const fileStream = fs.createReadStream(filePath);
        return new Response(Readable.toWeb(fileStream), {
          status: 200,
          headers: {
            'Content-Length': fileSize.toString(),
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
          },
        });
      }
    } catch (err) {
      console.error('[media protocol] Error:', err);
      return new Response('File not found: ' + err.message, { status: 404 });
    }
  });

  createWindow();

  // Check for a newer release once the UI is up, so the notice has somewhere to appear
  if (updaterService) {
    updaterService.init((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', status);
    });
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => updaterService.checkForUpdates(), 3000);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── File dialogs ─────────────────────────────────────────────────────────────

ipcMain.handle('open-video', async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Chọn video',
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'm4v', 'wmv', 'ts', 'mts', 'mpg', 'mpeg'] },
        { name: 'Tất cả file', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  } catch (err) {
    console.error('[open-video] Error:', err);
    return null;
  }
});

// Pick a subtitle file and return its decoded text; the renderer parses it (src/utils/subtitleParser.js)
ipcMain.handle('import-subtitle', async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Nhập file phụ đề',
      properties: ['openFile'],
      filters: [
        { name: 'Phụ đề (SRT, VTT, ASS, SSA)', extensions: ['srt', 'vtt', 'ass', 'ssa'] },
        { name: 'Tất cả file', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };
    return await require('./services/subtitleFile').readSubtitleFile(result.filePaths[0]);
  } catch (err) {
    console.error('[import-subtitle] Error:', err);
    return { success: false, code: 'read', detail: err.code || err.message, error: err.message };
  }
});

ipcMain.handle('save-subtitle-file', async (event, defaultName) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, {
      title: 'Lưu file phụ đề',
      defaultPath: defaultName || 'subtitles.srt',
      filters: [
        { name: 'SRT Subtitle', extensions: ['srt'] },
        { name: 'WebVTT', extensions: ['vtt'] },
      ],
    });
    if (result.canceled) return null;
    return result.filePath;
  } catch (err) {
    console.error('[save-subtitle-file] Error:', err);
    return null;
  }
});

ipcMain.handle('save-video-file', async (event, defaultName) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, {
      title: 'Lưu video đã ghi phụ đề',
      defaultPath: defaultName || 'output_with_subtitles.mp4',
      filters: [{ name: 'Video MP4', extensions: ['mp4'] }],
    });
    if (result.canceled) return null;
    return result.filePath;
  } catch (err) {
    console.error('[save-video-file] Error:', err);
    return null;
  }
});

// ─── FFmpeg ──────────────────────────────────────────────────────────────────

let ffmpegService = null;
try {
  ffmpegService = require('./services/ffmpeg');
  console.log('[FFmpeg] Service loaded OK');
} catch (err) {
  console.error('[FFmpeg] Failed to load service:', err.message);
}

// ─── Cancellable jobs (extract audio → transcribe → translate) ───────────────
// Each step is its own IPC call with a fresh AbortController, so a cancel never leaks into the next job.
// 'cancel-job' aborts the step in flight; the renderer also stops before starting the next step.

let currentJob = null;   // AbortController of the step running now
let pendingAudio = null; // WAV extracted but not yet handed to a transcribe call

async function runJob(fn) {
  // Model files may be half-deleted right now (see model-cache-delete)
  if (cacheDeleting) return { ...CACHE_DELETING };
  const ac = new AbortController();
  currentJob = ac;
  try {
    return await fn(ac.signal);
  } finally {
    if (currentJob === ac) currentJob = null;
  }
}

ipcMain.handle('cancel-job', async () => {
  const wasRunning = !!currentJob;
  currentJob?.abort();
  // Cancelled between "extract" and "transcribe": the WAV would never be used or deleted
  if (pendingAudio) {
    removeTempAudio(pendingAudio);
    pendingAudio = null;
  }
  return { success: true, wasRunning };
});

ipcMain.handle('extract-audio', async (event, videoPath) => {
  if (!ffmpegService) return { success: false, error: 'FFmpeg service not available' };
  return runJob(async (signal) => {
    const result = await ffmpegService.extractAudio(videoPath, { signal });
    if (result.success) pendingAudio = result.audioPath;
    return result;
  });
});

ipcMain.handle('export-subtitle', async (event, { subtitles, outputPath, format }) => {
  if (!ffmpegService) return { success: false, error: 'FFmpeg service not available' };
  return ffmpegService.exportSubtitle(subtitles, outputPath, format);
});

ipcMain.handle('burn-subtitles', async (event, { videoPath, subtitles, overlays, outputPath, duration }) => {
  if (!ffmpegService) return { success: false, error: 'FFmpeg service not available' };
  return ffmpegService.burnSubtitles(videoPath, subtitles, overlays, outputPath, duration || 0, (progress) => {
    try {
      if (event?.sender && !event.sender.isDestroyed()) {
        event.sender.send('burn-progress', progress);
      }
    } catch (_) {}
  });
});

// ─── Whisper ─────────────────────────────────────────────────────────────────

let whisperService = null;
try {
  whisperService = require('./services/whisper');
  console.log('[Whisper] Service loaded OK');
} catch (err) {
  console.error('[Whisper] Failed to load service:', err.message);
}

function sendTranscribeProgress(event, progress) {
  if (event?.sender && !event.sender.isDestroyed()) {
    event.sender.send('transcribe-progress', progress);
  }
}

// The WAV from extract-audio is only needed for one transcription; only ever delete our own temp files
function removeTempAudio(audioPath) {
  const name = path.basename(audioPath || '');
  if (!name.startsWith('kathsub_audio_') || path.dirname(audioPath) !== require('os').tmpdir()) return;
  fs.unlink(audioPath, (err) => {
    if (err) console.warn('[Whisper] Could not delete temp audio:', err.message);
  });
}

// The transcribe call now owns the WAV (and deletes it when done)
function takeAudio(audioPath) {
  if (pendingAudio === audioPath) pendingAudio = null;
}

ipcMain.handle('transcribe-api', async (event, { audioPath, apiKey, language }) => {
  takeAudio(audioPath);
  if (!whisperService) return { success: false, error: 'Whisper service not available' };
  try {
    return await runJob((signal) =>
      whisperService.transcribeWithAPI(audioPath, apiKey, language, (p) => sendTranscribeProgress(event, p), { signal }));
  } finally {
    removeTempAudio(audioPath);
  }
});

ipcMain.handle('transcribe-local', async (event, { audioPath, modelSize, language, includeVocals }) => {
  takeAudio(audioPath);
  if (!whisperService) return { success: false, error: 'Whisper service not available' };
  try {
    return await runJob((signal) =>
      whisperService.transcribeLocal(audioPath, modelSize, language, (p) => sendTranscribeProgress(event, p), { includeVocals, signal }));
  } finally {
    removeTempAudio(audioPath);
  }
});

// ─── Translate ───────────────────────────────────────────────────────────────

let translateService = null;
try {
  translateService = require('./services/translate');
} catch (err) {
  console.error('[Translate] Failed to load service:', err.message);
}

ipcMain.handle('translate-subtitles', async (event, data) => {
  if (!translateService) return { success: false, error: 'Translate service not available' };
  return runJob((signal) => translateService.translateSubtitles(data, (p) => sendTranscribeProgress(event, p), { signal }));
});

// ─── Ollama setup ────────────────────────────────────────────────────────────

let ollamaService = null;
try {
  ollamaService = require('./services/ollama');
} catch (err) {
  console.error('[Ollama] Failed to load service:', err.message);
}

function sendOllamaProgress(event, progress) {
  if (event?.sender && !event.sender.isDestroyed()) {
    event.sender.send('ollama-setup-progress', progress);
  }
}

const OLLAMA_UNAVAILABLE = { success: false, error: 'Ollama service not available' };

ipcMain.handle('ollama-status', async () => {
  if (!ollamaService) return { installed: false, running: false, models: [] };
  return ollamaService.getStatus();
});

ipcMain.handle('ollama-install', async (event) => {
  if (!ollamaService) return OLLAMA_UNAVAILABLE;
  // The installer is written to DOWNLOAD_DIR, which a cache delete may be removing right now
  if (cacheDeleting) return { ...CACHE_DELETING };
  return ollamaService.installOllama((p) => sendOllamaProgress(event, p));
});

ipcMain.handle('ollama-start', async () => {
  if (!ollamaService) return OLLAMA_UNAVAILABLE;
  return ollamaService.startOllama();
});

ipcMain.handle('ollama-pull', async (event, model) => {
  if (!ollamaService) return OLLAMA_UNAVAILABLE;
  if (cacheDeleting) return { ...CACHE_DELETING }; // an Ollama model may be being deleted
  return ollamaService.pullModel(model, (p) => sendOllamaProgress(event, p));
});

ipcMain.handle('ollama-cancel', async () => {
  ollamaService?.cancelDownload();
  return true;
});

// ─── Model cache (downloaded Whisper / VAD / NLLB models, Ollama models) ─────

let cacheService = null;
try {
  cacheService = require('./services/cache');
} catch (err) {
  console.error('[Cache] Failed to load service:', err.message);
}

let cacheDeleting = false;
// Never delete files a running job (or the Ollama installer download) is reading or writing
const jobBusy = () => !!currentJob || !!ollamaService?.isDownloading?.();
// Errors carry a `code`; the renderer shows the text for it in the UI language (src/locales errorMessage)
const CACHE_UNAVAILABLE = { success: false, code: 'unavailable', error: 'Cache service not available' };
const CACHE_BUSY = { success: false, code: 'busy', error: 'A job is running' };
const CACHE_DELETING = { success: false, code: 'cacheDeleting', error: 'Model cache is being deleted' };

ipcMain.handle('model-cache-info', async () => {
  if (!cacheService) return CACHE_UNAVAILABLE;
  try {
    const info = await cacheService.getCacheInfo();
    return { ...info, ollama: await cacheService.listOllamaModels(), busy: jobBusy() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// key: a group key from model-cache-info ('whisper:small', 'nllb', 'downloads', ...) or 'all' — never a path
ipcMain.handle('model-cache-delete', async (event, key) => {
  if (!cacheService) return CACHE_UNAVAILABLE;
  if (typeof key !== 'string') return { success: false, code: 'invalidKey', error: 'Invalid key' };
  if (cacheDeleting) return CACHE_DELETING;
  if (jobBusy()) return CACHE_BUSY;
  cacheDeleting = true;
  try {
    return await cacheService.deleteCacheGroup(key);
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    cacheDeleting = false;
  }
});

ipcMain.handle('ollama-delete-model', async (event, name) => {
  if (!cacheService) return CACHE_UNAVAILABLE;
  if (cacheDeleting) return CACHE_DELETING;
  if (jobBusy()) return CACHE_BUSY;
  cacheDeleting = true;
  try {
    return await cacheService.deleteOllamaModel(name);
  } finally {
    cacheDeleting = false;
  }
});

// ─── App updates ─────────────────────────────────────────────────────────────

ipcMain.handle('update-download', async () => {
  if (!updaterService) return { success: false, error: 'Updater not available' };
  return updaterService.downloadUpdate();
});

ipcMain.handle('update-install', async () => {
  updaterService?.installUpdate();
  return true;
});

ipcMain.handle('update-open-page', async () => {
  updaterService?.openReleasePage();
  return true;
});
