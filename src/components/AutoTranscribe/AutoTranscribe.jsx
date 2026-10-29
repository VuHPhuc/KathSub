import React, { useState, useEffect } from 'react';
import useStore from '../../store/subtitleStore';
import { t } from '../../locales';
import OllamaSetup from './OllamaSetup';
import { loadPref, savePref } from '../../utils/prefs';

const MODELS = ['tiny', 'base', 'small', 'medium'];
const SOURCE_LANGS = [
  { code: 'auto', labelKey: 'langAuto' },
  { code: 'ja',   labelKey: 'langJa' },
  { code: 'ko',   labelKey: 'langKo' },
  { code: 'zh',   labelKey: 'langZh' },
  { code: 'en',   labelKey: 'langEn' },
  { code: 'vi',   labelKey: 'langVi' },
];
const TARGET_LANGS = [
  { code: 'none', labelKey: 'noTranslate' },
  { code: 'vi',   labelKey: 'langVi' },
  { code: 'en',   labelKey: 'langEn' },
  { code: 'ja',   labelKey: 'langJa' },
  { code: 'ko',   labelKey: 'langKo' },
  { code: 'zh',   labelKey: 'langZh' },
];

export default function AutoTranscribe({ addToast }) {
  const { videoPath, setShowAutoPanel, setSubtitles, subtitleStyle, language: uiLang } = useStore();

  // Last choices are remembered across restarts (the API key is not stored)
  const [saved] = useState(() => loadPref('transcribeOptions', {
    transcribeMode: 'local', modelSize: 'small', subLang: 'auto', targetLang: 'none',
    engine: 'nllb', outputMode: 'translated', ollamaModel: '',
  }));
  const [transcribeMode, setTranscribeMode] = useState(saved.transcribeMode); // 'cloud' | 'local'
  const [apiKey,     setApiKey]     = useState('');
  const [modelSize,  setModelSize]  = useState(saved.modelSize);
  const [subLang,    setSubLang]    = useState(saved.subLang);
  const [targetLang, setTargetLang] = useState(saved.targetLang);
  const [engine,     setEngine]     = useState(saved.engine);     // 'nllb' | 'ollama'
  const [outputMode, setOutputMode] = useState(saved.outputMode); // 'translated' | 'bilingual'
  const [ollama,     setOllama]     = useState(null); // { installed, running, models } once checked
  const [ollamaModel, setOllamaModel] = useState(saved.ollamaModel);
  const [setupBusy,  setSetupBusy]  = useState(false); // Ollama install / start / pull in progress
  const [step,       setStep]       = useState('');
  const [progress,   setProgress]   = useState({ message: '', percent: 0 });
  const [running,    setRunning]    = useState(false);

  const translating = targetLang !== 'none';
  const totalSteps = translating ? 2 : 1;
  const ollamaReady = !!(ollama?.running && ollamaModel);
  const blocked = running || setupBusy;
  const canStart = !blocked && !(translating && engine === 'ollama' && !ollamaReady);

  // Subscribe to transcribe/translate progress events
  useEffect(() => {
    const unsub = window.electron.on('transcribe-progress', (data) => {
      setProgress({ message: data.message ?? '', percent: data.percent ?? 0 });
    });
    return unsub;
  }, []);

  // Check whether Ollama is installed / running and which models it has
  useEffect(() => {
    window.electron.ollamaStatus?.().then((res) => {
      if (!res) return;
      setOllama(res);
      // Keep the remembered model if it is still installed
      setOllamaModel((cur) => (res.models.includes(cur) ? cur : res.models[0] ?? ''));
    });
  }, []);

  useEffect(() => {
    savePref('transcribeOptions', { transcribeMode, modelSize, subLang, targetLang, engine, outputMode, ollamaModel });
  }, [transcribeMode, modelSize, subLang, targetLang, engine, outputMode, ollamaModel]);

  const handleStart = async () => {
    if (!videoPath) return;
    if (transcribeMode === 'cloud' && !apiKey.trim()) {
      addToast(t('needApiKey', uiLang), 'error');
      return;
    }

    setRunning(true);
    try {
      // Step 1: Extract audio + transcribe
      setStep(`${t('step', uiLang)} 1/${totalSteps} · ${t('stepTranscribe', uiLang)}`);
      setProgress({ message: t('extractingAudio', uiLang), percent: 2 });

      const audioResult = await window.electron.extractAudio(videoPath);
      if (!audioResult.success) throw new Error(audioResult.error);

      let result = transcribeMode === 'cloud'
        ? await window.electron.transcribeApi({ audioPath: audioResult.audioPath, apiKey: apiKey.trim(), language: subLang })
        : await window.electron.transcribeLocal({ audioPath: audioResult.audioPath, modelSize, language: subLang });
      if (!result.success) throw new Error(result.error);
      if (!result.subtitles.length) throw new Error(t('noSpeech', uiLang));

      // Generated lines use the font / style the user last set
      let subtitles = result.subtitles.map((s) => ({ ...s, ...subtitleStyle }));

      // Step 2: Translate
      if (translating) {
        setStep(`${t('step', uiLang)} 2/2 · ${t('stepTranslate', uiLang)}`);
        setProgress({ message: t('preparingTranslate', uiLang), percent: 0 });
        const translated = await window.electron.translateSubtitles({
          subtitles,
          sourceLang: result.language || subLang,
          targetLang,
          engine,
          ollamaModel,
          outputMode,
        });
        // A failed translation must not throw away a finished transcription
        if (translated.success) subtitles = translated.subtitles;
        else addToast(`${t('translateFailed', uiLang)} ${translated.error}`, 'error');
      }

      setSubtitles(subtitles);
      addToast(`${t('transcribeDone', uiLang)} ${subtitles.length}`, 'success');
      setShowAutoPanel(false);
    } catch (err) {
      addToast(`${t('error', uiLang)}: ${err.message}`, 'error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !blocked && setShowAutoPanel(false)}>
      <div className="modal at-modal" onClick={(e) => e.stopPropagation()} id="auto-transcribe-modal">

        <div className="at-header">
          <div>
            <div className="at-title">{t('transcribeTitle', uiLang)}</div>
            <div className="at-subtitle">{t('transcribeSubtitle', uiLang)}</div>
          </div>
          <button
            className="titlebar-btn"
            onClick={() => setShowAutoPanel(false)}
            disabled={blocked}
            aria-label={t('cancel', uiLang)}
          >
            ✕
          </button>
        </div>

        {/* Step 1 — speech recognition */}
        <section className="at-section">
          <div className="at-section-title"><span className="at-step-num">1</span>{t('stepTranscribe', uiLang)}</div>

          <div className="segmented-btn-group at-seg">
            <button
              className={`seg-btn${transcribeMode === 'local' ? ' active' : ''}`}
              id="tab-local"
              onClick={() => setTranscribeMode('local')}
              disabled={running}
            >
              {t('localMode', uiLang)}
            </button>
            <button
              className={`seg-btn${transcribeMode === 'cloud' ? ' active' : ''}`}
              id="tab-cloud"
              onClick={() => setTranscribeMode('cloud')}
              disabled={running}
            >
              {t('cloudMode', uiLang)}
            </button>
          </div>

          <div className="at-grid">
            {transcribeMode === 'local' ? (
              <label className="at-field">
                <span className="at-label">{t('modelSize', uiLang)}</span>
                <select
                  className="studio-select"
                  id="select-model"
                  value={modelSize}
                  onChange={(e) => setModelSize(e.target.value)}
                  disabled={running}
                >
                  {MODELS.map((m) => (
                    <option key={m} value={m}>{t(m, uiLang)}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="at-field">
                <span className="at-label">{t('apiKey', uiLang)}</span>
                <input
                  type="password"
                  className="studio-select"
                  id="input-api-key"
                  placeholder={t('enterApiKey', uiLang)}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  disabled={running}
                />
              </label>
            )}

            <label className="at-field">
              <span className="at-label">{t('sourceLanguage', uiLang)}</span>
              <select
                className="studio-select"
                id="select-lang"
                value={subLang}
                onChange={(e) => setSubLang(e.target.value)}
                disabled={running}
              >
                {SOURCE_LANGS.map((l) => (
                  <option key={l.code} value={l.code}>{t(l.labelKey, uiLang)}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="at-hint">
            {transcribeMode === 'local' ? t('localNote', uiLang) : t('cloudNote', uiLang)}
          </div>
        </section>

        {/* Step 2 — translation */}
        <section className="at-section">
          <div className="at-section-title"><span className="at-step-num">2</span>{t('stepTranslate', uiLang)}</div>

          <label className="at-field">
            <span className="at-label">{t('translateTo', uiLang)}</span>
            <select
              className="studio-select"
              id="select-target-lang"
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              disabled={blocked}
            >
              {TARGET_LANGS.map((l) => (
                <option key={l.code} value={l.code}>{t(l.labelKey, uiLang)}</option>
              ))}
            </select>
          </label>

          {translating && (
            <>
              <div className="at-grid">
                <div className="at-field">
                  <span className="at-label">{t('translateEngine', uiLang)}</span>
                  <div className="segmented-btn-group at-seg">
                    <button
                      className={`seg-btn${engine === 'nllb' ? ' active' : ''}`}
                      onClick={() => setEngine('nllb')}
                      disabled={blocked}
                    >
                      NLLB
                    </button>
                    <button
                      className={`seg-btn${engine === 'ollama' ? ' active' : ''}`}
                      onClick={() => setEngine('ollama')}
                      disabled={blocked}
                    >
                      Ollama LLM
                    </button>
                  </div>
                </div>

                <div className="at-field">
                  <span className="at-label">{t('outputMode', uiLang)}</span>
                  <div className="segmented-btn-group at-seg">
                    <button
                      className={`seg-btn${outputMode === 'translated' ? ' active' : ''}`}
                      onClick={() => setOutputMode('translated')}
                      disabled={running}
                    >
                      {t('translatedOnly', uiLang)}
                    </button>
                    <button
                      className={`seg-btn${outputMode === 'bilingual' ? ' active' : ''}`}
                      onClick={() => setOutputMode('bilingual')}
                      disabled={running}
                    >
                      {t('bilingual', uiLang)}
                    </button>
                  </div>
                </div>
              </div>

              <div className="at-hint">
                {engine === 'nllb'
                  ? t('nllbNote', uiLang)
                  : t('ollamaNote', uiLang)}
                {engine === 'nllb' && !ollamaReady && <> {t('ollamaHint', uiLang)}</>}
              </div>

              {engine === 'ollama' && (
                <OllamaSetup
                  uiLang={uiLang}
                  status={ollama}
                  setStatus={setOllama}
                  model={ollamaModel}
                  setModel={setOllamaModel}
                  disabled={running}
                  onBusyChange={setSetupBusy}
                />
              )}
            </>
          )}
        </section>

        {/* Progress */}
        {running && (
          <div className="at-progress">
            <div className="at-progress-step">{step}</div>
            <div className="at-progress-label">{progress.message}</div>
            <div className="tb-prog-outer at-progress-bar">
              <div className="tb-prog-inner" style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="at-footer">
          <button
            className="btn btn-ghost"
            id="btn-cancel-transcribe"
            onClick={() => setShowAutoPanel(false)}
            disabled={blocked}
          >
            {t('cancel', uiLang)}
          </button>
          <button
            className="btn btn-primary at-start"
            id="btn-start-transcribe"
            onClick={handleStart}
            disabled={!canStart}
          >
            {running
              ? '⏳ ' + t('processing', uiLang)
              : '🎙 ' + t(translating ? 'startTranscribeTranslate' : 'startTranscribe', uiLang)}
          </button>
        </div>
      </div>
    </div>
  );
}
