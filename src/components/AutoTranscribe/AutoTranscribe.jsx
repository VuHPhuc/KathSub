import React, { useState, useEffect, useRef, useCallback } from 'react';
import useStore, { DEFAULT_BOX_WIDTH, BOX_WIDTH_MIN } from '../../store/subtitleStore';
import { t, errorMessage } from '../../locales';
import OllamaSetup from './OllamaSetup';
import ModelCache from './ModelCache';
import { loadPref, savePref } from '../../utils/prefs';

const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'anime-ja'];
// Models that only transcribe one language (electron/services/whisper.js MODEL_OPTIONS)
const MODEL_LANG = { 'anime-ja': 'ja' };
const SOURCE_LANGS = [
  { code: 'auto', labelKey: 'langAuto' },
  { code: 'ja',   labelKey: 'langJa' },
  { code: 'ko',   labelKey: 'langKo' },
  { code: 'zh',   labelKey: 'langZh' },
  { code: 'en',   labelKey: 'langEn' },
  { code: 'vi',   labelKey: 'langVi' },
  { code: 'es',   labelKey: 'langEs' },
  { code: 'fr',   labelKey: 'langFr' },
  { code: 'de',   labelKey: 'langDe' },
  { code: 'pt',   labelKey: 'langPt' },
  { code: 'ru',   labelKey: 'langRu' },
  { code: 'th',   labelKey: 'langTh' },
  { code: 'id',   labelKey: 'langId' },
];
const TARGET_LANGS = [
  { code: 'none', labelKey: 'noTranslate' },
  { code: 'vi',   labelKey: 'langVi' },
  { code: 'en',   labelKey: 'langEn' },
  { code: 'ja',   labelKey: 'langJa' },
  { code: 'ko',   labelKey: 'langKo' },
  { code: 'zh',   labelKey: 'langZh' },
  { code: 'es',   labelKey: 'langEs' },
  { code: 'fr',   labelKey: 'langFr' },
  { code: 'de',   labelKey: 'langDe' },
  { code: 'pt',   labelKey: 'langPt' },
  { code: 'ru',   labelKey: 'langRu' },
  { code: 'th',   labelKey: 'langTh' },
  { code: 'id',   labelKey: 'langId' },
];

// Where the burned-in subtitles sit (electron/services/ocr.js REGIONS)
const OCR_REGIONS = ['bottom', 'bottomHalf', 'middle', 'top', 'full'];
// Suggested Ollama model for reading subtitles (small, reads Japanese / Chinese / Korean text well)
const VISION_MODEL = 'qwen2.5vl:3b';

// Video genres the Ollama prompt knows (electron/services/translate.js GENRE_RULES)
const GENRES = ['general', 'gaming', 'anime', 'adult', 'meme'];

export default function AutoTranscribe({ addToast }) {
  const { videoPath, setShowAutoPanel, setSubtitles, subtitleStyle, language: uiLang, subtitles: currentSubs } = useStore();

  // Last choices are remembered across restarts (the API key is not stored)
  const [saved] = useState(() => loadPref('transcribeOptions', {
    transcribeMode: 'local', modelSize: 'large-v3-turbo', subLang: 'auto', targetLang: 'none',
    engine: 'nllb', outputMode: 'translated', ollamaModel: '', includeVocals: false, review: true,
  }));
  // 'transcribe': recognise speech in the video (then optionally translate) · 'translate': translate the timeline's subtitles
  const [jobMode,    setJobMode]    = useState(saved.jobMode ?? 'transcribe');
  const [existingSrcLang, setExistingSrcLang] = useState(saved.existingSrcLang ?? 'ja'); // no Whisper detection here
  const [transcribeMode, setTranscribeMode] = useState(saved.transcribeMode); // 'local' | 'cloud' | 'ocr'
  const [ocrLang,    setOcrLang]    = useState(saved.ocrLang ?? 'en');        // OCR cannot detect the language
  const [ocrRegion,  setOcrRegion]  = useState(saved.ocrRegion ?? 'bottom');
  const [ocrEngine,  setOcrEngine]  = useState(saved.ocrEngine ?? 'tesseract'); // 'tesseract' | 'ollama'
  const [ocrModel,   setOcrModel]   = useState(saved.ocrModel ?? '');          // Ollama vision model
  const [visionModels, setVisionModels] = useState([]);
  const [visionPull, setVisionPull] = useState(null); // { message, percent } while a vision model downloads
  const [apiKey,     setApiKey]     = useState('');
  const [modelSize,  setModelSize]  = useState(saved.modelSize);
  const [subLang,    setSubLang]    = useState(saved.subLang);
  const [targetLang, setTargetLang] = useState(saved.targetLang);
  const [engine,     setEngine]     = useState(saved.engine);     // 'nllb' | 'ollama'
  const [outputMode, setOutputMode] = useState(saved.outputMode); // 'translated' | 'bilingual'
  const [ollama,     setOllama]     = useState(null); // { installed, running, models } once checked
  const [ollamaModel, setOllamaModel] = useState(saved.ollamaModel);
  const [includeVocals, setIncludeVocals] = useState(saved.includeVocals);
  const [review,     setReview]     = useState(saved.review);
  const [genre,      setGenre]      = useState(saved.genre ?? 'general'); // steers Ollama's slang / jargon
  const [setupBusy,  setSetupBusy]  = useState(false); // Ollama install / start / pull in progress
  const [cacheBusy,  setCacheBusy]  = useState(false); // a model is being deleted from the cache
  const [step,       setStep]       = useState('');
  const [progress,   setProgress]   = useState({ message: '', percent: 0 });
  const [running,    setRunning]    = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Read between steps: a cancel that lands between two IPC calls must stop the next one from starting
  const cancelRef = useRef(false);

  const translateExisting = jobMode === 'translate';
  const ocrMode = transcribeMode === 'ocr';
  // A single-language model fixes the spoken language (the user's own choice is kept for the other models)
  const localLang = transcribeMode === 'local' ? MODEL_LANG[modelSize] : undefined;
  const translating = targetLang !== 'none';
  const totalSteps = translating ? 2 : 1;
  const ollamaReady = !!(ollama?.running && ollamaModel);
  const blocked = running || setupBusy || cacheBusy;
  const textLines = currentSubs.filter((s) => s.text && s.text.trim()).length;
  // Why "translate existing" cannot start (shown under the form), or '' when it can
  const existingBlocker = !translateExisting ? ''
    : textLines === 0 ? t('translateExistingEmpty', uiLang)
      : !translating ? t('translateChooseTarget', uiLang)
        : existingSrcLang === targetLang ? t('translateSameLang', uiLang)
          : '';
  const ocrModelReady = !!(ollama?.running && visionModels.includes(ocrModel));
  const canStart = !blocked && !existingBlocker && !(translating && engine === 'ollama' && !ollamaReady)
    && !(!translateExisting && ocrMode && ocrEngine === 'ollama' && !ocrModelReady);

  // Subscribe to transcribe/translate progress events
  useEffect(() => {
    const unsub = window.electron.on('transcribe-progress', (data) => {
      setProgress({ message: data.message ?? '', percent: data.percent ?? 0 });
    });
    return unsub;
  }, []);

  // Check whether Ollama is installed / running and which models it has (again after a model is deleted)
  const refreshOllama = useCallback(() => {
    window.electron.ollamaStatus?.().then((res) => {
      if (!res) return;
      setOllama(res);
      // Keep the remembered model if it is still installed
      setOllamaModel((cur) => (res.models.includes(cur) ? cur : res.models[0] ?? ''));
    });
    // Models that can read text in pictures (OCR with Ollama)
    window.electron.ocrVisionModels?.().then((models) => {
      if (!Array.isArray(models)) return;
      setVisionModels(models);
      setOcrModel((cur) => (models.includes(cur) ? cur : models[0] ?? ''));
    });
  }, []);
  useEffect(() => refreshOllama(), [refreshOllama]);

  useEffect(() => {
    savePref('transcribeOptions', { jobMode, existingSrcLang, transcribeMode, ocrLang, ocrRegion, ocrEngine, ocrModel, modelSize, subLang, targetLang, engine, outputMode, ollamaModel, includeVocals, review, genre });
  }, [jobMode, existingSrcLang, transcribeMode, ocrLang, ocrRegion, ocrEngine, ocrModel, modelSize, subLang, targetLang, engine, outputMode, ollamaModel, includeVocals, review, genre]);

  // Download the recommended vision model for OCR (progress comes on the Ollama setup channel)
  useEffect(() => {
    if (!visionPull) return undefined;
    return window.electron.on('ollama-setup-progress', (p) => setVisionPull({ message: p.message ?? '', percent: p.percent ?? 0 }));
  }, [!!visionPull]); // eslint-disable-line react-hooks/exhaustive-deps
  const handlePullVision = async () => {
    setVisionPull({ message: '', percent: 0 });
    setSetupBusy(true);
    try {
      const res = await window.electron.ollamaPull(VISION_MODEL);
      if (!res.success) addToast(`${t('error', uiLang)}: ${errorMessage(res, uiLang)}`, 'error');
      else setOcrModel(VISION_MODEL);
    } finally {
      setVisionPull(null);
      setSetupBusy(false);
      refreshOllama();
    }
  };

  // Throws a `cancelled` error when the user pressed Cancel or the step reports it was cancelled
  const checkCancelled = (res) => {
    if (cancelRef.current || res?.cancelled) throw Object.assign(new Error(t('jobCancelled', uiLang)), { cancelled: true });
  };

  // While a job runs: stop it (the dialog stays open so it can be started again). Otherwise: close the dialog.
  const handleCancel = () => {
    if (!running) {
      setShowAutoPanel(false);
      return;
    }
    if (cancelRef.current) return; // second click while cancelling
    cancelRef.current = true;
    setCancelling(true);
    window.electron.cancelJob?.().catch((err) => console.warn('cancelJob failed:', err));
  };

  // Shared by both modes: running/cancel state, and "Cancelled" vs a real error
  const runJob = async (work) => {
    cancelRef.current = false; // a cancel from an earlier run never carries over
    setCancelling(false);
    setRunning(true);
    try {
      await work();
    } catch (err) {
      if (err.cancelled) addToast(t('jobCancelled', uiLang), 'info');
      else addToast(`${t('error', uiLang)}: ${err.message}`, 'error');
    } finally {
      cancelRef.current = false;
      setCancelling(false);
      setRunning(false);
    }
  };

  // Translate the subtitles already on the timeline: only their text changes, timing and style stay
  const handleTranslateExisting = () => runJob(async () => {
    const source = useStore.getState().subtitles
      .filter((s) => s.text && s.text.trim())
      .map((s) => ({ id: s.id, startTime: s.startTime, endTime: s.endTime, text: s.text, sourceText: s.sourceText }));
    if (!source.length) throw new Error(t('translateExistingEmpty', uiLang));

    setStep(t('stepTranslateExisting', uiLang));
    setProgress({ message: t('preparingTranslate', uiLang), percent: 0 });
    const res = await window.electron.translateSubtitles({
      subtitles: source,
      sourceLang: existingSrcLang,
      targetLang,
      engine,
      ollamaModel,
      outputMode,
      review,
      genre,
    });
    checkCancelled(res);
    if (!res.success) throw new Error(errorMessage(res, uiLang));

    // The service falls back to the source text for a line it could not translate (e.g. Ollama failing
    // throughout) and still reports success; only lines whose translation differs from the source count.
    // Bilingual output is "<source>\n<translation>", so an untranslated line ends with "\n<original>".
    const original = new Map(source.map((s) => [s.id, s.text]));
    const translatedLine = (s) => {
      const orig = original.get(s.id);
      if (typeof s.text !== 'string' || s.text === orig) return false;
      return !(outputMode === 'bilingual' && s.text.endsWith(`\n${orig}`));
    };
    const changed = new Map(res.subtitles.filter(translatedLine).map((s) => [s.id, { text: s.text, sourceText: s.sourceText }]));
    if (changed.size === 0) throw new Error(t('translateNothing', uiLang)); // timeline left as it was

    // Untranslated lines keep their text (no "original\noriginal" in bilingual mode)
    useStore.getState().patchSubtitles(changed);
    if (changed.size < source.length) {
      addToast(t('translatePartial', uiLang).replace('{done}', () => changed.size).replace('{total}', () => source.length), 'warning');
    } else {
      addToast(`${t('translateExistingDone', uiLang)} ${changed.size}`, 'success');
    }
    setShowAutoPanel(false);
  });

  const handleStart = async () => {
    if (translateExisting) return handleTranslateExisting();
    if (!videoPath) return;
    if (transcribeMode === 'cloud' && !apiKey.trim()) {
      addToast(t('needApiKey', uiLang), 'error');
      return;
    }

    await runJob(async () => {
      // Step 1: read the burned-in subtitles, or extract audio + transcribe
      setStep(`${t('step', uiLang)} 1/${totalSteps} · ${t(ocrMode ? 'stepOcr' : 'stepTranscribe', uiLang)}`);
      let result;
      if (ocrMode) {
        setProgress({ message: t('preparingOcr', uiLang), percent: 0 });
        result = await window.electron.ocrVideo({ videoPath, language: ocrLang, region: ocrRegion, engine: ocrEngine, ollamaModel: ocrModel });
        checkCancelled(result);
        if (!result.success) throw new Error(errorMessage(result, uiLang));
        if (!result.subtitles.length) throw new Error(t('noOcrText', uiLang));
      } else {
        setProgress({ message: t('extractingAudio', uiLang), percent: 2 });
        const audioResult = await window.electron.extractAudio(videoPath);
        checkCancelled(audioResult);
        if (!audioResult.success) throw new Error(errorMessage(audioResult, uiLang));

        result = transcribeMode === 'cloud'
          ? await window.electron.transcribeApi({ audioPath: audioResult.audioPath, apiKey: apiKey.trim(), language: subLang })
          : await window.electron.transcribeLocal({ audioPath: audioResult.audioPath, modelSize, language: subLang, includeVocals });
        checkCancelled(result);
        if (!result.success) throw new Error(errorMessage(result, uiLang));
        if (!result.subtitles.length) throw new Error(t('noSpeech', uiLang));
      }

      // Generated lines use the font / style the user last set. Read-off-the-picture lines keep the place the
      // original was in (left, right, top...), narrowed so a line near the edge stays inside the video.
      let subtitles = result.subtitles.map((s) => (ocrMode
        ? {
          ...s,
          ...subtitleStyle,
          x: s.x,
          y: s.y,
          boxWidth: Math.max(BOX_WIDTH_MIN, Math.min(subtitleStyle.boxWidth ?? DEFAULT_BOX_WIDTH, 2 * Math.min(s.x, 100 - s.x))),
        }
        : { ...s, ...subtitleStyle }));

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
          review,
          genre,
        });
        // Cancel means cancel: nothing from this run is written to the timeline
        checkCancelled(translated);
        // A failed translation must not throw away a finished transcription
        if (translated.success) subtitles = translated.subtitles;
        else addToast(`${t('translateFailed', uiLang)} ${errorMessage(translated, uiLang)}`, 'error');
      }

      setSubtitles(subtitles);
      addToast(`${t('transcribeDone', uiLang)} ${subtitles.length}`, 'success');
      setShowAutoPanel(false);
    });
  };

  return (
    <div className="modal-overlay" onClick={() => !blocked && setShowAutoPanel(false)}>
      <div className="modal at-modal" onClick={(e) => e.stopPropagation()} id="auto-transcribe-modal">

        <div className="at-header">
          <div>
            <div className="at-title">{t(translateExisting ? 'translateExistingTitle' : 'transcribeTitle', uiLang)}</div>
            <div className="at-subtitle">{t(translateExisting ? 'translateExistingSubtitle' : 'transcribeSubtitle', uiLang)}</div>
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

        {/* What to do: recognise speech in the video, or translate the subtitles already on the timeline */}
        <div className="segmented-btn-group at-seg at-job-mode">
          <button
            className={`seg-btn${!translateExisting ? ' active' : ''}`}
            id="tab-job-transcribe"
            onClick={() => setJobMode('transcribe')}
            disabled={blocked}
          >
            🎙 {t('jobModeTranscribe', uiLang)}
          </button>
          <button
            className={`seg-btn${translateExisting ? ' active' : ''}`}
            id="tab-job-translate"
            onClick={() => setJobMode('translate')}
            disabled={blocked}
          >
            🌐 {t('jobModeTranslate', uiLang)}
          </button>
        </div>

        {/* Step 1 — speech recognition */}
        {!translateExisting && (
        <section className="at-section">
          <div className="at-section-title"><span className="at-step-num">1</span>{t(ocrMode ? 'stepOcr' : 'stepTranscribe', uiLang)}</div>

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
            <button
              className={`seg-btn${ocrMode ? ' active' : ''}`}
              id="tab-ocr"
              onClick={() => setTranscribeMode('ocr')}
              disabled={running}
            >
              {t('ocrMode', uiLang)}
            </button>
          </div>

          {ocrMode ? (
            <div className="at-grid">
              <label className="at-field">
                <span className="at-label">{t('subtitleLanguage', uiLang)}</span>
                <select
                  className="studio-select"
                  id="select-ocr-lang"
                  value={ocrLang}
                  onChange={(e) => setOcrLang(e.target.value)}
                  disabled={running}
                >
                  {SOURCE_LANGS.filter((l) => l.code !== 'auto').map((l) => (
                    <option key={l.code} value={l.code}>{t(l.labelKey, uiLang)}</option>
                  ))}
                </select>
              </label>
              <label className="at-field">
                <span className="at-label">{t('ocrRegion', uiLang)}</span>
                <select
                  className="studio-select"
                  id="select-ocr-region"
                  value={ocrRegion}
                  onChange={(e) => setOcrRegion(e.target.value)}
                  disabled={running}
                >
                  {OCR_REGIONS.map((r) => (
                    <option key={r} value={r}>{t(`ocrRegion_${r}`, uiLang)}</option>
                  ))}
                </select>
              </label>
              <div className="at-field">
                <span className="at-label">{t('ocrEngine', uiLang)}</span>
                <div className="segmented-btn-group at-seg">
                  <button
                    className={`seg-btn${ocrEngine === 'tesseract' ? ' active' : ''}`}
                    id="tab-ocr-tesseract"
                    onClick={() => setOcrEngine('tesseract')}
                    disabled={blocked}
                  >
                    Tesseract
                  </button>
                  <button
                    className={`seg-btn${ocrEngine === 'ollama' ? ' active' : ''}`}
                    id="tab-ocr-ollama"
                    onClick={() => setOcrEngine('ollama')}
                    disabled={blocked}
                  >
                    Ollama AI
                  </button>
                </div>
              </div>
              {ocrEngine === 'ollama' && visionModels.length > 0 && (
                <label className="at-field">
                  <span className="at-label">{t('ocrModel', uiLang)}</span>
                  <select
                    className="studio-select"
                    id="select-ocr-model"
                    value={ocrModel}
                    onChange={(e) => setOcrModel(e.target.value)}
                    disabled={blocked}
                  >
                    {visionModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
              )}
            </div>
          ) : (
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
                value={localLang ?? subLang}
                onChange={(e) => setSubLang(e.target.value)}
                disabled={running || !!localLang}
              >
                {SOURCE_LANGS.map((l) => (
                  <option key={l.code} value={l.code}>{t(l.labelKey, uiLang)}</option>
                ))}
              </select>
            </label>
          </div>
          )}

          {transcribeMode === 'local' && (
            <div className="switch-row at-switch">
              <span className="at-label">{t('includeVocals', uiLang)}</span>
              <label className="studio-switch">
                <input
                  type="checkbox"
                  id="toggle-vocals"
                  checked={includeVocals}
                  onChange={(e) => setIncludeVocals(e.target.checked)}
                  disabled={running}
                />
                <span className="switch-slider" />
              </label>
            </div>
          )}

          <div className="at-hint">
            {localLang && <>{t('animeModelNote', uiLang)} </>}
            {ocrMode ? t('ocrNote', uiLang) : transcribeMode === 'local' ? t('localNote', uiLang) : t('cloudNote', uiLang)}
            {ocrMode && <> {t(ocrEngine === 'ollama' ? 'ocrOllamaNote' : 'ocrTesseractNote', uiLang)}</>}
          </div>

          {/* Ollama OCR needs Ollama running and a model that can see pictures */}
          {ocrMode && ocrEngine === 'ollama' && !ocrModelReady && (
            <div className="at-error">
              {!ollama?.running
                ? t('ocrOllamaNotRunning', uiLang)
                : visionPull
                  ? (visionPull.message || t('processing', uiLang))
                  : t('ocrNoVisionModel', uiLang).replace('{model}', () => VISION_MODEL)}
              {ollama?.running && !visionPull && (
                <button className="btn btn-primary at-inline-btn" id="btn-pull-vision" onClick={handlePullVision} disabled={blocked}>
                  ⬇ {t('ollamaPull', uiLang)} {VISION_MODEL}
                </button>
              )}
              {visionPull && (
                <div className="tb-prog-outer at-progress-bar">
                  <div className="tb-prog-inner" style={{ width: `${visionPull.percent}%` }} />
                </div>
              )}
            </div>
          )}
        </section>
        )}

        {/* Step 2 — translation (the only step when translating the timeline's subtitles) */}
        <section className="at-section">
          <div className="at-section-title">
            {!translateExisting && <span className="at-step-num">2</span>}
            {t(translateExisting ? 'stepTranslateExisting' : 'stepTranslate', uiLang)}
          </div>

          {translateExisting ? (
            <>
              <div className="at-hint">
                {textLines > 0
                  ? `${t('translateExistingCount', uiLang)} ${textLines}`
                  : t('translateExistingEmpty', uiLang)}
              </div>
              <div className="at-grid">
                <label className="at-field">
                  <span className="at-label">{t('subtitleLanguage', uiLang)}</span>
                  <select
                    className="studio-select"
                    id="select-existing-src-lang"
                    value={existingSrcLang}
                    onChange={(e) => setExistingSrcLang(e.target.value)}
                    disabled={blocked}
                  >
                    {SOURCE_LANGS.filter((l) => l.code !== 'auto').map((l) => (
                      <option key={l.code} value={l.code}>{t(l.labelKey, uiLang)}</option>
                    ))}
                  </select>
                </label>
                <label className="at-field">
                  <span className="at-label">{t('translateTo', uiLang)}</span>
                  <select
                    className="studio-select"
                    id="select-target-lang"
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    disabled={blocked}
                  >
                    {!translating && <option value="none" disabled>{t('chooseLanguage', uiLang)}</option>}
                    {TARGET_LANGS.filter((l) => l.code !== 'none').map((l) => (
                      <option key={l.code} value={l.code}>{t(l.labelKey, uiLang)}</option>
                    ))}
                  </select>
                </label>
              </div>
              {existingBlocker && textLines > 0 && <div className="at-error">{existingBlocker}</div>}
            </>
          ) : (
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
          )}

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
                <label className="at-field">
                  <span className="at-label">{t('videoGenre', uiLang)}</span>
                  <select
                    className="studio-select"
                    id="select-genre"
                    value={genre}
                    onChange={(e) => setGenre(e.target.value)}
                    disabled={running}
                    title={t('videoGenreHint', uiLang)}
                  >
                    {GENRES.map((g) => (
                      <option key={g} value={g}>{t(`genre_${g}`, uiLang)}</option>
                    ))}
                  </select>
                </label>
              )}

              {engine === 'ollama' && (
                <div className="switch-row at-switch">
                  <span className="at-label">{t('reviewTranslation', uiLang)}</span>
                  <label className="studio-switch">
                    <input
                      type="checkbox"
                      id="toggle-review"
                      checked={review}
                      onChange={(e) => setReview(e.target.checked)}
                      disabled={running}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
              )}

              {engine === 'ollama' && (
                <OllamaSetup
                  uiLang={uiLang}
                  status={ollama}
                  setStatus={setOllama}
                  model={ollamaModel}
                  setModel={setOllamaModel}
                  // Locked while a cache delete runs: the installer is written into ~/.kathsub/downloads
                  disabled={running || cacheBusy}
                  onBusyChange={setSetupBusy}
                />
              )}
            </>
          )}
        </section>

        {/* Downloaded models: size and delete (locked while a job runs) */}
        <ModelCache
          uiLang={uiLang}
          disabled={running || setupBusy}
          addToast={addToast}
          onBusyChange={setCacheBusy}
          onOllamaChanged={refreshOllama}
        />

        {/* Progress */}
        {running && (
          <div className="at-progress">
            <div className="at-progress-step">{step}</div>
            <div className="at-progress-label">{cancelling ? t('cancelling', uiLang) : progress.message}</div>
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
            onClick={handleCancel}
            // Running: stops the job. Ollama setup downloads keep their own cancel button.
            disabled={running ? cancelling : setupBusy || cacheBusy}
          >
            {cancelling ? t('cancelling', uiLang) : t('cancel', uiLang)}
          </button>
          <button
            className="btn btn-primary at-start"
            id="btn-start-transcribe"
            onClick={handleStart}
            disabled={!canStart}
          >
            {running
              ? '⏳ ' + t('processing', uiLang)
              : translateExisting
                ? '🌐 ' + t('startTranslateExisting', uiLang)
                : ocrMode
                  ? '🔤 ' + t(translating ? 'startOcrTranslate' : 'startOcr', uiLang)
                  : '🎙 ' + t(translating ? 'startTranscribeTranslate' : 'startTranscribe', uiLang)}
          </button>
        </div>
      </div>
    </div>
  );
}
