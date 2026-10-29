import React, { useState, useEffect } from 'react';
import useStore from '../../store/subtitleStore';
import { t } from '../../locales';
import {
  IconFolder,
  IconSubtitles,
  IconWand,
  IconExport,
  IconFileText,
} from '../Icons/StudioIcons';

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
    </div>
  );
}
