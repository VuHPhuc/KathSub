// Translate service — turns transcribed subtitles into another language.
// Engines:
//   nllb   — Xenova/nllb-200-distilled-600M via @xenova/transformers (fully offline, built in)
//   ollama — any local LLM served by Ollama (translates by meaning, uses surrounding lines as context)

const OLLAMA_URL = 'http://127.0.0.1:11434';
const NLLB_MODEL = 'Xenova/nllb-200-distilled-600M';

// Whisper/UI language code → NLLB code
const NLLB_CODES = {
  vi: 'vie_Latn',
  en: 'eng_Latn',
  ja: 'jpn_Jpan',
  ko: 'kor_Hang',
  zh: 'zho_Hans',
};

const LANG_NAMES = {
  vi: 'Vietnamese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese (Simplified)',
};

let nllbPipeline = null; // cached translation pipeline

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Guess the spoken language from the transcribed text (used when Whisper ran with "auto")
function detectLang(texts) {
  const sample = texts.join(' ');
  if (/[぀-ヿ]/.test(sample)) return 'ja'; // Hiragana / Katakana
  if (/[가-힯]/.test(sample)) return 'ko'; // Hangul
  if (/[一-鿿]/.test(sample)) return 'zh'; // Han only
  if (/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(sample)) return 'vi';
  return 'en';
}

function mergeText(original, translated, outputMode) {
  return outputMode === 'bilingual' ? `${original}\n${translated}` : translated;
}

// ─── NLLB (offline, built in) ────────────────────────────────────────────────

async function translateWithNllb(texts, srcLang, tgtLang, onProgress) {
  if (!nllbPipeline) {
    const { pipeline, env } = await import('@xenova/transformers');
    env.cacheDir = require('path').join(require('os').homedir(), '.kathsub', 'models');
    env.allowRemoteModels = true;

    onProgress?.({ status: 'loading', message: 'Đang tải model dịch NLLB (lần đầu ~900 MB)...', percent: 0 });
    nllbPipeline = await pipeline('translation', NLLB_MODEL, {
      progress_callback: (p) => {
        if (p.status === 'downloading' || p.status === 'progress') {
          const pct = Math.round(p.progress ?? ((p.loaded / p.total) * 100)) || 0;
          onProgress?.({ status: 'downloading', message: `Đang tải model dịch: ${p.file} (${pct}%)`, percent: 0 });
        }
      },
    });
  }

  const results = [];
  for (let i = 0; i < texts.length; i++) {
    const out = await nllbPipeline(texts[i], {
      src_lang: NLLB_CODES[srcLang],
      tgt_lang: NLLB_CODES[tgtLang],
    });
    results.push((out?.[0]?.translation_text ?? '').trim());
    onProgress?.({ status: 'translating', done: i + 1, total: texts.length });
  }
  return results;
}

// ─── Ollama (local LLM) ──────────────────────────────────────────────────────

async function listOllamaModels() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { available: false, models: [] };
    const data = await res.json();
    return { available: true, models: (data.models || []).map((m) => m.name) };
  } catch (_) {
    // Ollama not installed or not running — the UI simply hides this engine
    return { available: false, models: [] };
  }
}

// Constrained output per line: id, the source copied back, and the translation.
// - Separate "source"/"translation" fields: with one shared "text" field small models return the source untranslated.
// - Echoing the source lets us detect a translation that slid onto the wrong line and redo that line alone.
const OLLAMA_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, source: { type: 'string' }, translation: { type: 'string' } },
        required: ['id', 'source', 'translation'],
      },
    },
  },
  required: ['lines'],
};

const sameText = (a, b) => String(a ?? '').replace(/\s+/g, '') === String(b ?? '').replace(/\s+/g, '');

async function ollamaChat(model, system, user) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      // Thinking models (Qwen3) otherwise spend thousands of tokens reasoning per batch: 90 s instead of 7 s
      think: false,
      format: OLLAMA_SCHEMA,
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama lỗi ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.message?.content || '{}');
}

const OLLAMA_BATCH = 10;
const OLLAMA_CONTEXT = 3;

async function translateWithOllama(texts, srcLang, tgtLang, model, onProgress) {
  const system =
    `You are a professional subtitle translator. Translate ${LANG_NAMES[srcLang]} subtitles into natural, fluent ${LANG_NAMES[tgtLang]}. ` +
    'Translate the meaning, not word by word; a sentence may be split across several lines, so read neighbouring lines. ' +
    'Keep each line short enough for a subtitle. Never merge, split, skip or reorder lines. ' +
    `For every input line output its id, its source copied exactly, and its ${LANG_NAMES[tgtLang]} "translation". ` +
    'Never copy the source text into "translation".';

  const ask = (lines, context = []) =>
    ollamaChat(
      model,
      system,
      (context.length ? `Previous lines for context only (do not translate):\n${context.join('\n')}\n\n` : '') +
        JSON.stringify({ lines: lines.map(({ id, text }) => ({ id, source: text })) }),
    );

  const results = new Array(texts.length).fill('');
  for (let start = 0; start < texts.length; start += OLLAMA_BATCH) {
    const end = Math.min(start + OLLAMA_BATCH, texts.length);
    const lines = texts.slice(start, end).map((text, i) => ({ id: start + i, text }));

    // Report at the start of each batch too, so the dialog never sits on "preparing" while the model works
    onProgress?.({ status: 'translating', done: start, total: texts.length, batchEnd: end });

    // A failed batch (e.g. Ollama 500 "token repeat limit reached") falls through to per-line retries below
    let reply = {};
    try {
      reply = await ask(lines, texts.slice(Math.max(0, start - OLLAMA_CONTEXT), start));
    } catch (err) {
      console.warn('[Translate] Ollama batch failed, retrying line by line:', err.message);
    }
    const byId = new Map((reply.lines || []).map((l) => [Number(l.id), l]));

    for (const { id, text } of lines) {
      // Dropped line or a translation attached to the wrong source → redo that line alone so timing stays aligned
      const got = byId.get(id);
      let translated = got && sameText(got.source, text) ? String(got.translation ?? '').trim() : '';
      if (!translated) {
        try {
          const single = await ask([{ id, text }]);
          translated = String(single.lines?.[0]?.translation ?? '').trim();
        } catch (err) {
          // One untranslatable line must not discard the whole transcription; keep the source text
          console.warn(`[Translate] Ollama failed on line ${id}, keeping source:`, err.message);
        }
        translated = translated || text;
      }
      results[id] = translated;
    }
    onProgress?.({ status: 'translating', done: end, total: texts.length });
  }
  return results;
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function translateSubtitles({ subtitles, sourceLang, targetLang, engine, ollamaModel, outputMode }, onProgress) {
  try {
    const texts = subtitles.map((s) => s.text);
    const src = sourceLang && sourceLang !== 'auto' ? sourceLang : detectLang(texts);

    if (src === targetLang) {
      return { success: true, subtitles, skipped: true };
    }
    if (!NLLB_CODES[src] || !NLLB_CODES[targetLang]) {
      throw new Error(`Chưa hỗ trợ dịch ${src} → ${targetLang}`);
    }

    const report = (p) => {
      if (p.status !== 'translating') return onProgress?.(p);
      onProgress?.({
        status: 'translating',
        message: p.batchEnd
          ? `Đang dịch dòng ${p.done + 1}–${p.batchEnd} / ${p.total}...`
          : `Đã dịch ${p.done}/${p.total} dòng`,
        percent: Math.round((p.done / p.total) * 100),
      });
    };

    let translated;
    if (engine === 'ollama') {
      if (!ollamaModel) throw new Error('Chưa chọn model Ollama');
      translated = await translateWithOllama(texts, src, targetLang, ollamaModel, report);
    } else {
      translated = await translateWithNllb(texts, src, targetLang, report);
    }

    return {
      success: true,
      subtitles: subtitles.map((s, i) => ({ ...s, text: mergeText(s.text, translated[i] || s.text, outputMode) })),
    };
  } catch (err) {
    nllbPipeline = null;
    return { success: false, error: err.message };
  }
}

module.exports = { translateSubtitles, listOllamaModels, detectLang };
