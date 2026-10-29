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

ipcMain.handle('extract-audio', async (event, videoPath) => {
  if (!ffmpegService) return { success: false, error: 'FFmpeg service not available' };
  return ffmpegService.extractAudio(videoPath);
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

ipcMain.handle('transcribe-api', async (event, { audioPath, apiKey, language }) => {
  if (!whisperService) return { success: false, error: 'Whisper service not available' };
  return whisperService.transcribeWithAPI(audioPath, apiKey, language, (progress) => {
    try {
      if (event?.sender && !event.sender.isDestroyed()) {
        event.sender.send('transcribe-progress', progress);
      }
    } catch (_) {}
  });
});

ipcMain.handle('transcribe-local', async (event, { audioPath, modelSize, language }) => {
  if (!whisperService) return { success: false, error: 'Whisper service not available' };
  return whisperService.transcribeLocal(audioPath, modelSize, language, (progress) => {
    try {
      if (event?.sender && !event.sender.isDestroyed()) {
        event.sender.send('transcribe-progress', progress);
      }
    } catch (_) {}
  });
});
