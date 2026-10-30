// Whisper service — supports OpenAI API (cloud) and @huggingface/transformers v3 (local)
// Both are loaded via dynamic import to avoid CommonJS/ESM conflicts.

let localPipeline = null;  // cached pipeline instance
let localModelSize = null; // model size the cached pipeline was built with

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Node has no AudioContext, so transformers.js cannot read a file path itself.
// Decode the 16 kHz mono PCM s16le WAV produced by ffmpeg.extractAudio into Float32Array.
function readWavAsFloat32(audioPath) {
  const buf = require('fs').readFileSync(audioPath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('File audio không phải WAV hợp lệ');
  }

  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bitsPerSample !== 16 || fmt.channels !== 1 || fmt.sampleRate !== 16000) {
        throw new Error('Audio phải là PCM 16-bit, mono, 16 kHz');
      }
      // ffmpeg may leave size = 0xFFFFFFFF when streaming; clamp to the real file length
      const end = Math.min(body + size, buf.length);
      const count = Math.floor((end - body) / 2);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        samples[i] = buf.readInt16LE(body + i * 2) / 32768;
      }
      return samples;
    }

    offset = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error('Không tìm thấy dữ liệu audio trong file WAV');
}

// Whisper hallucinates loops on music, moans or noise ("ああああ…", "ねえ、ねえ、ねえ…") that can fill a
// whole 30 s window. Keep at most 3 copies of any short run; a 400-char loop also makes Ollama abort
// with "token repeat limit reached", which used to throw away the whole job.
function collapseRepeats(text) {
  return text.replace(/(.{1,20}?)\1{3,}/gs, '$1$1$1');
}

function makeId() {
  return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function buildSubtitles(segments) {
  return segments
    .filter((s) => s.text && s.text.trim())
    .map((s) => ({
      id: makeId(),
      startTime: s.startTime ?? s.start ?? 0,
      endTime:   s.endTime   ?? s.end   ?? (s.start ?? 0) + 3,
      text: collapseRepeats(s.text.trim()),
      x: 50,
      y: 85,
      fontSize: 24,
      fontFamily: 'Montserrat',
      color: '#ffffff',
      hasBox: false,
      backgroundColor: '#000000',
      bold: true,
      italic: false,
      outlineColor: '#000000',
      outlineWidth: 2,
    }));
}

// ─── Cloud: OpenAI Whisper API ────────────────────────────────────────────────

async function transcribeWithAPI(audioPath, apiKey, language, onProgress, { signal } = {}) {
  try {
    throwIfCancelled(signal);
    const fs = require('fs');
    onProgress?.({ status: 'uploading', message: 'Đang gửi audio lên Whisper API...', percent: 10 });

    const { OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey });

    onProgress?.({ status: 'transcribing', message: 'Đang nhận dạng giọng nói...', percent: 30 });

    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      language: language && language !== 'auto' ? language : undefined,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    }, { signal });
    throwIfCancelled(signal);

    onProgress?.({ status: 'processing', message: 'Đang xử lý kết quả...', percent: 90 });

    const segments = (response.segments || []).map((seg) => ({
      startTime: seg.start,
      endTime: seg.end,
      text: seg.text,
    }));

    const subtitles = buildSubtitles(segments);
    onProgress?.({ status: 'done', message: 'Hoàn thành!', percent: 100 });
    return { success: true, subtitles };
  } catch (err) {
    if (signal?.aborted) return { ...CANCELLED_RESULT };
    return { success: false, error: err.message };
  }
}

// ─── Local: @huggingface/transformers v3 (Whisper) ───────────────────────────
// transformers.js v2 (onnxruntime 1.14) could not load large-v3 models and its timestamps/language
// handling garbled Japanese (34 % character errors on a clean test dialogue vs 3 % now).

const path = require('path');
const zlib = require('zlib');
const vad = require('./vad');
const { CACHE_DIR, ensureModelFiles, downloadMessage } = require('./models');
const { throwIfCancelled, CANCELLED_RESULT } = require('./jobs');

const SR = 16000;

// large-v3-turbo: large-v3 encoder with a 4-layer decoder, close to large-v3 accuracy at medium speed
const MODEL_REPOS = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small',
  medium: 'Xenova/whisper-medium',
  'large-v3-turbo': 'onnx-community/whisper-large-v3-turbo',
  // large-v3-turbo fine-tuned on Japanese anime / visual-novel voices (efwkjn/whisper-ja-anime-v0.3): far fewer
  // misheard words in moaned or shouted lines. Japanese only, with its own smaller Japanese vocabulary.
  'anime-ja': 'willopcbeta/whisper-ja-anime-v0.3-ONNX',
};
// Per-model differences: anime-ja ships no 8-bit encoder (4-bit instead) and only knows Japanese
const MODEL_OPTIONS = {
  'anime-ja': { encoder: 'q4', language: 'ja' },
};
const DTYPE_SUFFIX = { q8: 'quantized', q4: 'q4' };
const whisperFiles = (size) => [
  'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
  `onnx/encoder_model_${DTYPE_SUFFIX[MODEL_OPTIONS[size]?.encoder ?? 'q8']}.onnx`, 'onnx/decoder_model_merged_quantized.onnx',
];
const VAD_REPO = 'onnx-community/silero-vad';
const VAD_FILE = 'onnx/model.onnx';

const MAX_CHUNK_S = 25;    // Whisper sees 30 s windows; leave room so chunks end in a pause
const MAX_SEGMENT_S = 8;   // a subtitle line longer than this is re-split at pauses
const SPLIT_S = 6;         // a looping chunk longer than this is redone per speech region (pieces up to this long)

// v3 silently falls back to English when no language is given, so detect it ourselves:
// one decoder step after <|startoftranscript|> scores every language token. The 3 longest speech
// chunks vote (summed probabilities), so an opening of music or breathing cannot decide alone.
async function detectLanguage(pipe, audio, chunks) {
  const { Tensor } = await import('@huggingface/transformers');
  const picks = [...chunks].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 3);
  if (!picks.length) picks.push({ start: 0, end: 30 });

  const t2i = pipe.tokenizer.model.tokens_to_ids;
  const sot = t2i.get('<|startoftranscript|>');
  const langs = [...t2i].flatMap(([token, id]) => {
    const m = /^<\|([a-z]{2,3})\|>$/.exec(token);
    return m ? [[m[1], id]] : [];
  });
  const votes = new Map();
  for (const c of picks) {
    const slice = audio.subarray(Math.floor(c.start * SR), Math.floor(Math.min(c.end, c.start + 29.5) * SR));
    const { input_features } = await pipe.processor(slice);
    const out = await pipe.model({
      input_features,
      decoder_input_ids: new Tensor('int64', BigInt64Array.from([BigInt(sot)]), [1, 1]),
    });
    const logits = out.logits.data;
    const offset = logits.length - out.logits.dims.at(-1);
    // Softmax over the language tokens only
    const max = Math.max(...langs.map(([, id]) => logits[offset + id]));
    const exps = langs.map(([, id]) => Math.exp(logits[offset + id] - max));
    const sum = exps.reduce((n, e) => n + e, 0);
    langs.forEach(([lang], k) => votes.set(lang, (votes.get(lang) ?? 0) + exps[k] / sum));
  }
  return [...votes].reduce((best, v) => (v[1] > best[1] ? v : best), [null, -1])[0];
}

// What Whisper invents for breathing or silence (YouTube outros it was trained on); only dropped in
// non-speech sounds, where it cannot be what was said
const NON_SPEECH_HALLUCINATIONS = /ご視聴|ご清聴|チャンネル登録|字幕|視聴者|thanks? (you )?for watching|subscribe|subtitles? by/i;
// Lines that are only sound tags or symbols ("♪～", "(音楽)", "【拍手】", "(笑)") say nothing
const isTagOnly = (text) =>
  !String(text).replace(/[(（【[［][^)）】\]］]*[)）】\]］]/g, '').replace(/[\s\p{P}\p{S}]/gu, '');

// Whisper's own hallucination test: looping text compresses far better than real speech
function looksLikeLoop(text) {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length > 60 && bytes.length / zlib.deflateSync(bytes).length > 2.4;
}

// split: on a loop, do not retry; return { kept, loopFrom } instead — the lines before the loop (their timestamps are
// fine) and where the loop starts — so the caller can redo the rest per speech region. The retry with
// repetition_penalty also penalises the timestamp tokens: every line came back exactly 2.00 s long, end to end
// (24.82-26.82, 26.82-28.82, ...), so lines sat over pauses and real speech looked like an empty gap.
async function transcribeSpan(pipe, audio, start, end, lang, vocal = false, { split = false } = {}) {
  const slice = audio.subarray(Math.floor(start * SR), Math.floor(end * SR));
  const dur = end - start;
  const opts = {
    language: lang,
    task: 'transcribe',
    return_timestamps: true,
    // Real speech needs ~10 tokens/s at most; the cap stops a loop from filling the window.
    // Moans/shouts are a few short words, so they get a much tighter cap.
    max_new_tokens: vocal ? Math.ceil(dur * 6) + 8 : Math.min(440, Math.ceil(dur * 12) + 24),
  };

  const round = (t) => Math.round(t * 100) / 100;
  let r = await pipe(slice, opts);
  if (looksLikeLoop((r.chunks ?? []).map((c) => c.text).join(''))) {
    if (split) {
      // The loop starts at the first line that loops by itself or never ended (it ran into max_new_tokens);
      // without one (a loop spread over many short lines) the whole span is redone
      const chunks = r.chunks ?? [];
      let k = chunks.findIndex((c) => looksLikeLoop(c.text) || c.timestamp?.[1] == null);
      if (k < 0) k = 0;
      return {
        kept: toSegments(chunks.slice(0, k)),
        loopFrom: Math.min(end, start + (chunks[k]?.timestamp?.[0] ?? 0)),
      };
    }
    r = await pipe(slice, { ...opts, no_repeat_ngram_size: 4, repetition_penalty: 1.3 });
    // Its timestamps are not to be trusted (see above): the span is short here, so it becomes one line
    const text = (r.chunks ?? []).map((c) => c.text).join('').trim();
    if (!text || (vocal && (NON_SPEECH_HALLUCINATIONS.test(text) || isTagOnly(text)))) return [];
    return [{ startTime: round(start), endTime: round(end), text }];
  }

  return toSegments(r.chunks ?? []);

  function toSegments(list) {
    return list
      .filter((c) => !(vocal && (NON_SPEECH_HALLUCINATIONS.test(c.text) || isTagOnly(c.text))))
      .map((c) => {
        const s = Math.min(end, start + (c.timestamp?.[0] ?? 0));
        let e = Math.min(end, start + (c.timestamp?.[1] ?? dur));
        if (e <= s) e = Math.min(end, s + 2);
        return { startTime: round(s), endTime: round(e), text: c.text };
      });
  }
}

// Whisper often packs two speakers' lines into one segment separated by a space
// ("助かる 前回は1時間も…"). Japanese and Chinese are written without spaces, so there a space is an
// utterance break: give each part its own line, cut at the longest pauses the VAD found inside the
// segment, or by text length when there are fewer pauses than parts.
function splitUtterances(seg, speech, lang) {
  if (!['ja', 'zh'].includes(lang)) return [seg];
  const parts = seg.text.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [seg];

  const round = (t) => Math.round(t * 100) / 100;
  const inside = speech
    .map((r) => ({ start: Math.max(r.start, seg.startTime), end: Math.min(r.end, seg.endTime) }))
    .filter((r) => r.end - r.start > 0.15);

  if (inside.length >= parts.length) {
    const cuts = inside
      .slice(1)
      .map((r, i) => ({ i: i + 1, gap: r.start - inside[i].end }))
      .sort((a, b) => b.gap - a.gap)
      .slice(0, parts.length - 1)
      .map((c) => c.i)
      .sort((a, b) => a - b);
    const bounds = [0, ...cuts, inside.length];
    return parts.map((text, k) => ({
      startTime: round(k === 0 ? seg.startTime : inside[bounds[k]].start),
      endTime: round(k === parts.length - 1 ? seg.endTime : inside[bounds[k + 1] - 1].end),
      text,
    }));
  }

  const totalChars = parts.reduce((n, p) => n + p.length, 0);
  const dur = seg.endTime - seg.startTime;
  let t = seg.startTime;
  return parts.map((text) => {
    const s = t;
    t += (dur * text.length) / totalChars;
    return { startTime: round(s), endTime: round(t), text };
  });
}

// includeVocals: also subtitle moans, shouts and breathing that are not speech ("イク", "あっ")
// signal: the job's AbortSignal, checked between steps and between chunks (a chunk already being decoded finishes first)
async function transcribeLocal(audioPath, modelSize = 'small', language, onProgress, { includeVocals = false, signal } = {}) {
  const check = () => throwIfCancelled(signal);
  try {
    check();
    const repo = MODEL_REPOS[modelSize] ?? MODEL_REPOS.small;

    onProgress?.({ status: 'loading', message: `Đang chuẩn bị model Whisper ${modelSize}...`, percent: 3 });
    await ensureModelFiles(repo, whisperFiles(modelSize), (file, loaded, total) => {
      onProgress?.({
        status: 'downloading',
        message: downloadMessage(`model ${modelSize}`, file, loaded, total),
        percent: Math.round(3 + (total ? loaded / total : 0) * 40),
      });
    }, { signal });
    await ensureModelFiles(VAD_REPO, [VAD_FILE], undefined, { signal });
    check();

    // Rebuild the pipeline when the user picks a different model size
    if (localPipeline && localModelSize !== modelSize) {
      try {
        await localPipeline.dispose?.();
      } catch (err) {
        console.warn('[Whisper] Failed to dispose previous model:', err.message);
      }
      localPipeline = null;
      localModelSize = null;
    }

    if (!localPipeline) {
      onProgress?.({ status: 'loading', message: `Đang nạp model Whisper ${modelSize}...`, percent: 45 });
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = CACHE_DIR;
      env.allowRemoteModels = true; // small optional files not in whisperFiles()
      localPipeline = await pipeline('automatic-speech-recognition', repo, {
        dtype: { encoder_model: MODEL_OPTIONS[modelSize]?.encoder ?? 'q8', decoder_model_merged: 'q8' },
      });
      localModelSize = modelSize;
    }
    check(); // the loaded model stays cached for the next run

    const audio = readWavAsFloat32(audioPath);

    onProgress?.({ status: 'vad', message: 'Đang tìm các đoạn có giọng nói...', percent: 50 });
    const probs = await vad.speechProbs(audio, path.join(CACHE_DIR, VAD_REPO, VAD_FILE), (f) => {
      check(); // called every ~64 s of audio; the throw ends the VAD loop
      onProgress?.({ status: 'vad', message: `Đang tìm các đoạn có giọng nói... ${Math.round(f * 100)}%`, percent: Math.round(50 + f * 6) });
    });
    check();
    const speech = vad.speechRegions(probs);
    const chunks = vad.groupChunks(speech, probs, MAX_CHUNK_S);
    if (includeVocals) {
      for (const c of vad.groupChunks(vad.loudRegions(audio, speech), probs, 4)) chunks.push({ ...c, vocal: true });
      chunks.sort((a, b) => a.start - b.start);
    }
    if (!chunks.length) {
      // Speech under loud music can fool the VAD; better to transcribe everything than nothing
      const total = audio.length / SR;
      for (let t = 0; t < total; t += MAX_CHUNK_S) chunks.push({ start: t, end: Math.min(total, t + MAX_CHUNK_S) });
    }

    // A single-language model transcribes only its own language
    let lang = MODEL_OPTIONS[modelSize]?.language ?? (language && language !== 'auto' ? language : null);
    if (!lang) {
      onProgress?.({ status: 'detecting', message: 'Đang nhận biết ngôn ngữ...', percent: 58 });
      lang = await detectLanguage(localPipeline, audio, chunks.filter((c) => !c.vocal));
    }

    const segments = [];
    for (let i = 0; i < chunks.length; i++) {
      check();
      onProgress?.({
        status: 'transcribing',
        message: `Đang nhận dạng giọng nói... ${Math.round((i / chunks.length) * 100)}%`,
        percent: Math.round(60 + (i / chunks.length) * 34),
      });
      const { start, end, vocal } = chunks[i];
      let found = await transcribeSpan(localPipeline, audio, start, end, lang, vocal, { split: !vocal && end - start > SPLIT_S });
      if (!Array.isArray(found)) {
        // Looped on a long chunk (moaning between lines): the lines before the loop stay, the rest is redone per
        // speech region, timed by the VAD
        const { kept, loopFrom } = found;
        found = [...kept];
        const from = kept.length ? Math.max(loopFrom, kept[kept.length - 1].endTime) : start;
        const inside = speech
          .map((r) => ({ start: Math.max(r.start, from), end: Math.min(r.end, end) }))
          .filter((r) => r.end - r.start > 0.1);
        for (const piece of vad.groupChunks(inside, probs, SPLIT_S, 0.3)) {
          check();
          found.push(...(await transcribeSpan(localPipeline, audio, piece.start, piece.end, lang)));
        }
      }
      for (const seg of found) {
        if (seg.endTime - seg.startTime <= MAX_SEGMENT_S) {
          segments.push(seg);
          continue;
        }
        // One text stuck over a long stretch (often moans or music): redo it in short pieces cut at pauses
        for (const piece of vad.groupChunks([{ start: seg.startTime, end: seg.endTime }], probs, 6)) {
          check();
          segments.push(...(await transcribeSpan(localPipeline, audio, piece.start, piece.end, lang)));
        }
      }
    }

    onProgress?.({ status: 'processing', message: 'Đang xử lý kết quả...', percent: 95 });
    const subtitles = buildSubtitles(segments.flatMap((seg) => splitUtterances(seg, speech, lang)));
    onProgress?.({ status: 'done', message: 'Hoàn thành!', percent: 100 });
    return { success: true, subtitles, language: lang };
  } catch (err) {
    // Cancelled by the user: keep the loaded model for the next run
    if (signal?.aborted) return { ...CANCELLED_RESULT };
    // Reset pipeline so next call tries again fresh
    localPipeline = null;
    localModelSize = null;
    return { success: false, error: err.message };
  }
}

// Drop the cached Whisper pipeline and VAD session (after their files were deleted from the cache),
// so the next run downloads and loads them again instead of using stale objects
async function resetModels() {
  const pipe = localPipeline;
  localPipeline = null;
  localModelSize = null;
  try {
    await pipe?.dispose?.();
  } catch (err) {
    console.warn('[Whisper] Failed to dispose model:', err.message);
  }
  await vad.reset();
}

module.exports = { transcribeWithAPI, transcribeLocal, resetModels, MODEL_REPOS, VAD_REPO };
