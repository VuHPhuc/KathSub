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
function groupChunks(regions, probs, maxS = 25, joinGapS = 1.5) {
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
    // Join short neighbouring pieces (gap < 1.5 s by default) so Whisper sees whole sentences with context
    if (last && p.end - last.start <= maxS && p.start - last.end < joinGapS) last.end = p.end;
    else chunks.push({ ...p });
  }
  return chunks;
}

// Voicing of one 32 ms frame: peak of the normalised autocorrelation over pitch lags (75–1000 Hz),
// searched only after it first drops below zero so a low rumble (kick drum, 60 Hz hum) — whose
// correlation is high at short lags just because it changes slowly — never counts. Lags shorter than
// a 1000 Hz period are skipped too: narrow-band hiss and creaks ring at those. Computed on a
// 2x-decimated frame (8 kHz, 256 samples) to keep 1–3 h files cheap. Voices: ~0.8–1; noise: < 0.3.
const DEC = 2;
const MIN_LAG = Math.floor(SR / DEC / 1000);
const MAX_LAG = Math.ceil(SR / DEC / 75);
const voiceBuf = new Float32Array(WINDOW / DEC);
const energyPrefix = new Float64Array(WINDOW / DEC + 1);
function voicing(audio, from) {
  const x = voiceBuf;
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i] = (audio[from + i * DEC] + audio[from + i * DEC + 1]) / 2;
  mean /= n;
  for (let i = 0; i < n; i++) {
    x[i] -= mean;
    energyPrefix[i + 1] = energyPrefix[i] + x[i] * x[i];
  }
  let best = 0;
  let crossed = false;
  for (let lag = 1; lag <= MAX_LAG; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    const r = s / (Math.sqrt(energyPrefix[n - lag] * (energyPrefix[n] - energyPrefix[lag])) || 1);
    if (!crossed) crossed = r < 0;
    else if (lag >= MIN_LAG && r > best) best = r;
  }
  return best;
}

// Median frame loudness inside the VAD speech regions; 0 when there is too little speech (< 3 s) to tell
function dialogueLevel(rms, speech, step) {
  const inside = [];
  for (const r of speech) {
    for (let i = Math.ceil(r.start / step); i < Math.min(rms.length, Math.floor(r.end / step)); i++) inside.push(rms[i]);
  }
  if (inside.length * step < 3) return 0;
  inside.sort((a, b) => a - b);
  return inside[Math.floor(inside.length / 2)];
}

// Loud stretches the VAD rejected: moans, shouts ("イク", "あっ"). Silero is trained to ignore these,
// so when the user wants them subtitled they are found by loudness instead — but only where the sound
// is voiced (has a pitch): rustle, bed creaks, breathing and kick drums are loud too, and Whisper
// turns them into invented lines.
function loudRegions(audio, speech, { minVoicedS = 0.15, mergeGapS = 0.4, voicedR = 0.5, padBeforeS = 0.2, padAfterS = 0.15 } = {}) {
  const step = WINDOW / SR;
  const rms = new Float32Array(Math.floor(audio.length / WINDOW));
  for (let i = 0; i < rms.length; i++) {
    let sum = 0;
    for (let j = i * WINDOW; j < (i + 1) * WINDOW; j++) sum += audio[j] * audio[j];
    rms[i] = Math.sqrt(sum / WINDOW);
  }
  // 3x the quiet-room level (30th percentile), so steady background noise never counts as a sound.
  // The absolute floor (-42 dBFS) is low because ASMR is mastered quietly; the voicing test rejects noise.
  // A cry is also judged against the voices in the same file: at least 1/4 of the typical dialogue level,
  // so a soft pitched BGM bed in a normally mastered film is not taken for moaning, while ASMR (quiet
  // speech, or none found) keeps the low floor. Capped at the old fixed floor (-32 dBFS): loud or clipped
  // dialogue, or music the VAD took for speech, must not hide a moan that is plainly audible.
  const sorted = Float32Array.from(rms).sort();
  const threshold = Math.max(0.008, 3 * (sorted[Math.floor(sorted.length * 0.3)] || 0), Math.min(0.025, 0.25 * dialogueLevel(rms, speech, step)));

  // Runs of loud voiced frames outside speech, joined across short gaps
  const regions = [];
  let k = 0; // speech regions are sorted; walk them alongside the frames
  for (let i = 0; i < rms.length; i++) {
    const t = i * step;
    while (k < speech.length && speech[k].end <= t) k++;
    const inSpeech = k < speech.length && t >= speech[k].start;
    if (rms[i] < threshold || inSpeech || voicing(audio, i * WINDOW) < voicedR) continue;
    const last = regions[regions.length - 1];
    // Never join across a speech region: the gap would swallow it
    if (last && t - last.end <= mergeGapS && last.k === k) { last.end = t + step; last.voiced += step; }
    else regions.push({ start: t, end: t + step, voiced: step, k });
  }

  // Pad so a soft attack ("イ…ク") and a trailing devoiced syllable are not cut, without running into
  // the neighbouring speech regions; padding can make neighbours overlap, so merge them
  const total = rms.length * step;
  return regions
    // Rumble and bumps pass the voicing test on a few stray frames; a real cry is voiced throughout
    .filter((r) => r.voiced >= minVoicedS && r.voiced >= 0.3 * (r.end - r.start))
    .map((r) => ({
      start: Math.max(0, r.start - padBeforeS, r.k > 0 ? speech[r.k - 1].end : 0),
      end: Math.min(total, r.end + padAfterS, r.k < speech.length ? speech[r.k].start : Infinity),
    }))
    .reduce((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else acc.push(r);
      return acc;
    }, []);
}

// Release the cached session (its model file was deleted); the next speechProbs call loads it again
async function reset() {
  const sess = session;
  session = null;
  try {
    await sess?.release?.();
  } catch (err) {
    console.warn('[VAD] Failed to release session:', err.message);
  }
}

module.exports = { speechProbs, speechRegions, groupChunks, loudRegions, reset, SR, WINDOW };
