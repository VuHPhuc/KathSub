// Whisper service — supports OpenAI API (cloud) and @xenova/transformers (local)
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
      text: s.text.trim(),
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

async function transcribeWithAPI(audioPath, apiKey, language, onProgress) {
  try {
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
    });

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
    return { success: false, error: err.message };
  }
}

// ─── Local: @xenova/transformers (Whisper) ────────────────────────────────────

async function transcribeLocal(audioPath, modelSize = 'small', language, onProgress) {
  try {
    onProgress?.({
      status: 'loading',
      message: `Đang tải model Whisper ${modelSize} (lần đầu sẽ download ~${getModelSize(modelSize)})...`,
      percent: 5,
    });

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
      const { pipeline, env } = await import('@xenova/transformers');

      // Cache models in user data folder instead of node_modules
      env.cacheDir = require('path').join(require('os').homedir(), '.kathsub', 'models');
      env.allowRemoteModels = true;

      localPipeline = await pipeline(
        'automatic-speech-recognition',
        `Xenova/whisper-${modelSize}`,
        {
          progress_callback: (p) => {
            if (p.status === 'downloading') {
              const pct = Math.round((p.loaded / p.total) * 100) || 0;
              onProgress?.({
                status: 'downloading',
                message: `Đang tải model: ${p.file} (${pct}%)`,
                percent: Math.round(5 + pct * 0.5),
              });
            }
          },
        }
      );
      localModelSize = modelSize;
    }

    onProgress?.({ status: 'transcribing', message: 'Đang nhận dạng giọng nói...', percent: 60 });

    const audio = readWavAsFloat32(audioPath);

    // Chunking options belong to the call, not pipeline(); without them only the first 30 s is transcribed
    const result = await localPipeline(audio, {
      language: language && language !== 'auto' ? language : null,
      return_timestamps: true,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    onProgress?.({ status: 'processing', message: 'Đang xử lý kết quả...', percent: 95 });

    const chunks = result.chunks ?? [];
    const segments = chunks.map((c) => ({
      startTime: c.timestamp?.[0] ?? 0,
      endTime:   c.timestamp?.[1] ?? (c.timestamp?.[0] ?? 0) + 3,
      text: c.text,
    }));

    const subtitles = buildSubtitles(segments);
    onProgress?.({ status: 'done', message: 'Hoàn thành!', percent: 100 });
    return { success: true, subtitles };
  } catch (err) {
    // Reset pipeline so next call tries again fresh
    localPipeline = null;
    localModelSize = null;
    return { success: false, error: err.message };
  }
}

function getModelSize(modelSize) {
  const sizes = { tiny: '75 MB', base: '145 MB', small: '466 MB', medium: '1.5 GB' };
  return sizes[modelSize] ?? '???';
}

module.exports = { transcribeWithAPI, transcribeLocal };
