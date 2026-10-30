import React, { useState, useEffect, useCallback } from 'react';
import { t, errorMessage } from '../../locales';

// Disk used by downloaded models, with delete per group / all. Collapsed until opened so the dialog
// does not scan the disk every time it opens. Paths never leave the main process: only group keys
// ('whisper:small', 'nllb', 'downloads', 'all') and Ollama model names are sent.

function formatSize(bytes, lang) {
  const units = [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]];
  const [unit, div] = units.find(([, d]) => bytes >= d) ?? ['B', 1];
  const value = (bytes / div).toFixed(unit === 'GB' ? 2 : unit === 'B' ? 0 : 1);
  return `${lang === 'vi' ? value.replace('.', ',') : value} ${unit}`;
}

function groupLabel(g, lang) {
  if (g.type === 'whisper') return `Whisper ${g.name}`;
  if (g.type === 'vad') return t('cacheVad', lang);
  if (g.type === 'nllb') return t('cacheNllb', lang);
  if (g.type === 'downloads') return t('cacheDownloads', lang);
  return t('cacheOther', lang);
}

export default function ModelCache({ uiLang, disabled, addToast, onBusyChange, onOllamaChanged }) {
  const [open,       setOpen]       = useState(false);
  const [info,       setInfo]       = useState(null);  // model-cache-info result
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');
  const [confirmKey, setConfirmKey] = useState(null);  // row waiting for "delete?" confirmation
  const [busyKey,    setBusyKey]    = useState(null);  // row being deleted

  useEffect(() => onBusyChange?.(!!busyKey), [busyKey, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await window.electron.modelCacheInfo();
      if (!res?.success) throw new Error(errorMessage(res, uiLang) || 'unknown error');
      setInfo(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // On opening, and again when a job starts or ends (its first run may have downloaded a model)
  useEffect(() => {
    if (open) load();
  }, [open, disabled, load]);

  const remove = async (key, run, label) => {
    setConfirmKey(null);
    setBusyKey(key);
    try {
      const res = await run();
      if (res?.success) addToast(`${t('cacheDeleted', uiLang)} ${label}`, 'success');
      else addToast(`${t('cacheDeleteFailed', uiLang)} ${errorMessage(res, uiLang)}`, 'error');
    } catch (err) {
      addToast(`${t('cacheDeleteFailed', uiLang)} ${err.message}`, 'error');
    } finally {
      setBusyKey(null);
      await load();
    }
  };

  const deleteGroup = (key, label) => remove(key, () => window.electron.modelCacheDelete(key), label);
  const deleteOllama = async (name) => {
    await remove(`ollama:${name}`, () => window.electron.ollamaDeleteModel(name), name);
    onOllamaChanged?.();
  };

  const locked = disabled || !!busyKey || loading;
  const groups = (info?.groups ?? []).filter((g) => g.size > 0);
  const total = groups.reduce((n, g) => n + g.size, 0);

  // Delete button, which turns into "Delete? Yes / No" on first click
  const deleteControl = (key, onConfirm, label = t('delete', uiLang)) => {
    if (busyKey === key) return <span className="mc-status">{t('cacheDeleting', uiLang)}</span>;
    if (confirmKey === key) {
      return (
        <span className="mc-confirm">
          <span className="mc-status">{t('cacheConfirm', uiLang)}</span>
          <button className="btn btn-danger mc-btn" onClick={onConfirm} disabled={locked}>{t('cacheYes', uiLang)}</button>
          <button className="btn btn-ghost mc-btn" onClick={() => setConfirmKey(null)}>{t('cacheNo', uiLang)}</button>
        </span>
      );
    }
    return (
      <button className="btn btn-ghost mc-btn" onClick={() => setConfirmKey(key)} disabled={locked}>
        {label}
      </button>
    );
  };

  let body = null;
  if (open) {
    if (loading && !info) body = <div className="at-hint">{t('cacheLoading', uiLang)}</div>;
    else if (error) {
      body = (
        <div className="mc-row">
          <span className="at-error">{t('cacheLoadFailed', uiLang)} {error}</span>
          <button className="btn btn-ghost mc-btn" onClick={load} disabled={loading}>{t('retry', uiLang)}</button>
        </div>
      );
    } else if (info) {
      body = (
        <>
          {disabled && <div className="at-hint">{t('cacheLockedWhileRunning', uiLang)}</div>}
          {groups.length === 0 ? (
            <div className="at-hint">{t('cacheEmpty', uiLang)}</div>
          ) : (
            <>
              {groups.map((g) => (
                <div className="mc-row" key={g.key}>
                  <span className="mc-name">{groupLabel(g, uiLang)}</span>
                  <span className="mc-size">{formatSize(g.size, uiLang)}</span>
                  {deleteControl(g.key, () => deleteGroup(g.key, groupLabel(g, uiLang)))}
                </div>
              ))}
              <div className="mc-row mc-total">
                <span className="mc-name">{t('cacheTotal', uiLang)}</span>
                <span className="mc-size">{formatSize(total, uiLang)}</span>
                {deleteControl('all', () => deleteGroup('all', t('cacheAll', uiLang)), t('cacheDeleteAll', uiLang))}
              </div>
            </>
          )}
          {info.groups.some((g) => g.unreadable) && <div className="at-hint">{t('cacheUnreadable', uiLang)}</div>}
          <div className="at-hint mc-path">{info.cacheDir}</div>

          <div className="at-setup-title mc-subtitle">{t('cacheOllamaTitle', uiLang)}</div>
          {!info.ollama?.running ? (
            <div className="at-hint">{t('cacheOllamaNotRunning', uiLang)}</div>
          ) : info.ollama.models.length === 0 ? (
            <div className="at-hint">{t('cacheOllamaEmpty', uiLang)}</div>
          ) : (
            info.ollama.models.map((m) => (
              <div className="mc-row" key={m.name}>
                <span className="mc-name">{m.name}</span>
                <span className="mc-size">{formatSize(m.size, uiLang)}</span>
                {deleteControl(`ollama:${m.name}`, () => deleteOllama(m.name))}
              </div>
            ))
          )}
          <div className="at-hint">{t('cacheOllamaNote', uiLang)}</div>
        </>
      );
    }
  }

  return (
    <section className="at-section mc-section">
      <button
        className="mc-toggle"
        id="btn-model-cache"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{open ? '▾' : '▸'} {t('cacheTitle', uiLang)}</span>
        {open && info && !loading && <span className="mc-size">{formatSize(total, uiLang)}</span>}
        {open && loading && <span className="mc-status">{t('cacheLoading', uiLang)}</span>}
      </button>
      {body}
    </section>
  );
}
