// Subtitle file parser for SRT, WebVTT and ASS/SSA — plain ESM with no Electron/React dependency,
// so it runs in the renderer and can be tested with node directly.
//
// parseSubtitles(text, fileName?) → { format, cues: [{ start, end, text }], stats }
//   start/end in seconds (rounded to ms), text with '\n' line breaks, cues sorted by start time.
//   stats: { parsed, dropped: { empty, badTime }, fixedTimes } — badTime also counts "-->" lines that are not valid timings
//
// Every regex here must stay linear on hostile input (a 10 MB file is accepted): no character class
// that can re-scan across the delimiter it is looking for (REV-01: `{\` repeated 200 000 times took 21 s).

const FIXED_DURATION_S = 2; // length given to a cue whose end is not after its start

// h:mm:ss,ttt · hh:mm:ss.ttt · mm:ss.ttt (VTT without hours) · ':' as separator · any number of fraction
// digits (only milliseconds are kept: 01,1234 → 1.123)
const TS = '(?:(\\d+):)?(\\d{1,2}):(\\d{1,2})(?:[.,:](\\d+))?';
const TIME_LINE = new RegExp(`^\\s*${TS}\\s*-->\\s*${TS}(?:\\s|$)`);

function toSeconds(h, m, s, frac) {
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
  return (Number(h) || 0) * 3600 + Number(m) * 60 + Number(s) + ms / 1000;
}

const round = (t) => Math.round(t * 1000) / 1000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch (_) {
        return m;
      }
    }
    const v = ENTITIES[name.toLowerCase()];
    return v === undefined ? m : v;
  });
}

// <i> <b> <u> <font …> <c.class> <v Speaker> <ruby> … and VTT timestamp tags <00:01.000>; ASS overrides {\an8}
// left in SRT files. "a < b" or "<3" are not tags and stay.
function stripTags(line) {
  return line
    .replace(/\{\\[^{}]*\}/g, '')
    .replace(/<\/?[a-z][^<>]*>/gi, '')
    .replace(/<\d[\d:.]*>/g, '');
}

function cleanLines(lines) {
  return lines
    .map((l) => decodeEntities(stripTags(l)).replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// ─── SRT / WebVTT ────────────────────────────────────────────────────────────
// Line by line rather than by blank-line blocks, so a missing blank line or a missing/wrong index still parses.

function parseSrtVtt(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const cues = [];
  let cue = null;
  let skipBlock = false; // inside a WEBVTT header, NOTE, STYLE or REGION block

  const close = () => {
    if (cue) cues.push(cue);
    cue = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      close();
      skipBlock = false;
      continue;
    }

    const m = TIME_LINE.exec(line);
    if (m) {
      // No blank line before this cue: the previous cue swallowed this cue's index number
      if (cue && cue.lines.length && /^\d+$/.test(cue.lines[cue.lines.length - 1].trim())) cue.lines.pop();
      close();
      skipBlock = false;
      cue = { start: toSeconds(m[1], m[2], m[3], m[4]), end: toSeconds(m[5], m[6], m[7], m[8]), lines: [] };
      continue;
    }
    if (skipBlock) continue;

    // A cue header that is not a valid timing ("00:00:01 --> soon"): counted as dropped, its text skipped
    if (line.includes('-->')) {
      close();
      cues.push({ start: NaN, end: NaN, lines: [] });
      skipBlock = true;
      continue;
    }

    if (!cue) {
      // Outside a cue: SRT index, VTT cue identifier, or a block that is not a cue
      if (/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(trimmed)) skipBlock = true;
      continue;
    }
    cue.lines.push(line);
  }
  close();

  return cues.map((c) => ({ start: c.start, end: c.end, text: cleanLines(c.lines) }));
}

// ─── ASS / SSA ───────────────────────────────────────────────────────────────
// Only [Events] Dialogue lines; the column order comes from the section's Format line. Styles are not imported.

const DEFAULT_ASS_FORMAT = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

function parseAssTime(s) {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?\s*$/.exec(s ?? '');
  return m ? toSeconds(m[1], m[2], m[3], m[4]) : NaN;
}

// Split into at most n fields; the last one keeps its commas (the Text field)
function splitFields(s, n) {
  const out = [];
  let rest = s;
  while (out.length < n - 1) {
    const i = rest.indexOf(',');
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  out.push(rest);
  return out;
}

function cleanAssText(text) {
  // Drop override blocks {\…}; text between {\p1} and {\p0} is a vector drawing, not words
  let out = '';
  let drawing = false;
  // [^{}]: an unclosed "{" cannot make every later "{" re-scan to the end of the line (REV-01)
  for (const token of text.split(/(\{[^{}]*\})/)) {
    if (token.startsWith('{') && token.endsWith('}')) {
      const p = /\\p(\d+)/.exec(token);
      if (p) drawing = Number(p[1]) > 0;
      continue;
    }
    if (!drawing) out += token;
  }
  out = out.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ');
  return cleanLines(out.split('\n'));
}

function parseAss(text) {
  const cues = [];
  let section = '';
  let format = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (/^\[[^\]]+\]$/.test(line)) {
      section = line.toLowerCase();
      continue;
    }
    if (section !== '[events]') continue;
    const m = /^([A-Za-z]+)\s*:\s?(.*)$/.exec(raw.replace(/^\s+/, ''));
    if (!m) continue;
    const kind = m[1].toLowerCase();
    if (kind === 'format') {
      format = m[2].split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    if (kind !== 'dialogue') continue; // Comment, Picture, Sound, Movie, Command

    const fields = format && format.includes('text') ? format : DEFAULT_ASS_FORMAT;
    const parts = splitFields(m[2], fields.length);
    const get = (name) => parts[fields.indexOf(name)];
    cues.push({ start: parseAssTime(get('start')), end: parseAssTime(get('end')), text: cleanAssText(get('text') ?? '') });
  }
  return cues;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function detectFormat(text, fileName = '') {
  const ext = (/\.([^.\\/]+)$/.exec(fileName)?.[1] || '').toLowerCase();
  if (/^\s*\[Script Info\]/im.test(text.slice(0, 4000)) || (/^\s*\[Events\]/im.test(text) && /^\s*Dialogue\s*:/im.test(text))) return 'ass';
  if (/^\s*WEBVTT/.test(text)) return 'vtt';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  if (ext === 'vtt') return 'vtt';
  return 'srt';
}

export function parseSubtitles(text, fileName = '') {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const format = detectFormat(source, fileName);
  const raw = format === 'ass' ? parseAss(source) : parseSrtVtt(source);

  const stats = { parsed: raw.length, dropped: { empty: 0, badTime: 0 }, fixedTimes: 0 };
  const cues = [];
  for (const c of raw) {
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end)) {
      stats.dropped.badTime++;
      continue;
    }
    if (!c.text) {
      stats.dropped.empty++;
      continue;
    }
    cues.push({ start: c.start, end: c.end, text: c.text });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);

  // end <= start: give it a short duration that does not run into the next cue. The next later start
  // is found in one backward pass over the sorted list (REV-02: a find() per cue was O(n²)).
  let nextStart = Infinity;
  for (let i = cues.length - 1; i >= 0; i--) {
    const c = cues[i];
    if (i + 1 < cues.length && cues[i + 1].start > c.start) nextStart = cues[i + 1].start;
    if (c.end > c.start) continue;
    c.end = c.start + Math.min(FIXED_DURATION_S, nextStart - c.start);
    stats.fixedTimes++;
  }
  for (const c of cues) {
    c.start = round(c.start);
    c.end = round(c.end);
  }
  return { format, cues, stats };
}
