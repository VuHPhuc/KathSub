// Reading a subtitle file picked by the user: size limit and text decoding.
// Parsing happens in the renderer (src/utils/subtitleParser.js); this only turns bytes into a string.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 10 * 1024 * 1024; // a 2-hour film is ~100-300 KB; anything this big is not a subtitle file

function tryDecode(encoding, buf) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buf);
  } catch (_) {
    return null;
  }
}

const count = (s, re) => (s.match(re) || []).length;
const nonAscii = (s) => s.replace(/[\x00-\x7f]/g, '');

// BOM-less UTF-16: ASCII-heavy subtitle text then has a zero in every other byte
function sniffUtf16(buf) {
  const n = Math.min(buf.length - (buf.length % 2), 2000);
  if (n < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) evenZero++;
    if (buf[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero / pairs > 0.3 && evenZero / pairs < 0.05) return 'utf-16le';
  if (evenZero / pairs > 0.3 && oddZero / pairs < 0.05) return 'utf-16be';
  return null;
}

// Legacy code pages, tried only when the bytes are not valid UTF-8. Every candidate is checked by
// what it produces: Japanese has kana, Chinese has mostly Han, Vietnamese windows-1258 uses
// combining tone marks (bytes CC EC D2 DE F2); anything else is read as Western windows-1252.
function decodeLegacy(buf) {
  const sjis = tryDecode('shift_jis', buf);
  if (sjis) {
    const na = nonAscii(sjis);
    if (na.length && count(na, /[぀-ヿ]/g) / na.length >= 0.2) return { text: sjis, encoding: 'shift_jis' };
  }
  const gb = tryDecode('gb18030', buf);
  if (gb) {
    const na = nonAscii(gb);
    if (na.length && count(na, /[一-鿿]/g) / na.length >= 0.6) return { text: gb, encoding: 'gb18030' };
  }
  let high = 0;
  let tones = 0;
  for (const b of buf) {
    if (b < 0x80) continue;
    high++;
    if (b === 0xcc || b === 0xec || b === 0xd2 || b === 0xde || b === 0xf2) tones++;
  }
  if (tones >= 3 && tones / high >= 0.15) {
    return { text: new TextDecoder('windows-1258').decode(buf).normalize('NFC'), encoding: 'windows-1258' };
  }
  return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' };
}

function decodeSubtitleBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }
  const utf16 = sniffUtf16(buf);
  if (utf16) return { text: new TextDecoder(utf16).decode(buf), encoding: utf16 };

  const utf8 = tryDecode('utf-8', buf);
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' };
  return decodeLegacy(buf);
}

// → { success: true, content, fileName, encoding }
//   | { success: false, code: 'notFile' | 'tooLarge' | 'empty' | 'read', error } — the renderer words it per UI language
async function readSubtitleFile(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return { success: false, code: 'notFile', error: 'Not a file' };
    if (stat.size > MAX_BYTES) return { success: false, code: 'tooLarge', error: `File too large (${(stat.size / 1048576).toFixed(1)} MB)`, maxMB: MAX_BYTES / 1048576 };
    if (stat.size === 0) return { success: false, code: 'empty', error: 'Empty file' };
    const buf = await fs.promises.readFile(filePath);
    const { text, encoding } = decodeSubtitleBuffer(buf);
    return { success: true, content: text, fileName: path.basename(filePath), encoding };
  } catch (err) {
    return { success: false, code: 'read', detail: err.code || err.message, error: err.message };
  }
}

module.exports = { readSubtitleFile, decodeSubtitleBuffer, MAX_BYTES };
