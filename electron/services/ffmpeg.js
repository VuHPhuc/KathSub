const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { CANCELLED_RESULT } = require('./jobs');

// ─── FFmpeg Binary Resolver (Packaged vs Dev) ────────────────────────────────
function getFfmpegPath() {
  let p = ffmpegStatic;
  if (!p) {
    p = 'ffmpeg';
  }
  // When running inside packaged Electron app (.asar), binaries are in app.asar.unpacked
  if (typeof p === 'string' && p.includes('app.asar')) {
    const unpacked = p.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) {
      p = unpacked;
    }
  }
  // Extra fallback: check resourcesPath
  if (process.resourcesPath) {
    const isWin = process.platform === 'win32';
    const exeName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
    const directUnpacked = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'ffmpeg-static',
      exeName
    );
    if (fs.existsSync(directUnpacked)) {
      p = directUnpacked;
    }
  }
  return p;
}

ffmpeg.setFfmpegPath(getFfmpegPath());

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function toSRTTime(seconds) {
  const h  = Math.floor(seconds / 3600);
  const m  = Math.floor((seconds % 3600) / 60);
  const s  = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

function toVTTTime(seconds) {
  return toSRTTime(seconds).replace(',', '.');
}

function toASSTime(seconds) {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const h  = Math.floor(seconds / 3600);
  const m  = Math.floor((seconds % 3600) / 60);
  const s  = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

function parseTimemark(tm) {
  if (!tm || tm === 'N/A') return 0;
  const parts = String(tm).trim().split(':');
  if (parts.length === 3) {
    return (parseFloat(parts[0]) || 0) * 3600 + (parseFloat(parts[1]) || 0) * 60 + (parseFloat(parts[2]) || 0);
  }
  return 0;
}

function colorToAss(colorStr) {
  if (!colorStr) return '&H00FFFFFF';
  colorStr = colorStr.trim();

  let r = 255, g = 255, b = 255, a = 1;

  if (colorStr.startsWith('#')) {
    let hex = colorStr.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    } else if (hex.length === 8) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      a = parseInt(hex.slice(6, 8), 16) / 255;
    }
  } else if (colorStr.startsWith('rgb')) {
    const match = colorStr.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
    if (match) {
      r = parseInt(match[1], 10);
      g = parseInt(match[2], 10);
      b = parseInt(match[3], 10);
      if (match[4] !== undefined) {
        a = parseFloat(match[4]);
      }
    }
  }

  // In ASS, Alpha is 00 (opaque) to FF (fully transparent)
  const assA = Math.max(0, Math.min(255, Math.round((1 - a) * 255))).toString(16).padStart(2, '0').toUpperCase();
  const assB = Math.max(0, Math.min(255, b)).toString(16).padStart(2, '0').toUpperCase();
  const assG = Math.max(0, Math.min(255, g)).toString(16).padStart(2, '0').toUpperCase();
  const assR = Math.max(0, Math.min(255, r)).toString(16).padStart(2, '0').toUpperCase();

  return `&H${assA}${assB}${assG}${assR}`;
}

function buildSRT(subtitles) {
  const sorted = [...subtitles].sort((a, b) => a.startTime - b.startTime);
  return sorted.map((sub, i) =>
    `${i + 1}\n${toSRTTime(sub.startTime)} --> ${toSRTTime(sub.endTime)}\n${sub.text}\n`
  ).join('\n') + '\n';
}

function buildVTT(subtitles) {
  const sorted = [...subtitles].sort((a, b) => a.startTime - b.startTime);
  const body = sorted.map((sub, i) =>
    `${i + 1}\n${toVTTTime(sub.startTime)} --> ${toVTTTime(sub.endTime)}\n${sub.text}`
  ).join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

function buildASS(subtitles, resX = 1920, resY = 1080) {
  const sorted = [...subtitles].sort((a, b) => a.startTime - b.startTime);

  const header = `[Script Info]
Title: KathSub Generated Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: ${resX}
PlayResY: ${resY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat,54,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,5,20,20,20,1
Style: Boxed,Montserrat,54,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,10,0,5,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = sorted.map((sub) => {
    const start = toASSTime(sub.startTime);
    const end = toASSTime(sub.endTime);

    const rawFont = sub.fontFamily || 'Montserrat';
    const fontName = rawFont.split(',')[0].trim().replace(/['"]/g, '');
    const fontSize = Math.round((sub.fontSize || 24) * 2.2);

    const primaryColor = colorToAss(sub.color || '#ffffff');
    const posX = Math.round(((sub.x ?? 50) / 100) * resX);
    const posY = Math.round(((sub.y ?? 84) / 100) * resY);

    const bold = sub.bold ? '\\b1' : '\\b0';
    const italic = sub.italic ? '\\i1' : '\\i0';

    let styleName = 'Default';
    let tags = '';

    if (sub.hasBox) {
      styleName = 'Boxed';
      // In ASS BorderStyle=3, \3c acts as the box background color, \bord10 provides border padding around text
      const boxBgColor = colorToAss(sub.backgroundColor || '#000000');
      tags = `{\\an5\\pos(${posX},${posY})\\fn${fontName}\\fs${fontSize}${bold}${italic}\\1c${primaryColor}\\3c${boxBgColor}\\bord10}`;
    } else {
      styleName = 'Default';
      // In ASS BorderStyle=1, \3c is outline color, \bord is text outline width
      const outlineColor = colorToAss(sub.outlineColor || '#000000');
      const outlineW = sub.outlineWidth ? `\\bord${Math.round(sub.outlineWidth * 1.5)}` : '\\bord3';
      tags = `{\\an5\\pos(${posX},${posY})\\fn${fontName}\\fs${fontSize}${bold}${italic}\\1c${primaryColor}\\3c${outlineColor}${outlineW}}`;
    }

    const textFormatted = (sub.text || '').replace(/\r?\n/g, '\\N');

    return `Dialogue: 0,${start},${end},${styleName},,0,0,0,,${tags}${textFormatted}`;
  });

  return header + events.join('\n') + '\n';
}

// ─── Extract audio for Whisper ───────────────────────────────────────────────

// `signal` (optional): aborting it kills ffmpeg and resolves { cancelled: true } (the user pressed Cancel)
async function extractAudio(videoPath, { signal } = {}) {
  const outputPath = path.join(os.tmpdir(), `kathsub_audio_${Date.now()}.wav`);

  // Always resolve: a rejected IPC promise left the transcribe dialog stuck in "processing"
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ...CANCELLED_RESULT });

    const cmd = ffmpeg(videoPath)
      .noVideo()
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .output(outputPath);
    const onAbort = () => {
      try {
        cmd.kill('SIGKILL');
      } catch (_) {}
    };
    const finish = (result) => {
      signal?.removeEventListener('abort', onAbort);
      activeCommands.delete(cmd);
      resolve(result);
    };

    cmd
      .on('end', () => {
        // Finished in the same moment the user cancelled: nobody will use the WAV
        if (signal?.aborted) {
          tryUnlink(outputPath);
          return finish({ ...CANCELLED_RESULT });
        }
        finish({ success: true, audioPath: outputPath });
      })
      .on('error', (err) => {
        tryUnlink(outputPath);
        finish(signal?.aborted ? { ...CANCELLED_RESULT } : { success: false, error: err.message });
      });
    signal?.addEventListener('abort', onAbort, { once: true });
    activeCommands.add(cmd); // also killed by cancelAll() when the app quits
    cmd.run();
  });
}

// ─── Export subtitle file ────────────────────────────────────────────────────

async function exportSubtitle(subtitles, outputPath, format) {
  try {
    let content = '';
    if (format === 'vtt') {
      content = buildVTT(subtitles);
    } else if (format === 'ass') {
      content = buildASS(subtitles);
    } else {
      content = buildSRT(subtitles);
    }
    fs.writeFileSync(outputPath, content, 'utf8');
    return { success: true, outputPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Burn subtitles & icon overlays into video ──────────────────────────────

const activeCommands = new Set();

function cancelAll() {
  for (const cmd of activeCommands) {
    try {
      cmd.kill('SIGKILL');
    } catch (_) {}
  }
  activeCommands.clear();
}

async function burnSubtitles(videoPath, subtitles = [], overlays = [], outputPath, duration = 0, onProgress) {
  if (typeof duration === 'function' && !onProgress) {
    onProgress = duration;
    duration = 0;
  }
  const tempFiles = [];

  try {
    const cmd = ffmpeg(videoPath);
    activeCommands.add(cmd);
    const filterComplex = [];
    let currentStream = '0:v';

    // 1. Process Overlay Images / Icons
    if (overlays && overlays.length > 0) {
      overlays.forEach((ov, i) => {
        if (!ov.imageDataUrl) return;
        const matches = ov.imageDataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) return;

        const buffer = Buffer.from(matches[2], 'base64');
        const tempImg = path.join(os.tmpdir(), `kath_ov_${Date.now()}_${i}.png`);
        fs.writeFileSync(tempImg, buffer);
        tempFiles.push(tempImg);

        cmd.input(tempImg).inputOptions(['-loop 1']);
        const inputIdx = tempFiles.length; // 1, 2, 3...
        const nextStream = `v_ov_${i}`;
        const xPct = (ov.x ?? 50) / 100;
        const yPct = (ov.y ?? 50) / 100;
        const startTime = (ov.startTime || 0).toFixed(2);
        const endTime = (ov.endTime || 999999).toFixed(2);

        filterComplex.push(
          `[${currentStream}][${inputIdx}:v]overlay=x=(main_w*${xPct})-(overlay_w/2):y=(main_h*${yPct})-(overlay_h/2):enable='between(t\\,${startTime}\\,${endTime})':shortest=0[${nextStream}]`
        );
        currentStream = nextStream;
      });
    }

    // 2. Process Subtitles via ASS
    if (subtitles && subtitles.length > 0) {
      const tempAss = path.join(os.tmpdir(), `kathsub_burn_${Date.now()}.ass`);
      fs.writeFileSync(tempAss, buildASS(subtitles), 'utf8');
      tempFiles.push(tempAss);

      const escapedAss = tempAss.replace(/\\/g, '/').replace(/:/g, '\\:');
      const nextStream = `v_sub`;
      filterComplex.push(`[${currentStream}]subtitles='${escapedAss}'[${nextStream}]`);
      currentStream = nextStream;
    }

    if (filterComplex.length > 0) {
      cmd.complexFilter(filterComplex, currentStream);
    }

    const outputOpts = [
      '-map 0:a?',
      '-c:v libx264',
      '-preset veryfast',
      '-crf 22',
      '-pix_fmt yuv420p',
      '-c:a aac',
      '-b:a 192k',
    ];

    return new Promise((resolve) => {
      cmd
        .outputOptions(outputOpts)
        .output(outputPath)
        .on('progress', (p) => {
          let pct = 0;
          if (duration > 0 && p.timemark && p.timemark !== 'N/A') {
            const currentSec = parseTimemark(p.timemark);
            pct = Math.min(Math.round((currentSec / duration) * 100), 99);
          } else if (typeof p.percent === 'number' && !isNaN(p.percent) && p.percent > 0) {
            pct = Math.min(Math.round(p.percent), 99);
          }
          onProgress && onProgress(pct);
        })
        .on('end', () => {
          activeCommands.delete(cmd);
          tempFiles.forEach(tryUnlink);
          onProgress && onProgress(100);
          resolve({ success: true, outputPath });
        })
        .on('error', (err) => {
          activeCommands.delete(cmd);
          tempFiles.forEach(tryUnlink);
          resolve({ success: false, error: err.message });
        })
        .run();
    });
  } catch (err) {
    tempFiles.forEach(tryUnlink);
    return { success: false, error: err.message };
  }
}

function tryUnlink(p) {
  try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
}

module.exports = { extractAudio, exportSubtitle, burnSubtitles, cancelAll, buildSRT, buildVTT, buildASS, getFfmpegPath };
