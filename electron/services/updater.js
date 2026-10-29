// Update service — tells the renderer when a newer GitHub release exists and installs it in-app.
// Installed (NSIS) builds download and install through electron-updater, which reads latest.yml
// from the release. The portable exe cannot replace itself, so it only gets a link to the release.

const { app, shell } = require('electron');

const OWNER = 'VuHPhuc';
const REPO = 'KathSub';
const RELEASE_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;

// electron-builder's portable target sets this; the running exe there is a temp extraction
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
const canInstall = app.isPackaged && !isPortable;

let autoUpdater = null;
let send = () => {};
let userStartedDownload = false;

// "1.10.0" > "1.9.2"; pre-release suffixes are ignored
function isNewer(latest, current) {
  const a = String(latest).replace(/^v/, '').split(/[.-]/).map(Number);
  const b = String(current).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function init(sendToRenderer) {
  send = sendToRenderer;
  if (!canInstall) return;

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('[Updater] electron-updater not available:', err.message);
    return;
  }

  // Ask first: downloading ~160 MB without asking would be rude on a metered connection
  autoUpdater.autoDownload = false;
  // A downloaded update the user postponed still installs when they quit the app
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    send({ state: 'available', version: info.version, canInstall: true });
  });
  autoUpdater.on('download-progress', (p) => {
    send({ state: 'downloading', percent: Math.round(p.percent || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    send({ state: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    console.error('[Updater]', err?.message);
    // A failed background check (offline, GitHub down) is not worth bothering the user about
    if (userStartedDownload) send({ state: 'error', message: err?.message || String(err) });
    userStartedDownload = false;
  });
}

async function checkForUpdates() {
  if (!app.isPackaged) return; // dev runs have no release to compare against

  if (autoUpdater) {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      console.error('[Updater] Check failed:', err.message);
    }
    return;
  }

  // Portable: compare with the latest GitHub release and offer the download page
  try {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const rel = await res.json();
    if (isNewer(rel.tag_name, app.getVersion())) {
      send({ state: 'available', version: rel.tag_name.replace(/^v/, ''), canInstall: false });
    }
  } catch (err) {
    console.error('[Updater] Check failed:', err.message);
  }
}

async function downloadUpdate() {
  if (!autoUpdater) {
    openReleasePage();
    return { success: true };
  }
  userStartedDownload = true;
  send({ state: 'downloading', percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function installUpdate() {
  // Silent reinstall into the same folder, then relaunch the new version
  setImmediate(() => autoUpdater?.quitAndInstall(true, true));
}

// Never open a URL handed over by the renderer; always the project's own release page
function openReleasePage() {
  shell.openExternal(RELEASE_PAGE);
}

module.exports = { init, checkForUpdates, downloadUpdate, installUpdate, openReleasePage, isNewer };
