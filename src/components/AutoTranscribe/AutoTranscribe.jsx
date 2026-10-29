import React, { useState, useEffect } from 'react';
import useStore from '../../store/subtitleStore';
import { t } from '../../locales';

const MODELS = ['tiny', 'base', 'small', 'medium'];
const LANGS  = [
  { code: 'vi',   labelKey: 'langVi' },
  { code: 'en',   labelKey: 'langEn' },
  { code: 'auto', labelKey: 'langAuto' },
];

export default function AutoTranscribe({ addToast }) {
  const {
    videoPath, setShowAutoPanel, setSubtitles, language: uiLang,
    setProcessing, isProcessing, processStatus, processProgress,
  } = useStore();

  const [transcribeMode, setTranscribeMode] = useState('cloud'); // 'cloud' | 'local'
  const [apiKey,     setApiKey]     = useState('');
  const [modelSize,  setModelSize]  = useState('small');
  const [subLang,    setSubLang]    = useState('vi');
  const [progress,   setProgress]   = useState({ message: '', percent: 0 });
  const [running,    setRunning]    = useState(false);

  // Subscribe to transcribe-progress events
  useEffect(() => {
    const unsub = window.electron.on('transcribe-progress', (data) => {
      setProgress({ message: data.message ?? '', percent: data.percent ?? 0 });
    });
    return unsub;
  }, []);

  const handleStart = async () => {
    if (!videoPath) return;
    setRunning(true);
    setProgress({ message: t('extractingAudio', uiLang), percent: 2 });

    // Step 1: Extract audio
    const audioResult = await window.electron.extractAudio(videoPath);
    if (!audioResult.success) {
      addToast(`❌ ${audioResult.error}`, 'error');
      setRunning(false);
      return;
    }

    // Step 2: Transcribe
    let result;
    if (transcribeMode === 'cloud') {
      if (!apiKey.trim()) {
        addToast('❌ Vui lòng nhập OpenAI API Key!', 'error');
        setRunning(false);
        return;
      }
      result = await window.electron.transcribeApi({
        audioPath: audioResult.audioPath,
        apiKey: apiKey.trim(),
        language: subLang,
      });
    } else {
      result = await window.electron.transcribeLocal({
        audioPath: audioResult.audioPath,
        modelSize,
        language: subLang,
      });
    }

    setRunning(false);

    if (result.success) {
      setSubtitles(result.subtitles);
      addToast(`✅ Nhận dạng xong! Tìm thấy ${result.subtitles.length} phụ đề.`, 'success');
      setShowAutoPanel(false);
    } else {
      addToast(`❌ Lỗi: ${result.error}`, 'error');
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !running && setShowAutoPanel(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} id="auto-transcribe-modal">

        <div className="modal-title">{t('transcribeTitle', uiLang)}</div>

        {/* Cloud / Local tabs */}
        <div className="sub-tabs">
          <button
            className={`sub-tab${transcribeMode === 'cloud' ? ' active' : ''}`}
            id="tab-cloud"
            onClick={() => setTranscribeMode('cloud')}
          >
            {t('cloudMode', uiLang)}
          </button>
          <button
            className={`sub-tab${transcribeMode === 'local' ? ' active' : ''}`}
            id="tab-local"
            onClick={() => setTranscribeMode('local')}
          >
            {t('localMode', uiLang)}
          </button>
        </div>

        {/* Cloud mode fields */}
        {transcribeMode === 'cloud' && (
          <div className="form-group">
            <label className="form-label">{t('apiKey', uiLang)}</label>
            <input
              type="password"
              className="form-input"
              id="input-api-key"
              placeholder={t('enterApiKey', uiLang)}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
            <div className="form-hint">
              Lấy API key tại <span style={{ color: 'var(--accent-light)' }}>platform.openai.com</span>. Sử dụng model <strong>whisper-1</strong>.
            </div>
          </div>
        )}

        {/* Local mode fields */}
        {transcribeMode === 'local' && (
          <div className="form-group">
            <label className="form-label">{t('modelSize', uiLang)}</label>
            <select
              className="form-select"
              id="select-model"
              value={modelSize}
              onChange={(e) => setModelSize(e.target.value)}
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>{t(m, uiLang)}</option>
              ))}
            </select>
            <div className="form-hint">⚠ {t('localNote', uiLang)}</div>
          </div>
        )}

        {/* Language */}
        <div className="form-group">
          <label className="form-label">{t('language', uiLang)}</label>
          <select
            className="form-select"
            id="select-lang"
            value={subLang}
            onChange={(e) => setSubLang(e.target.value)}
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>{t(l.labelKey, uiLang)}</option>
            ))}
          </select>
        </div>

        {/* Progress */}
        {running && (
          <div className="progress-wrap">
            <div className="progress-label">{progress.message}</div>
            <div className="progress-bar-bg">
              <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="modal-footer">
          <button
            className="btn btn-ghost"
            id="btn-cancel-transcribe"
            onClick={() => setShowAutoPanel(false)}
            disabled={running}
          >
            {t('cancel', uiLang)}
          </button>
          <button
            className="btn btn-primary"
            id="btn-start-transcribe"
            onClick={handleStart}
            disabled={running}
          >
            {running ? '⏳ ' + t('processing', uiLang) : '🎙 ' + t('startTranscribe', uiLang)}
          </button>
        </div>
      </div>
    </div>
  );
}
