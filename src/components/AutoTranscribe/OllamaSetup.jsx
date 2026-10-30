import React, { useState, useEffect, useRef } from 'react';
import { t, errorMessage } from '../../locales';

const RECOMMENDED_MODELS = [
  { name: 'qwen3:4b',   labelKey: 'ollamaModelSmall' },
  { name: 'qwen3:8b',   labelKey: 'ollamaModelMedium' },
  { name: 'gemma3:12b', labelKey: 'ollamaModelLarge' },
];

const INSTALL_POLL_MS = 3000;

// Install Ollama, start it and pull a model without leaving the transcribe dialog.
// `status` ({ installed, running, models } | null) is owned by the parent so it can gate the start button.
export default function OllamaSetup({ uiLang, status, setStatus, model, setModel, disabled, onBusyChange }) {
  const [busy,     setBusy]     = useState(null); // 'install' | 'waitInstall' | 'start' | 'pull' | null
  const [progress, setProgress] = useState({ percent: 0, message: '' });
  const [error,    setError]    = useState('');
  const [pullName, setPullName] = useState(RECOMMENDED_MODELS[1].name);

  // Waiting for the installer window does not lock the dialog; downloads do
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => onBusyChange?.(!!busy && busy !== 'waitInstall'), [busy, onBusyChange]);

  // Never leave a download running with no UI to show or cancel it
  useEffect(() => () => {
    if (busyRef.current === 'install' || busyRef.current === 'pull') window.electron.ollamaCancel();
    onBusyChange?.(false);
  }, [onBusyChange]);

  useEffect(() => {
    const unsub = window.electron.on('ollama-setup-progress', (p) => {
      setProgress({ percent: p.percent ?? 0, message: p.message ?? '' });
    });
    return unsub;
  }, []);

  // While the Ollama installer window is open, wait for its server to come up
  useEffect(() => {
    if (busy !== 'waitInstall') return undefined;
    const timer = setInterval(async () => {
      const s = await window.electron.ollamaStatus();
      if (s.running) {
        setStatus(s);
        setBusy(null);
      }
    }, INSTALL_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, setStatus]);

  // Keep the selected model valid
  useEffect(() => {
    if (status?.models.length && !status.models.includes(model)) setModel(status.models[0]);
    const firstMissing = RECOMMENDED_MODELS.find((m) => !status?.models.includes(m.name));
    if (firstMissing && status?.models.includes(pullName)) setPullName(firstMissing.name);
  }, [status, model, setModel, pullName]);

  const run = async (kind, action) => {
    setError('');
    setBusy(kind);
    setProgress({ percent: 0, message: '' });
    const res = await action();
    if (!res.success) setError(errorMessage(res, uiLang));
    setBusy(null);
    return res;
  };

  const handleInstall = async () => {
    const res = await run('install', () => window.electron.ollamaInstall());
    if (res.success) setBusy('waitInstall');
  };

  const handleStart = async () => {
    const res = await run('start', () => window.electron.ollamaStart());
    if (res.success) setStatus(res);
  };

  const handlePull = async () => {
    const res = await run('pull', () => window.electron.ollamaPull(pullName));
    if (res.success) {
      setStatus(res);
      setModel(pullName);
    }
  };

  const canCancel = busy === 'install' || busy === 'pull';
  const missingModels = RECOMMENDED_MODELS.filter((m) => !status?.models.includes(m.name));

  const progressBlock = busy && (
    <div className="at-progress">
      <div className="at-progress-label">
        {busy === 'waitInstall' ? t('ollamaWaitInstall', uiLang) : progress.message || t('processing', uiLang)}
      </div>
      {busy !== 'waitInstall' && busy !== 'start' && (
        <div className="tb-prog-outer at-progress-bar">
          <div className="tb-prog-inner" style={{ width: `${progress.percent}%` }} />
        </div>
      )}
      {canCancel && (
        <button className="btn btn-ghost at-inline-btn" onClick={() => window.electron.ollamaCancel()}>
          {t('cancel', uiLang)}
        </button>
      )}
      {busy === 'waitInstall' && (
        <button className="btn btn-ghost at-inline-btn" onClick={() => setBusy(null)}>
          {t('ollamaStopWaiting', uiLang)}
        </button>
      )}
    </div>
  );

  let body;
  if (!status) {
    body = <div className="at-hint">{t('ollamaChecking', uiLang)}</div>;
  } else if (!status.installed) {
    body = (
      <>
        <div className="at-setup-title">{t('ollamaNotInstalled', uiLang)}</div>
        <div className="at-hint">{t('ollamaInstallNote', uiLang)}</div>
        {!busy && (
          <button className="btn btn-primary at-inline-btn" id="btn-ollama-install" onClick={handleInstall} disabled={disabled}>
            ⬇ {t('ollamaInstall', uiLang)}
          </button>
        )}
      </>
    );
  } else if (!status.running) {
    body = (
      <>
        <div className="at-setup-title">{t('ollamaNotRunning', uiLang)}</div>
        {!busy && (
          <button className="btn btn-primary at-inline-btn" id="btn-ollama-start" onClick={handleStart} disabled={disabled}>
            ▶ {t('ollamaStart', uiLang)}
          </button>
        )}
      </>
    );
  } else {
    body = (
      <>
        {status.models.length > 0 ? (
          <label className="at-field">
            <span className="at-label">{t('ollamaModel', uiLang)}</span>
            <select
              className="studio-select"
              id="select-ollama-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={disabled || !!busy}
            >
              {status.models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
        ) : (
          <div className="at-setup-title">{t('ollamaNoModel', uiLang)}</div>
        )}

        {missingModels.length > 0 && !busy && (
          <div className="at-field">
            <span className="at-label">
              {status.models.length ? t('ollamaPullMore', uiLang) : t('ollamaPullFirst', uiLang)}
            </span>
            <div className="at-inline-row">
              <select
                className="studio-select"
                id="select-ollama-pull"
                value={pullName}
                onChange={(e) => setPullName(e.target.value)}
                disabled={disabled}
              >
                {missingModels.map((m) => (
                  <option key={m.name} value={m.name}>{t(m.labelKey, uiLang)}</option>
                ))}
              </select>
              <button
                className={`btn ${status.models.length ? 'btn-secondary' : 'btn-primary'} at-inline-btn`}
                id="btn-ollama-pull"
                onClick={handlePull}
                disabled={disabled}
              >
                ⬇ {t('ollamaPull', uiLang)}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="at-setup">
      {body}
      {progressBlock}
      {error && <div className="at-error">{error}</div>}
    </div>
  );
}
