// Translate service — turns transcribed subtitles into another language.
// Engines:
//   nllb   — Xenova/nllb-200-distilled-600M via @huggingface/transformers (fully offline, built in)
//   ollama — any local LLM served by Ollama (reads the whole transcript first, translates with context)

const { CACHE_DIR, ensureModelFiles, downloadMessage } = require('./models');

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

// Whisper can detect ~100 languages; an LLM can translate any of them
function langName(code) {
  if (LANG_NAMES[code]) return LANG_NAMES[code];
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch (_) {
    return code;
  }
}

const NLLB_FILES = [
  'config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
];

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
    onProgress?.({ status: 'loading', message: 'Đang chuẩn bị model dịch NLLB (lần đầu ~900 MB)...', percent: 0 });
    await ensureModelFiles(NLLB_MODEL, NLLB_FILES, (file, loaded, total) => {
      onProgress?.({
        status: 'downloading',
        message: downloadMessage('model dịch NLLB', file, loaded, total),
        percent: total ? Math.round((loaded / total) * 100) : 0,
      });
    });

    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = CACHE_DIR;
    env.allowRemoteModels = true; // small optional files not in NLLB_FILES
    nllbPipeline = await pipeline('translation', NLLB_MODEL, { dtype: 'q8' });
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

// ─── Ollama: context-aware translation ───────────────────────────────────────
// 1. One pass over the whole transcript writes a translator's brief: what happens, who the
//    characters are (gender, who talks to whom), recurring names/terms and the tone.
// 2. Lines are translated in small batches; each sees the brief, the previous lines with their
//    final translations (consistent names, pronouns, tone) and the next lines (Whisper often
//    splits one sentence over two lines).
// 3. The model also proofreads each recognised line against that context (お橋 → お箸).

const OLLAMA_BATCH = 8;
const PREV_LINES = 6;
const NEXT_LINES = 3;
const BRIEF_MAX_LINES = 400;

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, gender: { type: 'string' }, notes: { type: 'string' } },
        required: ['name', 'gender', 'notes'],
      },
    },
    glossary: {
      type: 'array',
      items: {
        type: 'object',
        properties: { term: { type: 'string' }, translation: { type: 'string' } },
        required: ['term', 'translation'],
      },
    },
    tone: { type: 'string' },
  },
  required: ['summary', 'characters', 'glossary', 'tone'],
};

// Per line the proofread source and its translation. The proofread source doubles as an alignment
// check: when it no longer resembles the line with that id, the model has slid onto another line.
const LINES_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, corrected_source: { type: 'string' }, translation: { type: 'string' } },
        required: ['id', 'corrected_source', 'translation'],
      },
    },
  },
  required: ['lines'],
};

// Vietnamese pronouns carry the relationship; a wrong or drifting pair reads badly
const TARGET_RULES = {
  vi: '- Vietnamese: choose pronouns from the relationship, age and tone (tớ/cậu, anh/em, tao/mày, mình/bạn, chị/em...) and keep the same pair for the same two characters throughout. Third person must match the gender in the brief (anh ấy/ổng for a man, cô ấy/nhỏ/bả for a woman).',
};

async function ollamaChat(model, system, user, schema, numCtx = 8192) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      // Thinking models (Qwen3) otherwise spend thousands of tokens reasoning per batch: 90 s instead of 7 s
      think: false,
      format: schema,
      options: { temperature: 0.1, num_ctx: numCtx },
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

// 0..1, ignoring spaces and punctuation
function similarity(a, b) {
  const clean = (s) => [...String(s ?? '').replace(/[\s\p{P}]/gu, '')];
  const x = clean(a);
  const y = clean(b);
  if (!x.length && !y.length) return 1;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

// Small models sometimes leak JSON punctuation into the text ("Tuyệt vời! {")
const cleanLine = (t) => String(t ?? '').replace(/^[\s{}[\]]+|[\s{}[\]]+$/g, '');

// Japanese/Chinese/Korean characters left in an English or Vietnamese line mean it was not translated
function looksUntranslated(translation, source, tgtLang) {
  if (!translation.trim()) return true;
  if (similarity(translation, source) > 0.9) return true;
  return ['en', 'vi'].includes(tgtLang) && /[぀-ヿ一-鿿가-힯]/.test(translation);
}

async function buildBrief(texts, srcName, tgtName, model) {
  const system =
    `You prepare a translator's brief for ${srcName} subtitles that will be translated into ${tgtName}. ` +
    'The transcript comes from speech recognition, has no speaker labels and may contain mis-heard words. ' +
    'Read all of it and report in English: a 2-4 sentence summary of what happens; every named character who speaks or is mentioned ' +
    '(name as written in the source, gender if it can be inferred from name, honorific or speech style, and notes on their role, how they speak and who they talk to); ' +
    `recurring names and terms with the ${tgtName} rendering to use consistently; and the register and tone (casual, polite, rough, intimate...). ` +
    'A name at the start of a line usually addresses the listener rather than naming the speaker. Do not invent names for unnamed speakers; ' +
    'describe them in the notes of the people they talk to. Never translate or localise personal names: romanise them (Hepburn for Japanese).';
  const transcript = texts.slice(0, BRIEF_MAX_LINES).map((t, i) => `${i}: ${t}`).join('\n');
  try {
    return await ollamaChat(model, system, transcript, BRIEF_SCHEMA, 16384);
  } catch (err) {
    // The brief only improves quality; translate without it rather than fail
    console.warn('[Translate] Could not build translator brief:', err.message);
    return null;
  }
}

function briefText(brief) {
  if (!brief) return '(none)';
  const chars = (brief.characters || []).map((c) => `- ${c.name} (${c.gender}): ${c.notes}`).join('\n');
  const terms = (brief.glossary || []).map((g) => `- ${g.term} → ${g.translation}`).join('\n');
  return `Summary: ${brief.summary}\nCharacters:\n${chars || '- (unknown)'}\nTerms:\n${terms || '- (none)'}\nTone: ${brief.tone}`;
}

async function translateWithOllama(texts, srcLang, tgtLang, model, onProgress, { review = false } = {}) {
  const srcName = langName(srcLang);
  const tgtName = langName(tgtLang);

  onProgress?.({ status: 'analyzing', message: 'Đang đọc toàn bộ lời thoại để nắm ngữ cảnh...', percent: 0 });
  const brief = await buildBrief(texts, srcName, tgtName, model);

  const system = [
    `You are an expert subtitle translator from ${srcName} into ${tgtName}.`,
    '',
    "Translator's brief:",
    briefText(brief),
    '',
    'Rules:',
    `- Translate each line's own content into that line's "translation". Never move words to a neighbouring line, never merge lines, never leave a line empty. A sentence may continue on the next line: translate this line's part so the lines read naturally in sequence.`,
    '- Be faithful: keep every piece of meaning (who does what to whom, numbers, names, negation, questions). Do not add explanations.',
    '- A line can hold two short utterances, often from different speakers, separated by a space: translate every one of them.',
    '- Render idioms and set phrases by what they mean in this situation, not word for word. Read slang and euphemisms with the meaning they have in the scene the brief describes, not their dictionary meaning.',
    '- Use the brief and the previous translations to resolve omitted subjects, who is speaking to whom, pronouns and gender, and keep names and terms consistent.',
    `- Write natural spoken ${tgtName} that fits the speaker's tone, short enough for a subtitle.`,
    `- Interjections, laughter, moans, gasps and screams become a short natural ${tgtName} interjection, never a description.`,
    '- "corrected_source": the source line with obvious speech-recognition mistakes fixed using the context (a wrong kanji for a homophone, a misheard name). If nothing is wrong copy it unchanged. Never rephrase it.',
    TARGET_RULES[tgtLang] ?? '',
  ].join('\n');

  const translations = new Array(texts.length).fill('');
  const sources = [...texts];

  const ask = (ids, start, end) =>
    ollamaChat(
      model,
      system,
      'Translate "lines". "previous" (with their final translations) and "next" are context only.\n' +
        JSON.stringify({
          previous: texts.slice(Math.max(0, start - PREV_LINES), start).map((source, k) => ({
            source,
            translation: translations[Math.max(0, start - PREV_LINES) + k],
          })),
          lines: ids.map((id) => ({ id, source: texts[id] })),
          next: texts.slice(end, end + NEXT_LINES),
        }),
      LINES_SCHEMA,
    );

  // Accept a reply line only if it belongs to this id and is really translated
  const fallback = new Map(); // aligned but suspicious translation, still better than the source
  const accept = (id, got) => {
    if (!got || similarity(got.corrected_source, texts[id]) < 0.5) return false;
    const translation = cleanLine(got.translation);
    if (looksUntranslated(translation, texts[id], tgtLang)) {
      if (translation) fallback.set(id, translation);
      return false;
    }
    translations[id] = translation;
    // Keep the proofread source only when it is a fix, not a rewrite
    if (similarity(got.corrected_source, texts[id]) >= 0.6) sources[id] = String(got.corrected_source).trim();
    return true;
  };

  for (let start = 0; start < texts.length; start += OLLAMA_BATCH) {
    const end = Math.min(start + OLLAMA_BATCH, texts.length);
    const ids = Array.from({ length: end - start }, (_, k) => start + k);

    // Report at the start of each batch too, so the dialog never sits on "preparing" while the model works
    onProgress?.({ status: 'translating', done: start, total: texts.length, batchEnd: end });

    // A failed batch (e.g. Ollama 500 "token repeat limit reached") falls through to per-line retries below
    let reply = {};
    try {
      reply = await ask(ids, start, end);
    } catch (err) {
      console.warn('[Translate] Ollama batch failed, retrying line by line:', err.message);
    }
    const byId = new Map((reply.lines || []).map((l) => [Number(l.id), l]));

    for (const id of ids) {
      if (accept(id, byId.get(id))) continue;
      // Dropped, shifted or untranslated line → redo it alone, with the same context
      try {
        const single = await ask([id], id, id + 1);
        if (accept(id, single.lines?.[0])) continue;
      } catch (err) {
        console.warn(`[Translate] Ollama failed on line ${id}:`, err.message);
      }
      // One untranslatable line must not discard the whole transcription
      translations[id] = fallback.get(id) ?? texts[id];
    }
    onProgress?.({ status: 'translating', done: end, total: texts.length });
  }

  if (review) await reviewTranslations({ texts, sources, translations, srcName, tgtName, tgtLang, brief, model, onProgress });
  return { translations, sources };
}

// Second pass: an "editor" sees source and draft side by side with the whole brief and fixes what the
// first pass got wrong (wrong addressee or gender, literal idioms, omissions). Roughly doubles the time.
const REVIEW_BATCH = 12;
const REVIEW_CONTEXT = 3;

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, translation: { type: 'string' } },
        required: ['id', 'translation'],
      },
    },
  },
  required: ['lines'],
};

async function reviewTranslations({ texts, sources, translations, srcName, tgtName, tgtLang, brief, model, onProgress }) {
  const system = [
    `You are a senior ${tgtName} subtitle editor checking a translation from ${srcName}.`,
    '',
    "Translator's brief:",
    briefText(brief),
    '',
    'For each item in "lines" compare the source with the draft and return the final translation:',
    '- Fix mistranslations, omissions, additions, a wrong speaker or addressee, wrong pronouns or gender, inconsistent names, statements turned into questions (or the reverse), and unnatural phrasing.',
    '- If the draft is already correct and natural, return it unchanged.',
    "- Each line keeps only its own content: never move words between lines. \"before\" and \"after\" are context only.",
    TARGET_RULES[tgtLang] ?? '',
  ].join('\n');
  const pair = (id) => ({ source: sources[id], translation: translations[id] });

  for (let start = 0; start < texts.length; start += REVIEW_BATCH) {
    const end = Math.min(start + REVIEW_BATCH, texts.length);
    onProgress?.({ status: 'reviewing', message: `Đang soát lại bản dịch dòng ${start + 1}–${end} / ${texts.length}...`, percent: Math.round((start / texts.length) * 100) });
    let reply = {};
    try {
      reply = await ollamaChat(
        model,
        system,
        JSON.stringify({
          before: Array.from({ length: start - Math.max(0, start - REVIEW_CONTEXT) }, (_, k) => pair(Math.max(0, start - REVIEW_CONTEXT) + k)),
          lines: Array.from({ length: end - start }, (_, k) => ({ id: start + k, source: sources[start + k], draft: translations[start + k] })),
          after: Array.from({ length: Math.min(texts.length, end + REVIEW_CONTEXT) - end }, (_, k) => pair(end + k)),
        }),
        REVIEW_SCHEMA,
      );
    } catch (err) {
      // The drafts are already usable; a failed review batch just keeps them
      console.warn('[Translate] Review batch failed, keeping drafts:', err.message);
    }
    for (const line of reply.lines || []) {
      const id = Number(line.id);
      const revised = cleanLine(line.translation);
      if (id >= start && id < end && revised && !looksUntranslated(revised, texts[id], tgtLang)) translations[id] = revised;
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function translateSubtitles({ subtitles, sourceLang, targetLang, engine, ollamaModel, outputMode, review }, onProgress) {
  try {
    const texts = subtitles.map((s) => s.text);
    const src = sourceLang && sourceLang !== 'auto' ? sourceLang : detectLang(texts);

    if (src === targetLang) {
      return { success: true, subtitles, skipped: true };
    }
    if (engine !== 'ollama' && (!NLLB_CODES[src] || !NLLB_CODES[targetLang])) {
      throw new Error(`NLLB chưa hỗ trợ dịch ${src} → ${targetLang}, hãy dùng Ollama`);
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

    // Ollama also returns the proofread source lines, shown in bilingual mode
    let translated;
    let sources = texts;
    if (engine === 'ollama') {
      if (!ollamaModel) throw new Error('Chưa chọn model Ollama');
      ({ translations: translated, sources } = await translateWithOllama(texts, src, targetLang, ollamaModel, report, { review }));
    } else {
      translated = await translateWithNllb(texts, src, targetLang, report);
    }

    return {
      success: true,
      subtitles: subtitles.map((s, i) => ({ ...s, text: mergeText(sources[i], translated[i] || s.text, outputMode) })),
    };
  } catch (err) {
    nllbPipeline = null;
    return { success: false, error: err.message };
  }
}

module.exports = { translateSubtitles, listOllamaModels, detectLang };
