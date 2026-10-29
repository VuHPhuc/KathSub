// Model files shared by the Whisper, VAD and NLLB services, cached in ~/.kathsub/models/<repo>/<file>.

const path = require('path');
const fs = require('fs');
const os = require('os');

const CACHE_DIR = path.join(os.homedir(), '.kathsub', 'models');

// Stream model files to disk ourselves: Hugging Face serves big files without content-length and
// transformers.js then buffers the whole file (645 MB for the turbo encoder) in memory, which crashed the app.
async function ensureModelFiles(repo, files, onProgress) {
  for (const file of files) {
    const dest = path.join(CACHE_DIR, repo, file);
    if (fs.existsSync(dest)) continue;

    const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${file}`);
    if (!res.ok) throw new Error(`Không tải được ${repo}/${file} (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    let loaded = 0;
    let lastReport = 0;
    try {
      for await (const chunk of res.body) {
        loaded += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (Date.now() - lastReport > 300) {
          lastReport = Date.now();
          onProgress?.(file, loaded, total);
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    fs.renameSync(tmp, dest); // only complete files ever get the real name
  }
}

// "Đang tải model …: file (12 / 645 MB)" for progress messages
function downloadMessage(label, file, loaded, total) {
  const mb = (n) => (n / 1048576).toFixed(0);
  return `Đang tải ${label}: ${path.basename(file)} (${mb(loaded)}${total ? ` / ${mb(total)}` : ''} MB)`;
}

module.exports = { CACHE_DIR, ensureModelFiles, downloadMessage };
