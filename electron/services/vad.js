// Voice activity detection with Silero VAD (ONNX, ~2 MB) — finds where people actually speak.
// Whisper invents text over silence, music and breathing ("ご視聴ありがとうございました", endless loops),
// so only speech regions are sent to it, and chunks are cut in pauses instead of mid-word.

const SR = 16000;
const WINDOW = 512;  // samples per VAD step (32 ms)
const CONTEXT = 64;  // Silero v5 expects the last 64 samples of the previous window prepended

let session = null;

async function loadVad(modelPath) {
  if (session) return session;
  const ort = require('onnxruntime-node');
  session = await ort.InferenceSession.create(modelPath);
  return session;
}

// Speech probability for every 32 ms window
async function speechProbs(audio, modelPath, onProgress) {
  const ort = require('onnxruntime-node');
  const sess = await loadVad(modelPath);
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SR)]), []);
  const frame = new Float32Array(CONTEXT + WINDOW);
  const steps = Math.floor(audio.length / WINDOW);
  const probs = new Float32Array(steps);

  for (let i = 0; i < steps; i++) {
    frame.copyWithin(0, WINDOW, WINDOW + CONTEXT); // previous window's tail becomes the context
    frame.set(audio.subarray(i * WINDOW, (i + 1) * WINDOW), CONTEXT);
    const out = await sess.run({ input: new ort.Tensor('float32', frame, [1, CONTEXT + WINDOW]), state, sr });
    probs[i] = out.output.data[0];
    state = out.stateN;
    if (onProgress && i % 2000 === 0) onProgress(i / steps);
  }
  return probs;
}

// Same hysteresis as silero-vad's get_speech_timestamps: enter speech above 0.5, leave below 0.35
function speechRegions(probs, { threshold = 0.5, minSpeechS = 0.25, minSilenceS = 0.4, padS = 0.2 } = {}) {
  const step = WINDOW / SR;
  const regions = [];
  let start = null;
  let silentFor = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (start === null) {
      if (p >= threshold) { start = i; silentFor = 0; }
    } else if (p < threshold - 0.15) {
      silentFor++;
      if (silentFor * step >= minSilenceS) {
        regions.push([start, i - silentFor + 1]);
        start = null;
      }
    } else {
      silentFor = 0;
    }
  }
  if (start !== null) regions.push([start, probs.length]);

  const total = probs.length * step;
  return regions
    .map(([a, b]) => ({ start: Math.max(0, a * step - padS), end: Math.min(total, b * step + padS) }))
    .filter((r) => r.end - r.start >= minSpeechS)
    // Padding can make neighbours overlap; merge them
    .reduce((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else acc.push({ ...r });
      return acc;
    }, []);
}

// Group speech regions into Whisper-sized chunks (≤ maxS seconds), splitting over-long regions
// at their least speech-like window so no word is cut in half.
function groupChunks(regions, probs, maxS = 25) {
  const step = WINDOW / SR;
  const pieces = [];
  for (const r of regions) {
    let { start, end } = r;
    while (end - start > maxS) {
      const from = Math.floor((start + maxS * 0.6) / step);
      const to = Math.floor((start + maxS) / step);
      let cut = to;
      for (let i = from; i < to; i++) if (probs[i] < probs[cut]) cut = i;
      pieces.push({ start, end: cut * step });
      start = cut * step;
    }
    pieces.push({ start, end });
  }

  const chunks = [];
  for (const p of pieces) {
    const last = chunks[chunks.length - 1];
    // Join short neighbouring pieces (gap < 1.5 s) so Whisper sees whole sentences with context
    if (last && p.end - last.start <= maxS && p.start - last.end < 1.5) last.end = p.end;
    else chunks.push({ ...p });
  }
  return chunks;
}

// Loud stretches the VAD rejected: moans, shouts, breathing ("イク", "あっ"). Silero is trained to
// ignore these, so when the user wants them subtitled they are found by loudness instead.
function loudRegions(audio, speech, { minS = 0.4, mergeGapS = 0.4 } = {}) {
  const step = WINDOW / SR;
  const rms = new Float32Array(Math.floor(audio.length / WINDOW));
  for (let i = 0; i < rms.length; i++) {
    let sum = 0;
    for (let j = i * WINDOW; j < (i + 1) * WINDOW; j++) sum += audio[j] * audio[j];
    rms[i] = Math.sqrt(sum / WINDOW);
  }
  // 3x the quiet-room level (30th percentile), so steady background noise never counts as a sound
  const sorted = Float32Array.from(rms).sort();
  const threshold = Math.max(0.025, 3 * (sorted[Math.floor(sorted.length * 0.3)] || 0));

  const regions = [];
  let k = 0; // speech regions are sorted; walk them alongside the frames
  for (let i = 0; i < rms.length; i++) {
    const t = i * step;
    while (k < speech.length && speech[k].end <= t) k++;
    const inSpeech = k < speech.length && t >= speech[k].start;
    if (rms[i] < threshold || inSpeech) continue;
    const last = regions[regions.length - 1];
    if (last && t - last.end <= mergeGapS) last.end = t + step;
    else regions.push({ start: t, end: t + step });
  }
  return regions.filter((r) => r.end - r.start >= minS);
}

module.exports = { speechProbs, speechRegions, groupChunks, loudRegions, SR, WINDOW };
