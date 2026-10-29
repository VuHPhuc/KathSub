import React, { useEffect, useState } from 'react';
import useStore from '../../store/subtitleStore';
import { t } from '../../locales';

// Card shown when the main process finds a newer release:
// available → downloading (progress) → downloaded (restart to install). Portable builds only get a download link.
export default function UpdateNotice() {
  const { language } = useStore();
  const [status, setStatus] = useState(null); // { state, version, percent, canInstall, message }
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    return window.electron?.on('update-status', (s) => {
      setStatus((prev) => ({ ...prev, ...s }));
      // A finished download is worth showing again even if the user said "later" before
      if (s.state === 'downloaded' || s.state === 'error') setHidden(false);
    });
  }, []);

  if (!status || hidden) return null;
  const { state, version, percent = 0, canInstall, message } = status;

  const download = async () => {
    if (!canInstall) {
      window.electron.updateOpenPage();
      setHidden(true);
      return;
    }
    const res = await window.electron.updateDownload();
    if (!res?.success) setStatus((s) => ({ ...s, state: 'error', message: res?.error }));
  };

  return (
    <div className="update-notice" id="update-notice" role="status">
      {state === 'available' && (
        <>
          <div className="update-title">{t('updateAvailable', language)} v{version}</div>
          <div className="update-text">{t(canInstall ? 'updateAsk' : 'updateAskPortable', language)}</div>
          <div className="update-actions">
            <button className="btn btn-secondary" onClick={() => setHidden(true)}>{t('updateLater', language)}</button>
            <button className="btn btn-primary" id="btn-update-now" onClick={download}>
              {t(canInstall ? 'updateNow' : 'updateOpenPage', language)}
            </button>
          </div>
        </>
      )}

      {state === 'downloading' && (
        <>
          <div className="update-title">{t('updateDownloading', language)} v{version} · {percent}%</div>
          <div className="update-bar"><div className="update-bar-fill" style={{ width: `${percent}%` }} /></div>
          <div className="update-actions">
            <button className="btn btn-secondary" onClick={() => setHidden(true)}>{t('updateHide', language)}</button>
          </div>
        </>
      )}

      {state === 'downloaded' && (
        <>
          <div className="update-title">{t('updateReady', language)} v{version}</div>
          <div className="update-text">{t('updateReadyText', language)}</div>
          <div className="update-actions">
            <button className="btn btn-secondary" onClick={() => setHidden(true)}>{t('updateOnQuit', language)}</button>
            <button className="btn btn-primary" id="btn-update-install" onClick={() => window.electron.updateInstall()}>
              {t('updateRestart', language)}
            </button>
          </div>
        </>
      )}

      {state === 'error' && (
        <>
          <div className="update-title">{t('updateFailed', language)}</div>
          <div className="update-text">{message}</div>
          <div className="update-actions">
            <button className="btn btn-secondary" onClick={() => setHidden(true)}>{t('updateHide', language)}</button>
            <button className="btn btn-primary" onClick={() => window.electron.updateOpenPage()}>
              {t('updateOpenPage', language)}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
