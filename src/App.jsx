import React, { useState, useEffect, useCallback } from 'react';
import useStore from './store/subtitleStore';
import { t } from './locales';
import Toolbar from './components/Toolbar/Toolbar';
import VideoPlayer from './components/VideoPlayer/VideoPlayer';
import SubtitlePanel from './components/SubtitlePanel/SubtitlePanel';
import Timeline from './components/Timeline/Timeline';
import AutoTranscribe from './components/AutoTranscribe/AutoTranscribe';
import Toast from './components/Toast/Toast';
import UpdateNotice from './components/UpdateNotice/UpdateNotice';
import {
  IconFilm,
  IconFolder,
  IconMinimize,
  IconMaximize,
  IconClose,
} from './components/Icons/StudioIcons';

export default function App() {
  const { videoPath, showAutoPanel, setVideo } = useStore();
  const [toasts, setToasts]     = useState([]);
  const [isDragging, setIsDragging] = useState(false);

  const addToast = useCallback((message, type = 'info') => {
    // Unique even for several toasts in the same millisecond (used as the React key)
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  // ── Global drag & drop for video files ───────────────────────────────────
  useEffect(() => {
    // MUST preventDefault on every dragover/dragenter so Electron doesn't
    // navigate the window to the file URL on drop.
    const onDragEnter = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); };
    const onDragOver  = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); };
    const onDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); };
    const onDrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const file = e.dataTransfer.files[0];
      if (!file) return;

      // Accept by extension (MIME type unreliable for drag from Windows Explorer)
      const name = file.name || '';
      const isVideo = /\.(mp4|mkv|avi|mov|webm|flv|m4v|wmv|ts|mts|mpg|mpeg)$/i.test(name)
                   || (file.type && file.type.startsWith('video/'));

      if (isVideo) {
        let filePath = '';
        if (window.electron && typeof window.electron.getPathForFile === 'function') {
          try {
            filePath = window.electron.getPathForFile(file);
          } catch (err) {
            console.error('getPathForFile error:', err);
          }
        }
        if (!filePath) {
          filePath = file.path || '';
        }

        if (filePath) {
          setVideo(filePath);
        } else {
          addToast('Không đọc được đường dẫn file. Hãy dùng nút "Mở video".', 'error');
        }
      } else {
        addToast('Chỉ hỗ trợ file video (MP4, MKV, AVI, MOV...)', 'error');
      }
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover',  onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop',      onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover',  onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop',      onDrop);
    };
  }, [setVideo, addToast]);

  return (
    <div className="app">
      <TitleBar />
      <Toolbar addToast={addToast} />
      <div className="main-content">
        <div className="video-section">
          {videoPath ? (
            <>
              <VideoPlayer addToast={addToast} />
              <Timeline />
            </>
          ) : (
            <DropZone isDragging={isDragging} addToast={addToast} />
          )}
        </div>
        <SubtitlePanel addToast={addToast} />
      </div>
      {showAutoPanel && <AutoTranscribe addToast={addToast} />}
      <UpdateNotice />
      <Toast toasts={toasts} />
    </div>
  );
}

// ─── Custom Titlebar ──────────────────────────────────────────────────────────

function TitleBar() {
  const { language } = useStore();
  return (
    <div className="titlebar">
      <div className="titlebar-logo">
        <img src="./icon.png" alt="KathSub Logo" className="titlebar-app-icon" />
        <span className="logo-text">{t('appName', language)}</span>
        <span className="logo-tagline">
          — {t('tagline', language)}
        </span>
      </div>
      <div className="titlebar-controls">
        <button className="titlebar-btn" id="btn-minimize" onClick={() => window.electron?.minimize()} title="Thu nhỏ">
          <IconMinimize size={12} />
        </button>
        <button className="titlebar-btn" id="btn-maximize" onClick={() => window.electron?.maximize()} title="Phóng to">
          <IconMaximize size={11} />
        </button>
        <button className="titlebar-btn close" id="btn-close" onClick={() => window.electron?.close()} title="Đóng">
          <IconClose size={12} />
        </button>
      </div>
    </div>
  );
}

// ─── Drop Zone ────────────────────────────────────────────────────────────────

function DropZone({ isDragging, addToast }) {
  const { setVideo, language } = useStore();

  const handleOpenClick = async (e) => {
    e.stopPropagation();

    // Safety check — only available inside Electron
    if (!window.electron) {
      addToast('Electron API không khả dụng. Bạn đang chạy trong browser?', 'error');
      return;
    }

    try {
      const filePath = await window.electron.openVideo();
      if (filePath) {
        setVideo(filePath);
      }
    } catch (err) {
      console.error('openVideo error:', err);
      addToast('Không mở được dialog: ' + err.message, 'error');
    }
  };

  return (
    <div
      className={`dropzone${isDragging ? ' dragging' : ''}`}
      id="dropzone"
      onClick={handleOpenClick}
    >
      <div className="dropzone-icon">
        <IconFilm size={44} color="#3b82f6" />
      </div>
      <h2>{t('dragDropVideo', language)}</h2>
      <p>{t('supportedFormats', language)}</p>
      <button
        className="btn btn-primary"
        id="open-video-btn"
        style={{ marginTop: 8 }}
        onClick={handleOpenClick}
      >
        <IconFolder size={14} />
        <span>{t('openVideo', language)}</span>
      </button>

      {/* Debug indicator — visible only if window.electron is missing */}
      {!window.electron && (
        <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>
          ⚠ window.electron không tồn tại — preload chưa load?
        </p>
      )}
    </div>
  );
}
