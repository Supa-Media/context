/**
 * Tags written in a note's text: `#bible-character`, `#expandonthis`.
 *
 * A note has always been able to carry tags in its front matter (`tags:`).
 * People also type them inline, the way Obsidian reads them, and the owner
 * asked for those to count too (2026-10-13). So a note's tags are its front
 * matter's plus the ones written in its text, and every reader that counts
 * tags (search, ```list conditions, project rows and cards, Home's tag
 * filter) takes them through `noteTags` or `mergeTags` here.
 *
 * ## What is a tag
 *
 * Obsidian's rule, so a vault reads the same in both: a `#` at the start of a
 * line or after whitespace (or an opening bracket, `(#draft)`), then letters, digits, `_`, `-` and `/`, with at
 * least one character that is not a digit. So:
 *
 * - `# Heading` is a heading (the space), and `##` is never a tag;
 * - `#2026` and `#1` are numbers, not tags;
 * - `issue#12`, `page#top`, `[x](#section)` and `[[note#heading]]` are not
 *   tags, because the `#` is not after whitespace, and links, web addresses,
 *   code and HTML comments are removed before anything is looked for.
 *
 * ## Why kept apart from front matter
 *
 * The inline ones are returned on their own, never merged into
 * `noteProperties`: that function is also what an edit reads back to confirm
 * a `tags:` write (`setProperty.js`), and what a properties editor rewrites.
 * Merged there, the next edit of a note's tags would copy every inline tag
 * into its front matter. A reader that wants a note's whole set of tags
 * merges the two with `mergeTags`.
 *
 * Zero dependencies: imported by the gateway, the control plane and the app.
 */

const FRONT_MATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const TAG = /(^|[\s(])#([\p{L}\p{N}_\-/]+)/gu;

/** One character a tag may hold after its `#`. The editor's grammar reads tags with this too. */
export const TAG_CHAR = /[\p{L}\p{N}_\-/]/u;

/** Whether the characters after a `#` make a tag: tag characters only, and not all digits (`#2026` is a number). */
export function isTagBody(body) {
  return (
    typeof body === "string" &&
    /^[\p{L}\p{N}_\-/]+$/u.test(body) &&
    body.replace(/\/+$/, "") !== "" &&
    /[^\p{N}/]/u.test(body)
  );
}

/** Notes are short, but a pasted log is not: past this, a note's tags are its first part's. */
const MAX_SCANNED = 200_000;

/**
 * The `#tags` written in a note's text, in the order first written, each once
 * (compared without case; the first spelling is kept).
 *
 * @param {string} text the whole note, front matter included
 * @returns {string[]}
 */
export function inlineTags(text) {
  if (typeof text !== "string" || !text.includes("#")) return [];
  const body = text.slice(0, MAX_SCANNED).replace(FRONT_MATTER, "").replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  const found = [];
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = FENCE.exec(line);
    if (marker) {
      if (fence === null) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1]) fence = null;
      continue;
    }
    if (fence !== null || !line.includes("#")) continue;
    for (const match of plain(line).matchAll(TAG)) {
      if (isTagBody(match[2])) found.push(match[2].replace(/\/+$/, ""));
    }
  }
  return mergeTags([], found);
}

/**
 * A line with everything that may hold a `#` without meaning a tag blanked
 * out: inline code, wikilinks, a Markdown link's target, angle-bracket links
 * and bare web addresses. Blanked to a space, so the words either side stay
 * apart.
 */
function plain(line) {
  return line
    .replace(/(`+)[\s\S]*?\1/g, " ")
    .replace(/!?\[\[[^\]]*\]\]/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/<[^>\s]*>/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ");
}

/**
 * Tags from several places as one list: the first list's first, then any the
 * later ones add, each once without regard to case.
 *
 * @param {...unknown} lists string arrays, single strings (a comma-separated
 *   line is several), or nothing
 * @returns {string[]}
 */
export function mergeTags(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    const items = Array.isArray(list) ? list : list === undefined || list === null ? [] : [list];
    for (const item of items) {
      if (typeof item !== "string" && typeof item !== "number") continue;
      // `tags: ios, expo` is one front matter line naming two tags.
      for (const part of String(item).split(",")) {
        const tag = part.trim().replace(/^#/, "");
        const key = tag.toLowerCase();
        if (tag === "" || seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
      }
    }
  }
  return out;
}

/**
 * A note as a list or a card reads it: its properties with `tags` holding the
 * front matter's tags and the inline ones together. Returns the note itself
 * when it has no inline tags, so nothing is copied for the common case.
 *
 * @template {{ properties?: Record<string, unknown>, inlineTags?: readonly string[] }} N
 * @param {N} note
 * @returns {N}
 */
export function withInlineTags(note) {
  const inline = note?.inlineTags;
  if (!Array.isArray(inline) || inline.length === 0) return note;
  const properties = Object.assign(Object.create(null), note.properties || {});
  properties.tags = mergeTags(properties.tags, inline);
  return { ...note, properties };
}
