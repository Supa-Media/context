/**
 * The web addresses a PDF's links and buttons go to.
 *
 * `toMarkdown` hands back a PDF's words and drops its link annotations, so a
 * contract's "CLICK HERE to make payment" button reached the model as those
 * words and nothing else, and Tex told the person to open the PDF and tap it
 * themselves (Dev, 2026-10-20: "another stupid text limitation"). A link is a
 * `/URI` action in the file: written as a plain or hex string, either in the
 * open or inside a compressed object stream. Both are read here, with no
 * dependency (`DecompressionStream`, which Workers and Node both have).
 *
 * Bounded throughout: a file is at most `MAX_FILE_BYTES` already, a picture
 * or a font is never inflated, inflating stops past `MAX_INFLATED_BYTES`, and
 * at most `MAX_LINKS` addresses come back. What comes back is the file's
 * author's, so it is a quotation like the file's words (`readFile.js`).
 */

export const MAX_LINKS = 50;
export const MAX_INFLATED_BYTES = 20 * 1024 * 1024;
const MAX_URL_CHARS = 2_000;
/** How far back from `stream` a stream's dictionary is looked for. */
const DICT_LOOKBACK = 2_000;

/** Bytes as one char per byte, the way PDF syntax is written. */
function latin1(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

/** A PDF literal string's escapes, undone (`\(`, `\)`, `\\`, `\n`, octal). */
function literal(raw) {
  return raw.replace(/\\(?:([0-7]{1,3})|(\r\n|\r|\n)|(.))/g, (_, octal, newline, ch) => {
    if (octal) return String.fromCharCode(parseInt(octal, 8) & 0xff);
    if (newline) return "";
    return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[ch] ?? ch;
  });
}

function hex(raw) {
  const digits = raw.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i < digits.length; i += 2) out += String.fromCharCode(parseInt(digits.slice(i, i + 2).padEnd(2, "0"), 16));
  return out;
}

/** A string PDF wrote as UTF-16 (it starts with a byte-order mark) read as text; anything else as it is. */
function text(s) {
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return out;
  }
  return s;
}

const URI = /\/URI\s*(?:\(((?:\\[\s\S]|[^\\)])*)\)|<([0-9A-Fa-f\s]*)>)/g;

function urisIn(source, found) {
  for (const match of source.matchAll(URI)) {
    const value = text(match[1] !== undefined ? literal(match[1]) : hex(match[2])).trim();
    if (value.length === 0 || value.length > MAX_URL_CHARS) continue;
    if (!/^(https?:\/\/|mailto:)/i.test(value)) continue;
    if (/[\u0000-\u001f\s]/.test(value)) continue;
    found.add(value);
    if (found.size >= MAX_LINKS) return;
  }
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  try {
    while (size <= MAX_INFLATED_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.byteLength;
    }
  } catch {
    // A stream cut short still gives up what it held before the break.
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * Every web or mail address a PDF links to, in the order the file has them.
 * Never throws: a file it cannot make sense of has no links.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string[]>}
 */
export async function pdfLinks(bytes) {
  const found = new Set();
  try {
    const source = latin1(bytes);
    urisIn(source, found);
    let inflated = 0;
    const streams = /stream\r?\n/g;
    for (let match = streams.exec(source); match !== null && found.size < MAX_LINKS; match = streams.exec(source)) {
      const start = match.index + match[0].length;
      const end = source.indexOf("endstream", start);
      if (end === -1) break;
      streams.lastIndex = end + "endstream".length;
      const dict = source.slice(Math.max(0, match.index - DICT_LOOKBACK), match.index);
      const own = dict.slice(dict.lastIndexOf("obj") + 1);
      if (!/\/FlateDecode/.test(own) || /\/Subtype\s*\/Image|\/FontFile|\/Length1/.test(own)) continue;
      if (inflated > MAX_INFLATED_BYTES) break;
      const plain = await inflate(bytes.subarray(start, end));
      inflated += plain.byteLength;
      urisIn(latin1(plain), found);
    }
  } catch {
    // Best effort: the words are still read.
  }
  return [...found].slice(0, MAX_LINKS);
}

/** The lines `read_file` adds under a PDF's words, or nothing when it links nowhere. */
export function linksSection(links) {
  if (links.length === 0) return "";
  return `\n\nLinks in this file (where its buttons and linked words go):\n${links.map((link) => `- ${link}`).join("\n")}`;
}
