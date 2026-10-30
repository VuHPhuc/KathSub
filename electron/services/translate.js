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
const BRIEF_PREDICT = 3072; // measured: a real brief is 250-1250 tokens, a looping one 6000+ or never stops
// The first token waits for up to 400 lines of prompt to be read (minutes on a CPU-only PC); Node's fetch caps that wait
// at 300 s anyway. After that, a gap between tokens means a stall.
const BRIEF_FIRST_MS = 300000;
const BRIEF_IDLE_MS = 120000;

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
    intimate: { type: 'boolean' },
  },
  required: ['summary', 'characters', 'glossary', 'tone', 'intimate'],
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

// Target-specific instructions (pronouns, register, intimate/erotic dialogue)
const TARGET_RULES = {
  en: [
    '- English: write natural, idiomatic conversational subtitle dialogue that matches the character and mood.',
    '- Intimate / adult context: render spoken climax expressions (such as Japanese "イク", "行く", "いく", "イッちゃう", "イキそう") as natural spoken English (e.g. "I\'m cumming!", "I\'m gonna cum!", "I\'m about to... cum!"). STRICTLY NEVER use clinical, medical, or formal terms like "Climax" or "Orgasm", and never translate literally as "Go".',
  ].join('\n'),
  vi: [
    '- Đại từ xưng hô Tiếng Việt: chọn đại từ phù hợp quan hệ, tuổi tác và sắc thái (tớ/cậu, anh/em, em/anh, tao/mày, mình/bạn, chị/em...), giữ đúng một cặp xưng hô cho cùng hai nhân vật xuyên suốt. Ngôi thứ ba phải khớp giới tính trong brief (anh ấy/ổng cho nam, cô ấy/nhỏ/bả cho nữ).',
    '- Ngữ cảnh thân mật / 18+: Trong cảnh thân mật, các từ rên rỉ, xuất tinh / đạt cực khoái (như tiếng Nhật "イク", "行く", "いく", "イッちゃう", "イキそう") BẮT BUỘC dịch theo khẩu ngữ tự nhiên là "ra / sắp ra" (ví dụ: "Sắp ra rồi...", "Ra mất...", "Ra đây...", "Á... ra rồi!"; khi cần chủ ngữ thì dùng đúng đại từ của người nói theo brief — nữ thường "em", nam thường "anh" — không mặc định "em"), TUYỆT ĐỐI CẤM dịch thành "đi / đang đi / đi rồi" và không dùng từ sách vở "lên đỉnh".',
    '- Thán từ: tiếng thở はぁ/はあ → "Hah… hah…" (KHÔNG dùng "Hả" — "Hả" nghĩa là "hả?/gì cơ?"); あっ/あん/んっ → "A…", "Á…", "Ưm…".',
  ].join('\n'),
};

// Bounds per call (BUG-15). A small model can loop inside a structured reply and never stop (an endless glossary);
// without num_predict that ran until Node's fetch gave up at its fixed 300 s header timeout. The reply is streamed, so
// that timeout only covers the wait for the first token, and a stalled server is caught by our own idle timer instead.
const BATCH_PREDICT = 2048; // a batch reply is ~300-700 tokens
const IDLE_MS = 120000; // longest wait for the next chunk, the first one included (model load + prompt)
// A timeout is marked: it usually repeats on the same PC, so the brief does not retry it (BUG-18)
const timeoutError = (msg) => Object.assign(new Error(msg), { timeout: true });

async function ollamaChat(model, system, user, schema, { numCtx = 8192, numPredict = BATCH_PREDICT, idleMs = IDLE_MS, firstMs = idleMs } = {}) {
  const ac = new AbortController();
  let timer;
  const idle = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(timeoutError(`Ollama không phản hồi sau ${ms / 1000} s`)), ms);
  };
  idle(firstMs);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        model,
        stream: true,
        // Thinking models (Qwen3) otherwise spend thousands of tokens reasoning per batch: 90 s instead of 7 s
        think: false,
        format: schema,
        options: { temperature: 0.1, num_ctx: numCtx, num_predict: numPredict },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama lỗi ${res.status}: ${await res.text()}`);
    // A server or proxy that ignores stream:true answers with one JSON object
    if (!res.body) {
      const data = await res.json();
      return parseReply(data.message?.content, data.done_reason);
    }
    let content = '';
    let done = false;
    let doneReason;
    let buf = '';
    const dec = new TextDecoder();
    const take = (line) => {
      if (!line.trim()) return;
      let chunk;
      try {
        chunk = JSON.parse(line);
      } catch (_) {
        throw new Error(`Ollama trả dữ liệu không phải JSON: ${line.slice(0, 80)}`);
      }
      if (chunk.error) throw new Error(`Ollama lỗi: ${chunk.error}`);
      content += chunk.message?.content ?? '';
      if (chunk.done) [done, doneReason] = [true, chunk.done_reason];
    };
    for await (const part of res.body) {
      idle(idleMs);
      buf += dec.decode(part, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(take);
    }
    take(buf + dec.decode());
    if (!done) throw new Error('Ollama ngắt kết nối giữa chừng');
    return parseReply(content, doneReason);
  } catch (err) {
    if (ac.signal.aborted && ac.signal.reason instanceof Error) throw ac.signal.reason;
    // Node's fetch: no first token within its fixed 300 s, or the socket closed mid-reply
    if (/UND_ERR_(HEADERS|BODY)_TIMEOUT/.test(err.cause?.code)) throw timeoutError('Ollama không phản hồi (hết thời gian chờ của kết nối)');
    if (err.message === 'terminated') throw new Error('Ollama ngắt kết nối giữa chừng');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseReply(content, doneReason) {
  // Cut off at num_predict: the JSON is incomplete (and usually a loop), say so instead of a parse error
  if (doneReason === 'length') throw new Error('Ollama: câu trả lời bị cắt ở giới hạn token (model lặp?)');
  return JSON.parse(content || '{}');
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

// Small models sometimes answer an adult line with a refusal or a note to the user instead of a translation.
// Dialogue says "sorry", "I can't…", "I won't help you" and "adult content" too, so only wording no character
// would say counts on its own (META, REFUSE); weaker cues need a second one: an apology the source does not
// have, or "explicit content", together with "I can't help / do that".
const META = /\bas an ai\b|\blanguage model\b|against (my|the) (content )?(guidelines|polic)|là một (ai|mô hình ngôn ngữ)/i;
const REFUSE = /\bI (can(no|')t|am unable to|'m unable to|'m not able to|won't|will not) (assist|translate|comply|fulfil|generate|produce|provide (a |an |any )?(translation|assistance|response)|help (you )?with (that|this|your) request)\b|tôi không thể (dịch|hỗ trợ|cung cấp|thực hiện yêu cầu)/i;
// "I can't help it" and "I can't do that" are ordinary lines
const SOFT_REFUSE = /\bI (can(no|')t|am unable to|'m unable to|won't|will not) help\b(?! it\b)|tôi không thể (giúp|làm)/i;
const CONTENT = /\b(explicit|sexual|adult|inappropriate) content\b|nội dung (nhạy cảm|không phù hợp|khiêu dâm|tình dục|người lớn)/i;
const APOLOGY = /^\W*(I'm sorry|I am sorry|sorry|xin lỗi)(?!\p{L})/iu;
const SOURCE_APOLOGY = /ごめん|御免|すみません|すいません|すまな|すまん|申し訳|悪かった|悪い|失礼|待たせ|遅くなって|遅れて|sorry|미안|죄송|对不起|抱歉/i;
function looksLikeRefusal(translation, source) {
  if (META.test(translation) || REFUSE.test(translation)) return true;
  const apology = APOLOGY.test(translation) && !SOURCE_APOLOGY.test(source);
  return (apology || CONTENT.test(translation)) && (SOFT_REFUSE.test(translation) || (apology && CONTENT.test(translation)));
}

// The climax cry イク in any script (イク, いくっ, 逝く, 行っちゃう, イキそう, イっちゃう). Small models read the kanji and
// hiragana forms as physical "go", so in intimate scenes those lines get a hint. Katakana イク is almost only the cry
// (but not イキイキ "lively", イッツ "it's", イッショ). 行く/いく is everyday "go", so it only counts in a cry shape and
// never as a question (もう行っちゃうの？ is "leaving already?"):
// - っちゃう/っちゃお/きそう (中でいっちゃう, 一緒にいっちゃおう): で/に there are "where/how it happens", so only a
//   purpose (浴びに), へ, まで or どこ makes it physical;
// - く drawn out or repeated (行くっ, いくぅ, 行く…, いくいく), never plain 行く！/もう行く/行っちゃった: any に/へ/で/まで
//   before it (駅に行ってる, 先に行ってて, バイクで行く) or どこ makes it physical.
// Excluded everyday katakana: イクラ, イクメン, イクイノックス, イッツ, イッショ, イッパイ, イッキ(飲み), イッちょ, イッテQ, イッヒ,
// イキイキ, イキる/イキり/イキって (slang "act tough"), イけない
const CRY_KATAKANA = /(?<![ァ-ヺー])イ(ク(?!ラ|メン|イノ)|ッ(?!ツ|ショ|パイ|キ|ちょ|テQ|ヒ)|っ|キ(?!イキ|る|り|ら|れ|っ[てた])|き|け(?!な)|[かカ][せさ])/;
// Only the unambiguous cry shapes, for marking a whole film (BUG-17): drawn-out or repeated イク, イッちゃ, イキそう,
// イカせ, イッた, or イッ ending the line
const CRY_SURE = /(?<![ァ-ヺー])イ(ク(?=[ぅゥっッーｰ～〜…!！?？\s]|$|イク)|[ッっ]ちゃ|[キき]そう|[カか]せ|[ッっ]た|[ッっ](?=[\s!！?？…ー～〜。、]*$))/;
const CRY_STRONG = /逝[くっきけか]|(行|(?<!て)い)(っちゃ[うおい]|きそう)/;
const PURPOSE = /[ぁ-ゖ]に\s*(行|い)|(へ|まで)\s*(行|い)|どこ|何処/;
const CRY_KANA_KANJI = /(行|(?<![てで])い)く(?=[っッぅゥー～〜…]|\s*(行|い)く)/;
const DESTINATION = /[にへで]\s*(行|い[くっき])|まで\s*(行|い[くっき])|どこ|何処/;
function isClimaxCry(text) {
  const t = String(text ?? '');
  if (CRY_KATAKANA.test(t)) return true;
  if (/[?？]\s*$/.test(t)) return false;
  return (CRY_STRONG.test(t) && !PURPOSE.test(t)) || (CRY_KANA_KANJI.test(t) && !DESTINATION.test(t));
}
// On a line taken for the cry, only the cry itself is respelled in katakana before the model sees it (行っちゃう →
// イっちゃう, いくっ → イクっ, 逝く → イク): katakana イク is read as the cry every time, while a note next to the kanji
// is sometimes ignored. Same shapes and exclusions as above, per span, so another 行 on the line (駅に行く) stays.
const CRY_SPAN = /逝[くっきけか]|(?<!([ぁ-ゖ]に|へ|まで)\s*)(行|(?<!て)い)(っちゃ[うおい]|きそう)|(?<!([にへで]|まで)\s*)(行|(?<![てで])い)く(?=[っッぅゥー～〜…]|\s*(行|い)く)/g;
function katakanaCry(text) {
  return String(text ?? '')
    .replace(CRY_SPAN, (m) => `イ${m.slice(1) === 'く' ? 'ク' : m.slice(1)}`)
    .replace(/(?<=イク\s*)(行|い)く/g, 'イク'); // the last of a repeated いくいく
}
// Spelled out per target: a 4B model follows a ready rendering better than a pointer to a rule
const CRY_NOTE = {
  en: 'probably the climax cry イク: render it as "cum" (e.g. "I\'m gonna cum!"), not physical "go" — unless the context shows someone going somewhere',
  vi: 'probably the climax cry イク: dịch là "ra / sắp ra" (vd "Sắp ra rồi!"), KHÔNG dịch là "đi" — unless the context shows someone going somewhere',
};
const cryNote = (tgtLang) => CRY_NOTE[tgtLang] ?? 'probably the climax cry イク (sexual climax), not physical "go" — unless the context shows someone going somewhere';
// A literal "go" left in a noted cry line ("Sắp ra rồi… đi rồi!") is treated like an untranslated line —
// except next to the right rendering: "I'm going to cum!", "Go ahead, cum!", "Ra đi!", "Cho anh ra đi!"
const LITERAL_GO = {
  en: /^(?![\s\S]*\b(cum\w*|come|coming)\b)[\s\S]*\b(go|goes|going|gone|leave|leaving)\b/i,
  vi: /(?<!\p{L})(?<!(?<!\p{L})ra\s+)đi(?!\p{L})/iu,
};

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
    'describe them in the notes of the people they talk to. Never translate or localise personal names: romanise them (Hepburn for Japanese). ' +
    '"intimate": true if the dialogue includes a sexual or intimate scene, otherwise false.';
  const transcript = texts.slice(0, BRIEF_MAX_LINES).map((t, i) => `${i}: ${t}`).join('\n');
  // A runaway or cut-off reply is a sampling accident: the second try almost always comes back normal (BUG-15).
  // A timeout is not retried: on a slow PC it would only repeat.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const brief = await ollamaChat(model, system, transcript, BRIEF_SCHEMA,
        { numCtx: 16384, numPredict: BRIEF_PREDICT, firstMs: BRIEF_FIRST_MS, idleMs: BRIEF_IDLE_MS });
      if (typeof brief?.intimate === 'boolean') return brief;
      throw new Error('brief thiếu trường "intimate"');
    } catch (err) {
      // The brief only improves quality; translate without it rather than fail
      console.warn(`[Translate] Could not build translator brief (attempt ${attempt}/2):`, err.message);
      if (err.timeout) break;
    }
  }
  return null;
}

// Two unambiguous katakana cries close together mark an intimate scene without the LLM: the cry handling must not depend
// on one model call that can fail or miss it (BUG-15). A real scene repeats the cry within a minute or two; two stray
// lines far apart in an ordinary film (a gag, a song title) do not count (BUG-17).
const INTIMATE_WINDOW = 40;
function looksIntimate(texts) {
  const hits = texts.flatMap((t, i) => (CRY_SURE.test(String(t ?? '')) ? [i] : []));
  return hits.some((h, k) => k > 0 && h - hits[k - 1] <= INTIMATE_WINDOW);
}

function briefText(brief) {
  if (!brief) return '(none)';
  const chars = (brief.characters || []).map((c) => `- ${c.name} (${c.gender}): ${c.notes}`).join('\n');
  const terms = (brief.glossary || []).map((g) => `- ${g.term} → ${g.translation}`).join('\n');
  return `Summary: ${brief.summary}\nCharacters:\n${chars || '- (unknown)'}\nTerms:\n${terms || '- (none)'}\nTone: ${brief.tone}` +
    `\nIntimate scene: ${brief.intimate ? 'yes' : 'no'}`;
}

async function translateWithOllama(texts, srcLang, tgtLang, model, onProgress, { review = false } = {}) {
  const srcName = langName(srcLang);
  const tgtName = langName(tgtLang);

  onProgress?.({ status: 'analyzing', message: 'Đang đọc toàn bộ lời thoại để nắm ngữ cảnh...', percent: 0 });
  const drafted = await buildBrief(texts, srcName, tgtName, model);
  // Checked on every line, not just the 400 the brief reads, and ORed in: the model sometimes misses the scene too
  const intimate = !!drafted?.intimate || looksIntimate(texts);
  const brief = drafted ? { ...drafted, intimate } : intimate ? { summary: '(unavailable)', tone: '(unknown)', intimate } : null;
  const note = (id) => (intimate && isClimaxCry(texts[id]) ? { note: cryNote(tgtLang) } : {});
  const literalGo = (id, t) => !!note(id).note && !!LITERAL_GO[tgtLang]?.test(t);
  // What the model is shown for a line: the cry respelled in katakana (never written back to the user's source)
  const shown = (id, text = texts[id]) => (note(id).note ? katakanaCry(text) : text);

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
    `- Interjections, laughter, moans, gasps, and screams must be translated into short, natural spoken dialogue or interjections in ${tgtName}, NEVER into clinical, medical, or stage descriptions (e.g., strictly NEVER output "Climax", "Orgasm", or descriptive actions).`,
    '- "corrected_source": the source line with obvious speech-recognition mistakes fixed using the context (a wrong kanji for a homophone, a misheard name). If nothing is wrong copy it unchanged. Never rephrase it.',
    '- A line may carry a "note" from an automatic check of the wording (e.g. that 行く/いく is probably the climax cry). Follow it unless the context clearly contradicts it. Never translate the note itself.',
    '- Always translate; never answer with a refusal, an apology or a comment to the reader.',
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
          previous: texts.slice(Math.max(0, start - PREV_LINES), start).map((_, k) => ({
            source: shown(Math.max(0, start - PREV_LINES) + k),
            translation: translations[Math.max(0, start - PREV_LINES) + k],
          })),
          lines: ids.map((id) => ({ id, source: shown(id), ...note(id), ...problem(id) })),
          next: texts.slice(end, end + NEXT_LINES).map((_, k) => shown(end + k)),
        }),
      LINES_SCHEMA,
    );

  // A cry line answered with a literal "go" gets one more retry that says what was wrong. The rejected draft
  // itself is not shown: the model copies it verbatim (L-022).
  const goDrafts = new Set();
  const problem = (id) => (goDrafts.has(id) ? { problem: 'an earlier answer translated this climax cry as physical "go"; follow the note' } : {});

  // Accept a reply line only if it belongs to this id and is really translated
  const fallback = new Map(); // aligned but suspicious translation, still better than the source
  const accept = (id, got) => {
    // Aligned against what was sent (the katakana form for a cry line)
    if (!got || similarity(got.corrected_source, shown(id)) < 0.5) return false;
    const translation = cleanLine(got.translation);
    // A refusal is never kept, not even as the fallback
    if (looksLikeRefusal(translation, texts[id])) return false;
    if (looksUntranslated(translation, texts[id], tgtLang) || literalGo(id, translation)) {
      if (translation) fallback.set(id, translation);
      if (literalGo(id, translation)) goDrafts.add(id);
      return false;
    }
    translations[id] = translation;
    // Keep the proofread source only when it is a fix, not a rewrite — and never on a cry line, where it would
    // carry our katakana respelling back to the user as a "correction"
    if (!note(id).note && similarity(got.corrected_source, texts[id]) >= 0.6) sources[id] = String(got.corrected_source).trim();
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
      // Dropped, shifted or untranslated line → redo it alone, with the same context; a literal "go" gets one more try
      let ok = false;
      for (let attempt = 0; !ok && attempt < (goDrafts.has(id) ? 2 : 1); attempt++) {
        try {
          const single = await ask([id], id, id + 1);
          ok = accept(id, single.lines?.[0]);
        } catch (err) {
          console.warn(`[Translate] Ollama failed on line ${id}:`, err.message);
        }
      }
      if (ok) continue;
      // One untranslatable line must not discard the whole transcription
      translations[id] = fallback.get(id) ?? texts[id];
    }
    onProgress?.({ status: 'translating', done: end, total: texts.length });
  }

  if (review) await reviewTranslations({ texts, sources, translations, srcName, tgtName, tgtLang, brief, model, onProgress, note, literalGo, shown });
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

async function reviewTranslations({ texts, sources, translations, srcName, tgtName, tgtLang, brief, model, onProgress, note = () => ({}), literalGo = () => false, shown = (id, text) => text }) {
  const system = [
    `You are a senior ${tgtName} subtitle editor checking a translation from ${srcName}.`,
    '',
    "Translator's brief:",
    briefText(brief),
    '',
    'For each item in "lines" compare the source with the draft and return the final translation:',
    '- Fix mistranslations, omissions, additions, a wrong speaker or addressee, wrong pronouns or gender, inconsistent names, statements turned into questions (or the reverse), unnatural phrasing, and clinical/stage words (e.g. "Climax") that should be natural spoken dialogue.',
    '- If the draft is already correct and natural, return it unchanged.',
    "- Each line keeps only its own content: never move words between lines. \"before\" and \"after\" are context only.",
    '- A line may carry a "note" from an automatic check of the wording (e.g. that 行く/いく is probably the climax cry). Follow it unless the context clearly contradicts it.',
    '- Always return a translation; never a refusal, an apology or a comment to the reader.',
    TARGET_RULES[tgtLang] ?? '',
  ].join('\n');
  const pair = (id) => ({ source: shown(id, sources[id]), translation: translations[id] });

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
          lines: Array.from({ length: end - start }, (_, k) => ({ id: start + k, source: shown(start + k, sources[start + k]), draft: translations[start + k], ...note(start + k) })),
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
      if (id >= start && id < end && revised && !looksUntranslated(revised, texts[id], tgtLang) && !looksLikeRefusal(revised, texts[id]) &&
        !(literalGo(id, revised) && !literalGo(id, translations[id]))) {
        translations[id] = revised;
      }
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
