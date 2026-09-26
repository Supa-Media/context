/**
 * A note's first paragraph, as plain words: what a folder page draws under a
 * project's title (spec A5), read once off the device's copy beside the
 * frontmatter (`offline/mirrorLists.ts`).
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

export function noteLede(text: string): string | null {
  if (typeof text !== "string" || text === "") return null;
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/, MAX_LINES);
  let at = 0;
  if (/^---\s*$/.test(lines[0] ?? "")) {
    const close = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
    if (close === -1) return null;
    at = close + 1;
  }
  let fence: string | null = null;
  const paragraph: string[] = [];
  for (; at < lines.length; at++) {
    const line = lines[at];
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker !== null) {
      if (paragraph.length > 0) break;
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (line.trim() === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    if (paragraph.length === 0 && SKIP.test(line)) continue;
    if (paragraph.length > 0 && SKIP.test(line)) break;
    paragraph.push(line.trim());
  }
  const words = plain(paragraph.join(" "));
  if (words === "") return null;
  return words.length > MAX_CHARS ? `${words.slice(0, MAX_CHARS - 1).trimEnd()}…` : words;
}

function plain(text: string): string {
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
