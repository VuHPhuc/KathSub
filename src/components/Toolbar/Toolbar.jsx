import React, { useState, useEffect } from 'react';
import useStore from '../../store/subtitleStore';
import { t, errorMessage } from '../../locales';
import {
  IconFolder,
  IconSubtitles,
  IconWand,
  IconExport,
  IconFileText,
  IconFileImport,
} from '../Icons/StudioIcons';
import { parseSubtitles } from '../../utils/subtitleParser';

const makeSubId = () => `sub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

function renderOverlayToDataUrl(ov) {
  if (ov.type === 'image' && ov.content) {
    return ov.content;
  }
  const canvas = document.createElement('canvas');
  const scale = ov.scale || 1.2;
  const size = Math.round(56 * scale);

  if (ov.type === 'badge') {
    const fontSize = Math.round(22 * scale);
    const ctx = canvas.getContext('2d');
    ctx.font = `bold ${fontSize}px sans-serif`;
    const text = ov.content || 'BADGE';
    const metrics = ctx.measureText(text);
    canvas.width = Math.round(metrics.width + 36 * scale);
    canvas.height = Math.round(fontSize + 24 * scale);

    // Draw red pill badge
    ctx.fillStyle = '#e50914';
    const r = 8;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, canvas.width, canvas.height, r);
    else ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    return canvas.toDataURL('image/png');
  }

  // Emoji
  canvas.width = size * 2;
  canvas.height = size * 2;
  const ctx = canvas.getContext('2d');
  ctx.font = `${Math.round(size * 1.1)}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ov.content || '🔥', canvas.width / 2, canvas.height / 2);
  return canvas.toDataURL('image/png');
}

export default function Toolbar({ addToast }) {
  const {
    videoPath, videoName, mode, language,
    setMode, setShowAutoPanel, toggleLanguage,
    subtitles, overlays, videoDuration,
    isProcessing, processStatus, processProgress, setProcessing,
  } = useStore();

  const [exportProgress, setExportProgress] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  // Parsed file waiting for "replace / merge / cancel" when the timeline already has subtitles
  const [pendingImport, setPendingImport] = useState(null);

  const hasVideo = Boolean(videoPath);
  const hasContent = subtitles.length > 0 || overlays.length > 0;

  // Listen for burn progress from electron
  useEffect(() => {
    if (!window.electron?.on) return;
    const unsub = window.electron.on('burn-progress', (progress) => {
      setExportProgress(progress);
    });
    return unsub;
  }, []);

  // ── Export SRT ──────────────────────────────────────────────────────────────
  const handleExportSRT = async () => {
    if (subtitles.length === 0) {
      addToast('⚠️ Chưa có phụ đề để xuất SRT', 'warning');
      return;
    }
    const savePath = await window.electron.saveSubtitleFile(
      videoName.replace(/\.[^.]+$/, '.srt')
    );
    if (!savePath) return;
    const result = await window.electron.exportSubtitle({ subtitles, outputPath: savePath, format: 'srt' });
    if (result.success) addToast('Đã xuất file SRT thành công!', 'success');
    else addToast(`Lỗi: ${result.error}`, 'error');
  };

  // ── Export VTT ──────────────────────────────────────────────────────────────
  const handleExportVTT = async () => {
    if (subtitles.length === 0) {
      addToast('⚠️ Chưa có phụ đề để xuất VTT', 'warning');
      return;
    }
    const savePath = await window.electron.saveSubtitleFile(
      videoName.replace(/\.[^.]+$/, '.vtt')
    );
    if (!savePath) return;
    const result = await window.electron.exportSubtitle({ subtitles, outputPath: savePath, format: 'vtt' });
    if (result.success) addToast('Đã xuất file VTT thành công!', 'success');
    else addToast(`Lỗi: ${result.error}`, 'error');
  };

  // ── Burn subtitles & overlays into final MP4 ─────────────────────────────────
  const handleBurn = async () => {
    if (!hasVideo) {
      addToast('⚠️ Vui lòng mở video trước!', 'warning');
      return;
    }
    if (!hasContent) {
      addToast('⚠️ Hãy thêm ít nhất 1 phụ đề hoặc 1 icon để xuất video!', 'warning');
      return;
    }
    const defaultName = videoName.replace(/(\.[^.]+)$/, '_kath_subtitled$1');
    const outputPath = await window.electron.saveVideoFile(defaultName);
    if (!outputPath) return;

    setIsExporting(true);
    setExportProgress(0);
    addToast('🎬 Bắt đầu xuất video hoàn chỉnh (phụ đề + icon)...', 'info');

    try {
      const preparedOverlays = overlays.map((ov) => ({
        ...ov,
        imageDataUrl: renderOverlayToDataUrl(ov),
      }));

      const result = await window.electron.burnSubtitles({
        videoPath,
        subtitles,
        overlays: preparedOverlays,
        outputPath,
        duration: videoDuration || 0,
      });

      if (result.success) {
        addToast(`Xuất video thành công: ${outputPath}`, 'success');
      } else {
        addToast(`Lỗi khi xuất video: ${result.error}`, 'error');
      }
    } catch (err) {
      addToast(`Lỗi xuất video: ${err.message}`, 'error');
    } finally {
      setIsExporting(false);
      setExportProgress(0);
    }
  };

  // ── Import subtitle file (.srt / .vtt / .ass / .ssa) ────────────────────────
  // Needs an open video: the timeline only exists with one, and opening a video clears the subtitles.
  const applyImport = ({ subs, fileName, encoding, stats }, mode) => {
    const store = useStore.getState();
    store.setSubtitles(mode === 'merge' ? [...store.subtitles, ...subs] : subs);
    let msg = `${t('importDone', language)} ${subs.length} — ${fileName}`;
    if (encoding && encoding !== 'utf-8') msg += ` (${t('importEncoding', language)} ${encoding})`;
    addToast(msg, 'success');
    const dropped = stats.dropped.empty + stats.dropped.badTime;
    if (dropped || stats.fixedTimes) {
      addToast(`${t('importSkipped', language)} ${dropped} · ${t('importFixed', language)} ${stats.fixedTimes}`, 'info');
    }
    const duration = store.videoDuration;
    const outside = duration > 0 ? subs.filter((s) => s.startTime >= duration).length : 0;
    if (outside) addToast(`⚠️ ${outside} ${t('importBeyondVideo', language)}`, 'warning');
  };

  const handleImportSubtitle = async () => {
    if (!window.electron?.importSubtitle || importing || !hasVideo) return;
    setImporting(true);
    try {
      const res = await window.electron.importSubtitle();
      if (!res || res.canceled) return;
      if (!res.success) {
        addToast(`${t('importFailed', language)} ${errorMessage(res, language)}`, 'error');
        return;
      }

      const { cues, stats } = parseSubtitles(res.content, res.fileName);
      if (!cues.length) {
        addToast(`${t('importFailed', language)} ${t('importNoCues', language)}`, 'error');
        return;
      }
      const { subtitleStyle } = useStore.getState();
      const subs = cues.map((c) => ({ id: makeSubId(), startTime: c.start, endTime: c.end, text: c.text, ...subtitleStyle }));
      const parsed = { subs, fileName: res.fileName, encoding: res.encoding, stats };

      if (useStore.getState().subtitles.length > 0) setPendingImport(parsed);
      else applyImport(parsed, 'replace');
    } catch (err) {
      console.error('importSubtitle error:', err);
      addToast(`${t('importFailed', language)} ${err.message}`, 'error');
    } finally {
      setImporting(false);
    }
  };

  const resolvePendingImport = (mode) => {
    const pending = pendingImport;
    setPendingImport(null);
    if (pending && mode !== 'cancel') applyImport(pending, mode);
  };

  // ── Open video file dialog ──────────────────────────────────────────────────
  const handleOpenVideo = async () => {
    if (!window.electron) return;
    try {
      const filePath = await window.electron.openVideo();
      if (filePath) {
        useStore.getState().setVideo(filePath);
        addToast('🎬 Đã tải video thành công!', 'success');
      }
    } catch (err) {
      console.error('openVideo toolbar error:', err);
      addToast('Không thể mở video', 'error');
    }
  };

  return (
    <div className="toolbar">
      {/* Open Video */}
      <button className="btn btn-secondary" id="tb-open-video" onClick={handleOpenVideo}>
        <IconFolder size={15} />
        <span>{t('openVideo', language)}</span>
      </button>

      {/* Import subtitle file — the span carries the tooltip, a disabled button gets no mouse events */}
      <span className="tb-btn-wrap" title={hasVideo ? t('importSubtitleHint', language) : t('importNeedVideo', language)}>
        <button
          className="btn btn-secondary"
          id="tb-import-subtitle"
          onClick={handleImportSubtitle}
          disabled={!hasVideo || importing}
        >
          <IconFileImport size={15} />
          <span>{importing ? t('importing', language) : t('importSubtitle', language)}</span>
        </button>
      </span>

      {hasVideo && (
        <span className="tb-video-title" title={videoName}>
          {videoName}
        </span>
      )}

      <div className="toolbar-divider" />

      {/* Mode toggle */}
      <div className="mode-toggle" id="mode-toggle">
        <button
          className={`mode-btn ${mode === 'manual' ? 'active' : ''}`}
          id="mode-manual"
          onClick={() => setMode('manual')}
        >
          <IconSubtitles size={13} />
          <span>{t('manual', language)}</span>
        </button>
        <button
          className={`mode-btn ${mode === 'auto' ? 'active' : ''}`}
          id="mode-auto"
          onClick={() => setMode('auto')}
        >
          <IconWand size={13} />
          <span>AI Whisper</span>
        </button>
      </div>

      {/* Auto transcribe trigger */}
      {mode === 'auto' && hasVideo && (
        <button
          className="btn btn-secondary"
          id="tb-transcribe"
          onClick={() => setShowAutoPanel(true)}
          style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
        >
          <IconWand size={14} />
          <span>Tạo phụ đề tự động AI</span>
        </button>
      )}

      <div style={{ flex: 1 }} />

      {/* Export status bar if exporting */}
      {isExporting && (
        <div className="tb-export-progress-bar">
          <span>Đang xuất MP4: {exportProgress}%</span>
          <div className="tb-prog-outer">
            <div className="tb-prog-inner" style={{ width: `${exportProgress}%` }} />
          </div>
        </div>
      )}

      {/* Export SRT / VTT */}
      <button
        className="btn btn-ghost"
        onClick={handleExportSRT}
        disabled={subtitles.length === 0}
        title="Lưu file phụ đề SRT"
      >
        <IconFileText size={14} />
        <span>Xuất SRT</span>
      </button>

      {/* Burn Video Output */}
      <button
        className="btn btn-burn"
        id="tb-burn-btn"
        onClick={handleBurn}
        disabled={!hasVideo || isExporting}
        title="Xuất video MP4 hoàn chỉnh với phụ đề và icon đã ghép"
      >
        <IconExport size={15} />
        <span>{isExporting ? `Đang ghi ${exportProgress}%...` : 'Xuất Video MP4'}</span>
      </button>

      {/* Timeline already has subtitles: replace them, merge, or cancel the import */}
      {pendingImport && (
        <div className="modal-overlay" onClick={() => resolvePendingImport('cancel')}>
          <div
            className="modal import-confirm"
            id="import-confirm-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === 'Escape' && resolvePendingImport('cancel')}
          >
            <div className="at-title">{t('importConfirmTitle', language)}</div>
            <div className="import-confirm-text">
              {t('importConfirmText', language)
                // Replacer functions: a file name with "$&" or "$'" must be shown literally (REV-06)
                .replace('{current}', () => subtitles.length)
                .replace('{count}', () => pendingImport.subs.length)
                .replace('{file}', () => pendingImport.fileName)}
            </div>
            <div className="at-footer">
              <button className="btn btn-ghost" id="btn-import-cancel" onClick={() => resolvePendingImport('cancel')}>
                {t('cancel', language)}
              </button>
              <button className="btn btn-secondary" id="btn-import-merge" onClick={() => resolvePendingImport('merge')}>
                {t('importMerge', language)}
              </button>
              <button className="btn btn-primary" id="btn-import-replace" autoFocus onClick={() => resolvePendingImport('replace')}>
                {t('importReplace', language)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
