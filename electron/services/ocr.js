// OCR service — reads subtitles burned into the picture, for videos with no speech to transcribe.
// ffmpeg streams small grayscale frames of the subtitle band; a frame's "text mask" is its letters: light letters
// outlined in dark (white / yellow subtitles) or coloured letters outlined in white. Letters close together form a
// block, and each block is tracked on its own, so subtitles that jump left / right or share the screen stay separate.
// A track ends when its text changes or disappears, and tesseract.js (offline, ~1–15 MB of language data downloaded
// once) or a vision model in Ollama (slower, far more accurate on stylised Japanese / Chinese fonts) reads one frame
// from it.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const { CACHE_DIR } = require('./models');
const { getFfmpegPath } = require('./ffmpeg');
const { cancelledError, throwIfCancelled } = require('./jobs');
const { OLLAMA_URL } = require('./translate');

const OCR_DIR = 'tesseract'; // language data, under CACHE_DIR
const FPS = 4;               // frames read per second: subtitle timing is accurate to 1/FPS s
const MAX_WIDTH = 1280;      // frames are scaled down to this width

// UI language code → tesseract language data
const TESS_LANGS = {
  vi: 'vie', en: 'eng', ja: 'jpn', ko: 'kor', zh: 'chi_sim',
  es: 'spa', fr: 'fra', de: 'deu', pt: 'por', ru: 'rus', th: 'tha', id: 'ind',
};

// Part of the frame height that holds the subtitles: [top, bottom]
const REGIONS = {
  bottom: [0.6, 1],
  bottomHalf: [0.45, 1],
  middle: [0.3, 0.75],
  top: [0, 0.4],
  full: [0, 1],
};

const BRIGHT = 190;     // text fill (white, yellow) is at least this bright
const DARK = 80;        // its outline / shadow / box is at most this dark
const WHITE = 215;      // a white outline around coloured letters is at least this bright
const FILL_DARKER = 30; // ...and the letters inside it are at least this much darker
const OUTLINE_R = 2;    // a letter's edge pixels lie within this many pixels of a dark one
const OUTLINED = 0.6;   // share of a letter's edge that must touch the outline
const LETTER_H = 0.12;  // a letter is at most this share of the video height high (and 4× that wide)
const FILL_SPREAD = 22; // letters are within this much of the subtitle's fill brightness
const CHANGE = 0.3;     // share of letters both removed and added between frames that makes a new subtitle
const KEEP_FRAMES = 32; // frames kept per track to pick the one sent to OCR
const MAX_SUBTITLE_SECONDS = 30;

// ─── Video info ──────────────────────────────────────────────────────────────

// Size (as displayed, after rotation) and duration from `ffmpeg -i` (ffmpeg-static has no ffprobe)
function probeVideo(videoPath, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-i', videoPath], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    const onAbort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', reject);
    proc.on('close', () => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(cancelledError());
      const size = err.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
      if (!size) return reject(new Error('Không đọc được kích thước video'));
      let width = Number(size[1]);
      let height = Number(size[2]);
      const rot = err.match(/rotation of (-?[\d.]+)|rotate\s*:\s*(-?\d+)/);
      if (rot && Math.abs(Number(rot[1] ?? rot[2])) % 180 === 90) [width, height] = [height, width];
      const dur = err.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
      resolve({ width, height, duration });
    });
  });
}

// ─── Text mask ───────────────────────────────────────────────────────────────

// Scratch buffers for one frame size, reused for every frame
function maskBuffers(w, h) {
  return {
    integral: new Uint32Array((w + 1) * (h + 1)),
    labels: new Int32Array(w * h),
    stack: new Int32Array(w * h),
    holeOwner: new Int32Array(w * h),
    innerHole: new Uint8Array(w * h),
    fillMask: new Uint8Array(w * h),
  };
}

// 4-connected patches of pixels at least `threshold` bright, written to `labels` (1, 2, ...).
// `nearDark` (optional) counts how many of a patch's edge pixels touch a dark outline.
function labelPatches(gray, w, h, threshold, { labels, stack }, nearDark) {
  labels.fill(0);
  const patches = [];
  let label = 0;
  for (let start = 0; start < w * h; start++) {
    if (labels[start] || gray[start] < threshold) continue;
    label++;
    labels[start] = label;
    stack[0] = start;
    let size = 1;
    let edges = 0, outlined = 0, sum = 0;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    for (let k = 0; k < size; k++) {
      const i = stack[k];
      const x = i % w, y = (i - x) / w;
      sum += gray[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      let edge = false;
      // Inlined neighbour visits: this loop runs for every bright pixel of every frame
      let n = i - 1;
      if (x > 0) { if (gray[n] < threshold) edge = true; else if (!labels[n]) { labels[n] = label; stack[size++] = n; } }
      n = i + 1;
      if (x < w - 1) { if (gray[n] < threshold) edge = true; else if (!labels[n]) { labels[n] = label; stack[size++] = n; } }
      n = i - w;
      if (y > 0) { if (gray[n] < threshold) edge = true; else if (!labels[n]) { labels[n] = label; stack[size++] = n; } }
      n = i + w;
      if (y < h - 1) { if (gray[n] < threshold) edge = true; else if (!labels[n]) { labels[n] = label; stack[size++] = n; } }
      if (edge) {
        edges++;
        if (nearDark?.(x, y)) outlined++;
      }
    }
    patches.push({ label, start, size, mean: sum / size, edges, outlined, minX, maxX, minY, maxY, height: maxY - minY + 1 });
  }
  return { patches, count: label };
}

// Letter-sized and not cut by the band's edge (that is background, or a subtitle outside the band)
function letterSized(p, h, letterMax) {
  return p.maxY - p.minY < letterMax && p.maxX - p.minX < letterMax * 4 && p.minY > 0 && p.maxY < h - 1;
}

// Typical letter height: tallest quarter, so dots, accents and kana parts do not pull it down
function typicalHeight(heights) {
  heights.sort((a, b) => a - b);
  return heights.length ? heights[Math.floor(heights.length * 0.75)] : 0;
}

// Light letters with a dark outline / shadow / box (white or yellow subtitles). A letter is a patch of bright
// pixels that is letter-sized and whose edge is mostly next to a dark pixel; bright background is too big or not
// outlined.
function darkOutlineMask(gray, w, h, letterMax, buffers, mask) {
  const { integral, labels } = buffers;
  const W1 = w + 1;
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x] <= DARK ? 1 : 0;
      integral[(y + 1) * W1 + x + 1] = integral[y * W1 + x + 1] + rowSum;
    }
  }
  const nearDark = (x, y) => {
    const x0 = Math.max(0, x - OUTLINE_R), x1 = Math.min(w, x + OUTLINE_R + 1);
    const y0 = Math.max(0, y - OUTLINE_R), y1 = Math.min(h, y + OUTLINE_R + 1);
    return integral[y1 * W1 + x1] - integral[y0 * W1 + x1] - integral[y1 * W1 + x0] + integral[y0 * W1 + x0] > 0;
  };

  const { patches: all, count: labelCount } = labelPatches(gray, w, h, BRIGHT, buffers, nearDark);
  const patches = all.filter((p) => p.size >= 4 && letterSized(p, h, letterMax) && p.outlined >= p.edges * OUTLINED);

  // Subtitle letters share one fill colour: drop patches far from the brightness most letter pixels have
  // (bright background caught between the outline and a dark area)
  const keep = new Uint8Array(labelCount + 1);
  const heights = [];
  if (patches.length) {
    const byMean = [...patches].sort((a, b) => a.mean - b.mean);
    let half = byMean.reduce((n, p) => n + p.size, 0) / 2;
    const fill = byMean.find((p) => (half -= p.size) <= 0).mean;
    for (const p of patches) {
      if (Math.abs(p.mean - fill) > FILL_SPREAD) continue;
      keep[p.label] = 1;
      heights.push(p.height);
    }
  }
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    mask[i] = keep[labels[i]];
    count += mask[i];
  }
  return { count, letterH: typicalHeight(heights) };
}

// Coloured letters with a white outline (common in Japanese videos: pink / red / blue text, white border).
// The white outline of each letter is a letter-sized ring; the letter is the darker pixels the ring encloses.
// A ring inside another letter's ring (around the counter of あ, の, o) encloses background, which is left out.
function whiteOutlineMask(gray, w, h, letterMax, buffers, mask) {
  const { labels, holeOwner, innerHole } = buffers;
  const { patches } = labelPatches(gray, w, h, WHITE, buffers);
  // Biggest first, so an outer ring claims its enclosed pixels before the rings inside it are looked at
  const rings = patches.filter((p) => p.size >= 8 && p.height >= 6 && letterSized(p, h, letterMax))
    .sort((a, b) => (b.maxX - b.minX) * (b.maxY - b.minY) - (a.maxX - a.minX) * (a.maxY - a.minY));

  holeOwner.fill(0);
  innerHole.fill(0);
  mask.fill(0);
  const outer = [];
  for (const r of rings) {
    // Enclosed = inside the ring's box but not reachable from the box's border without crossing the ring
    const bw = r.maxX - r.minX + 1, bh = r.maxY - r.minY + 1;
    const reached = new Uint8Array(bw * bh);
    const queue = [];
    const enter = (x, y) => {
      const k = y * bw + x;
      if (reached[k] || labels[(r.minY + y) * w + r.minX + x] === r.label) return;
      reached[k] = 1;
      queue.push(k);
    };
    for (let x = 0; x < bw; x++) { enter(x, 0); enter(x, bh - 1); }
    for (let y = 0; y < bh; y++) { enter(0, y); enter(bw - 1, y); }
    while (queue.length) {
      const k = queue.pop();
      const x = k % bw, y = (k - x) / bw;
      if (x > 0) enter(x - 1, y);
      if (x < bw - 1) enter(x + 1, y);
      if (y > 0) enter(x, y - 1);
      if (y < bh - 1) enter(x, y + 1);
    }
    const holes = [];
    for (let k = 0; k < bw * bh; k++) {
      const i = (r.minY + Math.floor(k / bw)) * w + r.minX + (k % bw);
      if (!reached[k] && labels[i] !== r.label) holes.push(i);
    }
    if (holeOwner[r.start]) {
      // An inner ring: what it encloses is a counter (background), not letter
      for (const i of holes) innerHole[i] = 1;
      continue;
    }
    for (const i of holes) if (!holeOwner[i]) holeOwner[i] = r.label;
    outer.push({ ring: r, holes });
  }

  let count = 0;
  const heights = [];
  for (const { ring, holes } of outer) {
    const fill = holes.filter((i) => holeOwner[i] === ring.label && !innerHole[i] && gray[i] < WHITE);
    if (fill.length < ring.size * 0.2) continue; // a white patch with no letter inside
    const fillMean = fill.reduce((n, i) => n + gray[i], 0) / fill.length;
    if (fillMean > ring.mean - FILL_DARKER) continue;
    for (const i of fill) mask[i] = 1;
    count += fill.length;
    heights.push(ring.height);
  }
  return { count, letterH: typicalHeight(heights) };
}

// 1 on the letters of the subtitle, in whichever style finds more letter pixels in this frame.
// `mode` tells blockImage how to draw them.
function textMask(gray, w, h, letterMax, buffers, mask) {
  const dark = darkOutlineMask(gray, w, h, letterMax, buffers, mask);
  const white = whiteOutlineMask(gray, w, h, letterMax, buffers, buffers.fillMask);
  if (white.count > dark.count) {
    mask.set(buffers.fillMask);
    return { ...white, mode: 'whiteOutline' };
  }
  return { ...dark, mode: 'darkOutline' };
}

// Text blocks: letters grouped on a grid of half-letter cells, where cells up to two apart join (the gaps
// between letters and words). Lines of one subtitle stacked above each other are joined afterwards.
// Subtitles in different places (left / right, top / bottom) stay separate blocks.
function findBlocks(gray, mask, w, h, letterH) {
  const cell = Math.max(2, Math.round(letterH * 0.5));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const on = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const row = ((y / cell) | 0) * gw;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) on[row + ((x / cell) | 0)] = 1;
  }

  const seen = new Uint8Array(gw * gh);
  let blocks = [];
  for (let c = 0; c < gw * gh; c++) {
    if (!on[c] || seen[c]) continue;
    seen[c] = 1;
    const stack = [c];
    let gx0 = gw, gx1 = 0, gy0 = gh, gy1 = 0;
    while (stack.length) {
      const k = stack.pop();
      const gx = k % gw, gy = (k - gx) / gw;
      gx0 = Math.min(gx0, gx); gx1 = Math.max(gx1, gx);
      gy0 = Math.min(gy0, gy); gy1 = Math.max(gy1, gy);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const n = ny * gw + nx;
          if (on[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    blocks.push({ x0: gx0 * cell, y0: gy0 * cell, x1: Math.min(w, (gx1 + 1) * cell), y1: Math.min(h, (gy1 + 1) * cell) });
  }

  // Lines of one subtitle: overlapping columns, less than a letter and a half apart. Parts of one line:
  // mostly the same rows, less than two letters apart (a gap at "、" or a dropped comma).
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const a = blocks[i], b = blocks[j];
        const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        const gapY = -overlapY;
        const sameLine = overlapY > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0) && -overlapX < letterH * 2;
        if ((overlapX > 0 && gapY < letterH * 1.5) || sameLine) {
          blocks[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
          blocks.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  // Keep only blocks with enough text pixels for a character
  const minPixels = Math.max(20, letterH * letterH * 0.15);
  return blocks.map((b) => cropBlock(gray, mask, w, b, letterH)).filter((b) => b.count >= minPixels);
}

// A block's mask and grayscale pixels, cut out of the frame
function cropBlock(gray, mask, w, { x0, y0, x1, y1 }, letterH) {
  const bw = x1 - x0, bh = y1 - y0;
  const crop = new Uint8Array(bw * bh);
  const grayCrop = new Uint8Array(bw * bh);
  let count = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = (y0 + y) * w + x0 + x;
      crop[y * bw + x] = mask[i];
      grayCrop[y * bw + x] = gray[i];
      count += mask[i];
    }
  }
  return { x0, y0, x1, y1, crop, grayCrop, count, letterH };
}

const area = (b) => (b.x1 - b.x0) * (b.y1 - b.y0);
const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

function intersection(a, b) {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
}

// How much two boxes overlap, as a share of the smaller one (a piece of a subtitle overlaps it fully)
function overlapRatio(a, b) {
  return intersection(a, b) / Math.max(1, Math.min(area(a), area(b)));
}

// How much a block's text changed, compared in frame coordinates. Letters that only disappeared (part of the line
// lost against the background for a moment) or only appeared (text typing in) are the same subtitle; a new
// subtitle in the same place both removes and adds letters.
function blockChange(a, b) {
  const pixel = (blk, x, y) => (x >= blk.x0 && x < blk.x1 && y >= blk.y0 && y < blk.y1
    ? blk.crop[(y - blk.y0) * (blk.x1 - blk.x0) + (x - blk.x0)] : 0);
  let added = 0, removed = 0;
  for (let y = Math.min(a.y0, b.y0); y < Math.max(a.y1, b.y1); y++) {
    for (let x = Math.min(a.x0, b.x0); x < Math.max(a.x1, b.x1); x++) {
      const pa = pixel(a, x, y), pb = pixel(b, x, y);
      if (pb && !pa) added++;
      else if (pa && !pb) removed++;
    }
  }
  return Math.min(added, removed) / Math.max(a.count, b.count, 1);
}

// Dark text on white, for the OCR engine. The letters and the pixels just around them keep their real
// (inverted) brightness, so the anti-aliased edges survive; everything else is white. Small text is enlarged
// smoothly: tesseract reads letters best at 30–40 px high.
function blockImage({ crop, grayCrop, x0, x1, y0, y1, letterH, mode }) {
  const bw = x1 - x0, bh = y1 - y0;
  const R = 2;
  const src = new Float32Array(bw * bh).fill(255);
  // Coloured letters with a white outline: the letter mask itself (their brightness says little)
  if (mode === 'whiteOutline') for (let i = 0; i < bw * bh; i++) src[i] = crop[i] ? 0 : 255;
  else for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let near = false;
      for (let dy = -R; dy <= R && !near; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= bh) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < bw && crop[yy * bw + xx]) {
            near = true;
            break;
          }
        }
      }
      if (near) src[y * bw + x] = 255 - grayCrop[y * bw + x];
    }
  }

  const scale = Math.max(1, Math.min(4, 36 / Math.max(letterH, 1)));
  const sw = Math.max(1, Math.round(bw * scale)), sh = Math.max(1, Math.round(bh * scale));
  const pad = 20;
  const cw = sw + pad * 2, ch = sh + pad * 2;
  const img = Buffer.alloc(cw * ch, 255);
  for (let y = 0; y < sh; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0i = Math.floor(fy), y1i = Math.min(bh - 1, y0i + 1), ty = fy - y0i;
    for (let x = 0; x < sw; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / scale - 0.5));
      const x0i = Math.floor(fx), x1i = Math.min(bw - 1, x0i + 1), tx = fx - x0i;
      const v = (src[y0i * bw + x0i] * (1 - tx) + src[y0i * bw + x1i] * tx) * (1 - ty)
        + (src[y1i * bw + x0i] * (1 - tx) + src[y1i * bw + x1i] * tx) * ty;
      img[(y + pad) * cw + x + pad] = Math.round(v);
    }
  }
  return { w: cw, h: ch, px: img };
}

// Binary PGM: tesseract reads PNM
function toPgm({ w, h, px }) {
  return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`, 'ascii'), px]);
}

// 8-bit grayscale PNG: Ollama only takes PNG / JPEG. (zlib.crc32 needs Node 20.15; Electron 31 ships 20.14.)
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function toPng({ w, h, px }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((w + 1) * h); // each row starts with filter type 0
  for (let y = 0; y < h; y++) px.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Text clean-up and merging ───────────────────────────────────────────────

const CJK = '\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af\\u0e00-\\u0e7f';

function cleanText(text, lang) {
  // One kana / hanzi / hangul syllable is a word; a single Latin letter is usually a stray mark from the background
  const minLetters = ['ja', 'zh', 'ko'].includes(lang) ? 1 : 2;
  let lines = text.split('\n')
    .map((l) => l.replace(/[|_~`]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => (l.match(/\p{L}/gu) || []).length >= minLetters);
  if (['ja', 'zh', 'th'].includes(lang)) {
    // tesseract puts spaces between CJK / Thai characters
    const between = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, 'gu');
    lines = lines.map((l) => l.replace(between, ''));
  }
  if (['ja', 'zh'].includes(lang)) {
    // 一 (one) read as the long-vowel mark ー: only kana are lengthened
    lines = lines.map((l) => l.replace(/(?<![\u3040-\u30ff])ー(?=[\u3400-\u9fff])/gu, '一'));
    // ...and the other way round: a word does not end in 一, but "見てるー？" / "郁美ー！" do end in ー
    lines = lines.map((l) => l.replace(/(?<=[぀-ヿ㐀-鿿])一(?=$|[\s?!？！。、…~〜）)」』])/gu, 'ー'));
    // No space before punctuation in CJK text ("見てるー ?")
    lines = lines.map((l) => l.replace(/\s+(?=[?!？！。、…])/gu, ''));
  }
  return lines.join('\n');
}

function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// 1 = same text, 0 = nothing in common (Levenshtein on letters and digits only)
function similarity(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a.length || !b.length) return a === b ? 1 : 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

// While a subtitle types in or fades, part of it can be tracked on its own for a moment. A piece that sits inside
// a longer reading shown at the same time is such a part.
function dropFragments(segments) {
  const len = (seg) => normalize(seg.text).length;
  return segments.filter((seg) => !segments.some((o) => {
    if (o === seg || len(o) <= len(seg)) return false;
    const overlap = Math.min(o.endTime, seg.endTime) - Math.max(o.startTime, seg.startTime);
    return overlap >= 0.5 * (seg.endTime - seg.startTime)
      && seg.x >= o.box.x0 - 2 && seg.x <= o.box.x1 + 2 && seg.y >= o.box.y0 - 2 && seg.y <= o.box.y1 + 2;
  }));
}

// Fades and flicker split one subtitle into several stretches that OCR reads the same (or almost);
// segments must also be in the same place, since two subtitles may be on screen at once
function mergeSegments(segments) {
  const out = [];
  for (const seg of segments) {
    const last = out.slice(-8).reverse().find((o) => seg.startTime - o.endTime <= 1
      && Math.abs(o.x - seg.x) < 10 && Math.abs(o.y - seg.y) < 10 && similarity(o.text, seg.text) >= 0.75);
    if (last) {
      // Keep the reading from the longer stretch: it had the clearest frame
      if (seg.endTime - seg.startTime > last.endTime - last.startTime) last.text = seg.text;
      last.endTime = seg.endTime;
      continue;
    }
    out.push({ ...seg });
  }
  return out;
}

// ─── Tesseract ───────────────────────────────────────────────────────────────

// Inside the packaged app the worker script must be loaded from app.asar.unpacked (see package.json asarUnpack)
function workerPath() {
  const p = path.join(path.dirname(require.resolve('tesseract.js/package.json')), 'src', 'worker-script', 'node', 'index.js');
  const unpacked = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpacked) ? unpacked : p;
}

async function createOcrWorker(lang, onProgress) {
  const { createWorker, PSM } = require('tesseract.js');
  const cachePath = path.join(CACHE_DIR, OCR_DIR);
  fs.mkdirSync(cachePath, { recursive: true });
  const worker = await createWorker(TESS_LANGS[lang], 1, {
    cachePath,
    workerPath: workerPath(),
    logger: (m) => {
      if (m.status === 'loading language traineddata' && m.progress < 1) {
        onProgress?.({ status: 'loading', message: `Đang tải dữ liệu đọc chữ (${TESS_LANGS[lang]})...`, percent: Math.round(m.progress * 100) });
      }
    },
  });
  // A subtitle is one block of 1–3 lines
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
  return worker;
}

// ─── Ollama vision ───────────────────────────────────────────────────────────

// Installed Ollama models that can look at images
async function listVisionModels() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const { models = [] } = await res.json();
    const vision = [];
    for (const m of models) {
      const show = await fetch(`${OLLAMA_URL}/api/show`, {
        method: 'POST',
        body: JSON.stringify({ model: m.name }),
        signal: AbortSignal.timeout(5000),
      }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      // Older Ollama versions have no `capabilities`; their vision models carry a CLIP / mllama projector
      const families = show.details?.families || m.details?.families || [];
      if (show.capabilities?.includes('vision') || families.some((x) => /clip|mllama/i.test(x))) vision.push(m.name);
    }
    return vision;
  } catch (_) {
    return [];
  }
}

// The writing system a reading must contain for the chosen language (a vision model describes the picture
// instead of reading it when there is no text)
const SCRIPTS = {
  ja: /[\u3040-\u30ff\u3400-\u9fff]/u, zh: /[\u3400-\u9fff]/u, ko: /[\uac00-\ud7af]/u,
  ru: /[\u0400-\u04ff]/u, th: /[\u0e00-\u0e7f]/u,
};

function ollamaReader(language, model, signal) {
  let name = language;
  try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || language; } catch (_) {}
  const prompt = `This image is one subtitle cut out of a video. Transcribe the ${name} text exactly as written, `
    + 'character by character, keeping its line breaks. Do not translate, correct, complete, soften or explain anything. '
    + 'If there is no readable text, reply with nothing.';
  const body = (img) => JSON.stringify({
    model,
    stream: false,
    keep_alive: '10m',
    options: { temperature: 0, num_predict: 200 },
    messages: [{ role: 'user', content: prompt, images: [toPng(img).toString('base64')] }],
  });
  return async (img) => {
    let res;
    // Ollama now and then fails one request on the GPU (CUDA error) and serves the next one fine
    for (let attempt = 1; ; attempt++) {
      res = await fetch(`${OLLAMA_URL}/api/chat`, { method: 'POST', body: body(img), signal }).catch((err) => {
        if (signal?.aborted || attempt >= 2) throw err;
        return null;
      });
      if (res?.ok || attempt >= 2) break;
    }
    if (!res.ok) throw new Error(`Ollama lỗi ${res.status}: ${await res.text()}`);
    const text = ((await res.json()).message?.content || '').replace(/^```\w*\n?|```$/g, '').trim();
    if (SCRIPTS[language] && !SCRIPTS[language].test(text)) return '';
    return text;
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

// engine: 'tesseract' (built in) or 'ollama' (ollamaModel must be a vision model)
async function ocrVideo({ videoPath, language = 'en', region = 'bottom', engine = 'tesseract', ollamaModel }, onProgress, { signal } = {}) {
  if (!TESS_LANGS[language]) return { success: false, error: `Chưa hỗ trợ đọc chữ ${language}` };
  if (engine === 'ollama' && !ollamaModel) return { success: false, error: 'Chưa chọn model Ollama để đọc chữ' };
  const [top, bottom] = REGIONS[region] || REGIONS.bottom;
  let worker = null;
  let proc = null;
  const onAbort = () => proc?.kill('SIGKILL');

  try {
    onProgress?.({ status: 'loading', message: 'Đang chuẩn bị đọc chữ trên video...', percent: 0 });
    const info = await probeVideo(videoPath, signal);
    let read;
    if (engine === 'ollama') {
      read = ollamaReader(language, ollamaModel, signal);
    } else {
      worker = await createOcrWorker(language, onProgress);
      read = async (img) => {
        const { data } = await worker.recognize(toPgm(img));
        return data.confidence >= 35 ? data.text || '' : '';
      };
    }
    throwIfCancelled(signal);

    const w = Math.min(MAX_WIDTH, info.width) & ~1;
    const h = Math.max(2, Math.round((info.height * (bottom - top) * w) / info.width) & ~1);
    const frameSize = w * h;
    const vf = `fps=${FPS},crop=iw:ih*${bottom - top}:0:ih*${top},scale=${w}:${h},format=gray`;
    proc = spawn(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-an', '-vf', vf, '-f', 'rawvideo', 'pipe:1'],
      { windowsHide: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    let ffmpegError = '';
    proc.stderr.on('data', (d) => { ffmpegError += d; });
    const exited = new Promise((resolve) => proc.on('close', resolve));

    const buffers = maskBuffers(w, h);
    const letterMax = Math.max(8, Math.round((LETTER_H * info.height * w) / info.width));
    // Open tracks: one per text block on screen, { box (latest), extent (all boxes), start, last (frame index),
    // frames, stride, seen }
    let tracks = [];
    const segments = [];
    let ocrQueue = Promise.resolve();
    let pendingOcr = 0;

    const readTrack = (t) => {
      // Ignore flashes of a single frame
      if (t.seen < 2) return;
      // The frame with the most text: subtitles that type in letter by letter are complete only at the end
      const block = [...t.frames, t.box].reduce((best, b) => (b.count > best.count ? b : best));
      const endTime = (t.last + 1) / FPS;
      // Where it was on screen, in % of the whole video (the band starts at `top`)
      const toX = (px) => (px / w) * 100;
      const toY = (py) => (top + (py / h) * (bottom - top)) * 100;
      const box = { x0: toX(block.x0), x1: toX(block.x1), y0: toY(block.y0), y1: toY(block.y1) };
      const x = (box.x0 + box.x1) / 2;
      const y = (box.y0 + box.y1) / 2;
      const img = blockImage(block);
      pendingOcr++;
      ocrQueue = ocrQueue.then(async () => {
        try {
          if (signal?.aborted) return;
          const text = cleanText(await read(img), language);
          if (text) segments.push({ startTime: t.start / FPS, endTime, text, x, y, box });
        } finally {
          pendingOcr--;
        }
      });
    };

    let frameIndex = 0;
    let buf = Buffer.alloc(0);
    let lastReport = 0;
    const mask = new Uint8Array(frameSize);
    for await (const chunk of proc.stdout) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= frameSize) {
        const gray = buf.subarray(0, frameSize);
        const { count, letterH, mode } = textMask(gray, w, h, letterMax, buffers, mask);
        let blocks = count && letterH ? findBlocks(gray, mask, w, h, letterH) : [];
        // Pieces of one subtitle (its middle lost against the background in this frame) inside the area an open
        // track has covered are one block again
        for (const t of tracks) {
          const inside = blocks.filter((b) => intersection(t.extent, b) >= 0.6 * area(b));
          if (inside.length < 2) continue;
          const joined = cropBlock(gray, mask, w, inside.reduce(union), letterH);
          blocks = [...blocks.filter((b) => !inside.includes(b)), joined];
        }
        for (const b of blocks) b.mode = mode;
        buf = buf.subarray(frameSize);

        // Each block continues the open track in the same place if its text did not change, or starts a new one
        const matched = new Set();
        for (const b of blocks) {
          let best = null;
          let bestOverlap = 0.3;
          for (const t of tracks) {
            const o = matched.has(t) ? 0 : overlapRatio(t.extent, b);
            if (o > bestOverlap) {
              best = t;
              bestOverlap = o;
            }
          }
          if (best && blockChange(best.box, b) <= CHANGE) {
            best.box = b;
            best.extent = union(best.extent, b);
            best.last = frameIndex;
            // Keep at most KEEP_FRAMES evenly spread frames of a long track
            if (best.seen % best.stride === 0) {
              best.frames.push(b);
              if (best.frames.length > KEEP_FRAMES) {
                best.frames = best.frames.filter((_, i) => i % 2 === 0);
                best.stride *= 2;
              }
            }
            best.seen++;
            matched.add(best);
            continue;
          }
          if (best) {
            tracks = tracks.filter((t) => t !== best);
            readTrack(best);
          }
          const t = { box: b, extent: union(b, b), start: frameIndex, last: frameIndex, frames: [b], stride: 1, seen: 1 };
          tracks.push(t);
          matched.add(t);
        }
        // A track missing for two frames in a row has ended (one missed frame is compression flicker)
        tracks = tracks.filter((t) => {
          if (matched.has(t) || frameIndex - t.last < 2) return true;
          readTrack(t);
          return false;
        });
        frameIndex++;
      }
      throwIfCancelled(signal);

      // Let OCR catch up instead of holding many tracks in memory
      if (pendingOcr > 6) await ocrQueue;
      if (Date.now() - lastReport > 300) {
        lastReport = Date.now();
        const done = frameIndex / FPS;
        onProgress?.({
          status: 'ocr',
          message: `Đang đọc chữ trên video... ${Math.floor(done)}s / ${Math.floor(info.duration)}s · ${segments.length} câu`,
          percent: info.duration ? Math.min(99, Math.round((done / info.duration) * 100)) : 0,
        });
      }
    }
    tracks.forEach(readTrack);
    const code = await exited;
    throwIfCancelled(signal);
    if (code !== 0 && frameIndex === 0) throw new Error(ffmpegError.trim() || `ffmpeg exited with code ${code}`);
    await ocrQueue;
    throwIfCancelled(signal);

    // Same shape as Whisper's subtitles (whisper.js buildSubtitles); the renderer applies the user's style on top
    const subtitles = mergeSegments(dropFragments(segments).sort((a, b) => a.startTime - b.startTime))
      // Text that stays for this long is a logo, watermark or caption of the video, not a subtitle
      .filter((s) => s.endTime - s.startTime <= MAX_SUBTITLE_SECONDS)
      .map((s) => ({
        id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        startTime: s.startTime,
        endTime: s.endTime,
        text: s.text,
        // Placed where the original was, so subtitles that move around the picture keep their place
        x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10, fontSize: 24, fontFamily: 'Montserrat', color: '#ffffff', hasBox: false,
        backgroundColor: '#000000', bold: true, italic: false, outlineColor: '#000000', outlineWidth: 2,
      }));
    onProgress?.({ status: 'done', message: `Đã đọc được ${subtitles.length} câu`, percent: 100 });
    return { success: true, subtitles, language };
  } catch (err) {
    if (err.cancelled || signal?.aborted) return { success: false, cancelled: true, error: cancelledError().message };
    return { success: false, error: err.message };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { proc?.kill('SIGKILL'); } catch (_) {}
    await worker?.terminate().catch(() => {});
  }
}

module.exports = { ocrVideo, listVisionModels, OCR_DIR, TESS_LANGS, REGIONS, cleanText, similarity, mergeSegments };
