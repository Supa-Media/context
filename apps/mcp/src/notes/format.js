/** Small text helpers for note content: sizes, YAML scalars, visibility words. Moved verbatim out of `src/index.js`. */

/**
 * The size of what will actually be stored, in bytes.
 *
 * `String.length` counts UTF-16 units, so it undercounts every non-ASCII note
 * by up to two thirds — and the activity file's substance test is a byte
 * threshold. A note whose edit was entirely in Yoruba or in emoji must not be
 * measured on a different ruler from one written in English.
 */
export function byteSize(text) {
  return new TextEncoder().encode(typeof text === "string" ? text : "").byteLength;
}

export function normalizeVisibility(value) {
  return value;
}

export function frontmatterVisibility(content) {
  if (typeof content !== "string" || !content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return null;
  const yaml = content.slice(3, end);
  const match = yaml.match(/^\s*(?:visibility|scope)\s*:\s*["']?(private|team|public)["']?\s*$/im);
  return match ? match[1].toLowerCase() : null;
}

export function yamlString(value) {
  return JSON.stringify(String(value));
}

/**
 * The front matter block a note opens with, delimiters included, or "" when
 * it opens with none. What a project List, a Board and every status reads.
 */
export function frontMatterBlock(text) {
  if (typeof text !== "string") return "";
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? match[0] : "";
}

const FIELD_LINE = /^[A-Za-z_][\w-]*:(?:[ \t].*)?$/;
const LIST_LINE = /^[ \t]+-[ \t]/;
/** How far down the closing line may be; front matter is a handful of lines. */
const MAX_FIELD_LINES = 40;

/**
 * Put back an opening `---` a writer left off, or return null when there is
 * nothing to put back.
 *
 * A client that rewrote a note and dropped its first line stored
 * `updated: …\nstatus: in progress\n---`: no front matter at all, so the
 * project's status, owner and tags vanished and its folder dropped into the
 * List's Notes section (2026-10-07, @supa `1-projects/context-agent`). As
 * Markdown it is a paragraph of `key: value` lines whose last line became a
 * heading, which nobody writes on purpose. So only that exact shape is
 * repaired: from the first line, nothing but `key: value` lines (and indented
 * `- item` lines under one), then a line that is exactly `---`.
 */
export function restoreOpeningDelimiter(text) {
  if (typeof text !== "string" || text.startsWith("---")) return null;
  const lines = text.split("\n");
  let fields = 0;
  for (let at = 0; at < lines.length && at <= MAX_FIELD_LINES; at += 1) {
    const line = lines[at].replace(/\r$/, "");
    if (/^---[ \t]*$/.test(line)) return fields > 0 ? `---\n${text}` : null;
    if (FIELD_LINE.test(line)) fields += 1;
    else if (!(LIST_LINE.test(line) && fields > 0)) return null;
  }
  return null;
}
