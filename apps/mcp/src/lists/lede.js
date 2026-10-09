/**
 * A note's first paragraph, as plain words: what a folder page draws under a
 * project's title (spec A5). Read wherever a note's front matter is: the
 * device's copy (`offline/mirrorLists.ts`), a List read from the server, and
 * the tree's properties table (`tree/props.js`), so all three agree.
 *
 * Only prose counts. Frontmatter, headings, fenced blocks (a ```list among
 * them), tables, quotes, list items, images and HTML are passed over, so an
 * overview that opens with a list block is described by the sentence after
 * it. Inline marks are dropped rather than drawn — `[text](url)` is `text`,
 * `**x**` is `x` — because the lede is three quiet lines, not a rendering.
 * Capped, so a note that is one long paragraph costs no more than a short one.
 */

const MAX_LINES = 400;
const MAX_CHARS = 320;

const SKIP = /^\s{0,3}(#|>|\||<|!\[|[-*+]\s|\d+[.)]\s|---\s*$|\*\*\*\s*$)/;

/** @param {string} text @returns {string | null} */
export function noteLede(text) {
  if (typeof text !== "string" || text === "") return null;
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/, MAX_LINES);
  const found = findLede(lines);
  if (found === null || found.start === found.end) return null;
  const words = plain(lines.slice(found.start, found.end).map((line) => line.trim()).join(" "));
  if (words === "") return null;
  return words.length > MAX_CHARS ? `${words.slice(0, MAX_CHARS - 1).trimEnd()}…` : words;
}

/**
 * Where the lede is in `lines`: `start`..`end` (exclusive), or, when the note
 * has none, `start === end` at the line a new one would go — after the
 * frontmatter and a title heading that opens the body. Null when the
 * frontmatter never closes.
 *
 * @param {readonly string[]} lines
 * @returns {{ start: number, end: number } | null}
 */
export function findLede(lines) {
  let at = 0;
  if (/^---\s*$/.test(lines[0] ?? "")) {
    const close = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
    if (close === -1) return null;
    at = close + 1;
  }
  const bodyStart = at;
  /** @type {string | null} */
  let fence = null;
  let start = -1;
  for (; at < lines.length; at++) {
    const line = lines[at];
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker !== null) {
      if (start !== -1) break;
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (line.trim() === "") {
      if (start !== -1) break;
      continue;
    }
    if (start === -1 && SKIP.test(line)) continue;
    if (start !== -1 && SKIP.test(line)) break;
    if (start === -1) start = at;
  }
  if (start !== -1) return { start, end: at };
  const where = insertionPoint(lines, bodyStart);
  return { start: where, end: where };
}

/**
 * After the frontmatter, and after a `# title` that opens the body.
 *
 * @param {readonly string[]} lines
 * @param {number} bodyStart
 */
function insertionPoint(lines, bodyStart) {
  let at = bodyStart;
  while (at < lines.length && lines[at].trim() === "") at++;
  if (at < lines.length && /^\s{0,3}#\s/.test(lines[at])) return at + 1;
  return bodyStart;
}

/** @param {string} text */
function plain(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
