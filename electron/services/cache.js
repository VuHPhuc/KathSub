// Model cache manager: how much disk the downloaded models take (~/.kathsub/models, ~/.kathsub/downloads)
// and deleting them by group. The renderer only ever sends a group key; every path is built here and
// checked to stay inside CACHE_DIR / DOWNLOAD_DIR before anything is removed.
// Ollama keeps its own models; they are listed and deleted through its HTTP API.

const fs = require('fs');
const path = require('path');
const { CACHE_DIR } = require('./models');

// Lazy: these services load heavy modules, and main.js may have failed to load one of them
const whisper = () => require('./whisper');
const translate = () => require('./translate');
const ollama = () => require('./ollama');

// Resolve `rel` under `base`; throws when the result is `base` itself or escapes it (.., absolute, UNC,
// other drive). A real name that only starts with dots ("..cache") is inside and allowed (REV-05).
function insidePath(base, rel) {
  const root = path.resolve(base);
  const target = path.resolve(root, rel);
  const r = path.relative(root, target);
  if (!r || r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) {
    throw Object.assign(new Error(`Path outside the cache folder: ${rel}`), { code: 'outsideCache' });
  }
  return target;
}

// Groups in display order. `entries` lists what deleting the group removes, relative to `base`.
function knownGroups() {
  const { MODEL_REPOS, VAD_REPO } = whisper();
  const { NLLB_MODEL } = translate();
  return [
    ...Object.entries(MODEL_REPOS).map(([size, repo]) => ({ key: `whisper:${size}`, type: 'whisper', name: size, base: CACHE_DIR, entries: [repo] })),
    { key: 'vad', type: 'vad', name: 'Silero VAD', base: CACHE_DIR, entries: [VAD_REPO] },
    { key: 'nllb', type: 'nllb', name: 'NLLB-200 600M', base: CACHE_DIR, entries: [NLLB_MODEL] },
  ];
}

async function readDirSafe(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Whatever else sits in CACHE_DIR (models fetched by an older version, stray files): <owner>/<repo> folders
// that are not a known group, plus loose files
async function otherEntries(known) {
  const knownRepos = new Set(known.filter((g) => g.base === CACHE_DIR).flatMap((g) => g.entries.map((e) => path.normalize(e))));
  const out = [];
  for (const top of await readDirSafe(CACHE_DIR)) {
    if (!top.isDirectory()) {
      out.push(top.name);
      continue;
    }
    let children;
    try {
      children = await readDirSafe(path.join(CACHE_DIR, top.name));
    } catch (err) {
      // Unreadable owner folder: list it as a whole rather than failing the cache table
      console.warn(`[Cache] Cannot list ${top.name}:`, err.message);
      if (!knownRepos.has(path.normalize(top.name))) out.push(top.name);
      continue;
    }
    for (const child of children) {
      const rel = path.join(top.name, child.name);
      if (!knownRepos.has(path.normalize(rel))) out.push(rel);
    }
  }
  return out;
}

async function downloadEntries() {
  return (await readDirSafe(ollama().DOWNLOAD_DIR)).map((d) => d.name);
}

// Bytes under a path; symlinks are not followed
async function sizeOf(p) {
  let st;
  try {
    st = await fs.promises.lstat(p);
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const d of await readDirSafe(p)) total += await sizeOf(path.join(p, d.name));
  return total;
}

async function allGroups() {
  const known = knownGroups();
  return [
    ...known,
    { key: 'other', type: 'other', base: CACHE_DIR, entries: await otherEntries(known) },
    { key: 'downloads', type: 'downloads', base: ollama().DOWNLOAD_DIR, entries: await downloadEntries() },
  ];
}

async function getCacheInfo() {
  const groups = [];
  for (const g of await allGroups()) {
    let size = 0;
    let unreadable = 0;
    // One odd entry (no permission, locked, rejected name) is skipped, not fatal for the whole table
    for (const e of g.entries) {
      try {
        size += await sizeOf(insidePath(g.base, e));
      } catch (err) {
        unreadable++;
        console.warn(`[Cache] Skipped ${e}:`, err.message);
      }
    }
    groups.push({ key: g.key, type: g.type, name: g.name ?? '', size, unreadable });
  }
  return { success: true, groups, cacheDir: CACHE_DIR, downloadDir: ollama().DOWNLOAD_DIR };
}

// Cached pipelines point at files that are about to disappear: dispose them so the next run reloads
async function resetPipelines(types) {
  if (types.has('whisper') || types.has('vad') || types.has('other')) await whisper().resetModels();
  if (types.has('nllb') || types.has('other')) await translate().resetModels();
}

// key: a group key from getCacheInfo, or 'all'
async function deleteCacheGroup(key) {
  const groups = await allGroups();
  const chosen = key === 'all' ? groups : groups.filter((g) => g.key === key);
  if (!chosen.length) return { success: false, code: 'invalidKey', error: `Invalid cache group: ${key}` };

  // Every target is validated before anything is touched; one that fails is reported, never deleted
  const errors = [];
  const targets = [];
  for (const g of chosen) {
    for (const e of g.entries) {
      try {
        targets.push(insidePath(g.base, e));
      } catch (err) {
        errors.push(`${e}: ${err.message}`);
      }
    }
  }
  await resetPipelines(new Set(chosen.map((g) => g.type)));

  for (const target of targets) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 2 });
    } catch (err) {
      errors.push(`${path.basename(target)}: ${err.message}`);
    }
  }
  // Leave no empty <owner> folders behind (e.g. "Xenova" after its last model is gone)
  for (const top of await readDirSafe(CACHE_DIR)) {
    if (!top.isDirectory()) continue;
    const dir = insidePath(CACHE_DIR, top.name);
    if (!(await readDirSafe(dir)).length) await fs.promises.rmdir(dir).catch(() => {});
  }
  return errors.length ? { success: false, code: 'deleteFailed', detail: errors.join('; '), error: errors.join('; ') } : { success: true };
}

// ─── Ollama models ───────────────────────────────────────────────────────────

async function ollamaRequest(pathname, init = {}) {
  return fetch(`${translate().OLLAMA_URL}${pathname}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 5000) });
}

// → { running: false } when Ollama is not installed / not running (not an error for the UI)
async function listOllamaModels() {
  try {
    const res = await ollamaRequest('/api/tags', { timeoutMs: 2000 });
    if (!res.ok) return { running: false };
    const data = await res.json();
    return { running: true, models: (data.models || []).map((m) => ({ name: m.name, size: Number(m.size) || 0 })) };
  } catch (_) {
    return { running: false };
  }
}

// Only a model Ollama itself lists can be deleted. API: DELETE /api/delete {"model": "<name>"}
async function deleteOllamaModel(name) {
  try {
    const list = await listOllamaModels();
    if (!list.running) return { success: false, code: 'ollamaNotRunning', error: 'Ollama is not running' };
    if (typeof name !== 'string' || !list.models.some((m) => m.name === name)) {
      return { success: false, code: 'ollamaUnknownModel', detail: String(name), error: `No Ollama model named "${name}"` };
    }
    const res = await ollamaRequest('/api/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
      timeoutMs: 30000,
    });
    if (!res.ok) {
      const detail = `HTTP ${res.status}: ${await res.text()}`;
      return { success: false, code: 'ollamaError', detail, error: `Ollama ${detail}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { getCacheInfo, deleteCacheGroup, listOllamaModels, deleteOllamaModel, insidePath };
