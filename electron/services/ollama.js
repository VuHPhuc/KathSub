// Ollama setup service — lets users install Ollama, start it and pull a model from inside KathSub.
// The installer is the official Windows build; it is downloaded, its Authenticode signature is
// checked, then its normal setup window is opened so the user installs it themselves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { listOllamaModels } = require('./translate');

const OLLAMA_URL = 'http://127.0.0.1:11434';
const INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';
const DOWNLOAD_DIR = path.join(os.homedir(), '.kathsub', 'downloads');

let activeDownload = null; // AbortController of the running installer download / model pull

// ─── Status ──────────────────────────────────────────────────────────────────

function findOllamaExe() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function getStatus() {
  const { available, models } = await listOllamaModels();
  return {
    running: available,
    installed: available || !!findOllamaExe(),
    models,
  };
}

// ─── Install ─────────────────────────────────────────────────────────────────

async function downloadFile(url, dest, onProgress) {
  activeDownload = new AbortController();
  const tmp = `${dest}.part`;
  try {
    const res = await fetch(url, { signal: activeDownload.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`Tải thất bại (HTTP ${res.status})`);

    const total = Number(res.headers.get('content-length')) || 0;
    let loaded = 0;
    let lastReport = 0;
    const out = fs.createWriteStream(tmp);
    try {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        loaded += chunk.length;
        if (Date.now() - lastReport > 250) {
          lastReport = Date.now();
          onProgress?.({ loaded, total });
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (total && loaded !== total) throw new Error('File tải về không đầy đủ, hãy thử lại');

    fs.renameSync(tmp, dest);
    onProgress?.({ loaded, total: total || loaded });
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err.name === 'AbortError' ? new Error('Đã hủy tải') : err;
  } finally {
    activeDownload = null;
  }
}

// Only run an installer that is validly signed by Ollama
function checkSignature(filePath) {
  return new Promise((resolve) => {
    const script =
      `$s = Get-AuthenticodeSignature -LiteralPath '${filePath.replace(/'/g, "''")}'; ` +
      `@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, reason: err.message });
      try {
        const { status, subject } = JSON.parse(stdout.trim());
        const ok = status === 'Valid' && /\bOllama\b/i.test(subject);
        resolve({ ok, reason: ok ? '' : `chữ ký: ${status || 'không có'}${subject ? ` (${subject})` : ''}` });
      } catch (e) {
        resolve({ ok: false, reason: e.message });
      }
    });
  });
}

async function installOllama(onProgress, { installerUrl = INSTALLER_URL } = {}) {
  try {
    if (process.platform !== 'win32') throw new Error('Tự cài Ollama hiện chỉ hỗ trợ Windows');
    if (activeDownload) throw new Error('Đang có một lượt tải khác');

    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const dest = path.join(DOWNLOAD_DIR, 'OllamaSetup.exe');
    fs.rmSync(dest, { force: true });

    await downloadFile(installerUrl, dest, ({ loaded, total }) => {
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      onProgress?.({
        stage: 'downloading',
        percent: pct,
        message: `Đang tải bộ cài Ollama: ${(loaded / 1e6).toFixed(0)}${total ? ` / ${(total / 1e6).toFixed(0)}` : ''} MB`,
      });
    });

    onProgress?.({ stage: 'verifying', percent: 100, message: 'Đang kiểm tra chữ ký số của bộ cài...' });
    const sig = await checkSignature(dest);
    if (!sig.ok) {
      fs.rmSync(dest, { force: true });
      throw new Error(`Bộ cài không có chữ ký hợp lệ của Ollama (${sig.reason}). Hãy tải trực tiếp tại ollama.com`);
    }

    // Open the normal setup window; delete the installer once it closes
    const child = spawn(dest, [], { detached: true, stdio: 'ignore' });
    child.on('exit', () => fs.rm(dest, { force: true }, () => {}));
    child.on('error', () => fs.rm(dest, { force: true }, () => {}));
    child.unref();

    onProgress?.({ stage: 'installing', percent: 100, message: 'Trình cài đặt Ollama đã mở — bấm Install để cài' });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Start / pull ────────────────────────────────────────────────────────────

async function startOllama() {
  try {
    const exe = findOllamaExe();
    if (!exe) throw new Error('Không tìm thấy ollama.exe');

    const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const status = await getStatus();
      if (status.running) return { success: true, ...status };
    }
    throw new Error('Ollama không khởi động được');
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function pullModel(model, onProgress) {
  try {
    if (activeDownload) throw new Error('Đang có một lượt tải khác');
    activeDownload = new AbortController();

    const res = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: activeDownload.signal,
    });
    if (!res.ok) throw new Error(`Ollama lỗi ${res.status}: ${await res.text()}`);

    // Response is NDJSON: {"status":"pulling <digest>","total":N,"completed":M} ... {"status":"success"}
    const decoder = new TextDecoder();
    let buffer = '';
    let lastStatus = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        lastStatus = msg.status;
        const pct = msg.total ? Math.round(((msg.completed || 0) / msg.total) * 100) : 0;
        onProgress?.({
          stage: 'pulling',
          percent: pct,
          message: msg.total
            ? `Đang tải model ${model}: ${((msg.completed || 0) / 1e9).toFixed(2)} / ${(msg.total / 1e9).toFixed(2)} GB`
            : `Model ${model}: ${msg.status}`,
        });
      }
    }
    if (lastStatus !== 'success') throw new Error('Tải model bị gián đoạn');
    return { success: true, ...(await getStatus()) };
  } catch (err) {
    return { success: false, error: err.name === 'AbortError' ? 'Đã hủy tải' : err.message };
  } finally {
    activeDownload = null;
  }
}

function cancelDownload() {
  activeDownload?.abort();
}

// The model-cache manager must not delete DOWNLOAD_DIR while the installer is being written there
const isDownloading = () => !!activeDownload;

module.exports = { getStatus, installOllama, startOllama, pullModel, cancelDownload, checkSignature, isDownloading, DOWNLOAD_DIR };
