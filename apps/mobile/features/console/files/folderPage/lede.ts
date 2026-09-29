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
  const found = findLede(lines);
  if (found === null || found.start === found.end) return null;
  const words = plain(lines.slice(found.start, found.end).map((line) => line.trim()).join(" "));
  if (words === "") return null;
  return words.length > MAX_CHARS ? `${words.slice(0, MAX_CHARS - 1).trimEnd()}…` : words;
}

/**
 * The lede as it is written, marks and all, for somebody about to change it:
 * `[the plan](…)` stays a link when the sentence around it is edited.
 * Empty when the note has no prose paragraph yet.
 */
export function ledeSource(text: string): string {
  if (typeof text !== "string" || text === "") return "";
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const found = findLede(lines);
  if (found === null) return "";
  return lines.slice(found.start, found.end).map((line) => line.trim()).join(" ");
}

/**
 * The note with its lede — the same paragraph `noteLede` reads — replaced by
 * `next`, which a folder page writes when somebody edits the words under a
 * project's title. Everything else in the note is left byte for byte.
 *
 * `next` is one paragraph: line breaks inside it become spaces, since a blank
 * line would make the second half somebody else's paragraph. With no prose
 * paragraph yet, it goes after the frontmatter and the title heading; empty,
 * it removes the paragraph. A note whose frontmatter never closes is refused
 * rather than guessed at, and so is anything that would not read back as
 * this same paragraph — `---` on a note with no frontmatter would otherwise
 * make one, and frontmatter is where `folder:` publishes a website folder.
 */
export function setNoteLede(text: string, next: string): { text: string } | { error: string } {
  const source = typeof text === "string" ? text : "";
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.slice(bom.length).split(/\r?\n/);
  const paragraph = next
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  const found = findLede(lines);
  if (found === null) return { error: "the note’s frontmatter is not closed" };
  if (found.start < found.end) {
    if (paragraph === "") {
      // Take one blank line with it, so the note does not keep a gap where it was.
      const end = lines[found.end] !== undefined && lines[found.end].trim() === "" ? found.end + 1 : found.end;
      lines.splice(found.start, end - found.start);
    } else {
      lines.splice(found.start, found.end - found.start, paragraph);
    }
  } else if (paragraph !== "") {
    const at = found.start;
    const before = at > 0 && lines[at - 1].trim() !== "" ? [""] : [];
    const after = lines[at] !== undefined && lines[at].trim() !== "" ? [""] : [];
    if (at === lines.length && lines.length > 0 && lines[lines.length - 1] === "") {
      // A note ending in a newline: the paragraph goes before that last empty line.
      lines.splice(at - 1, 0, ...before, paragraph);
    } else {
      lines.splice(at, 0, ...before, paragraph, ...after);
    }
  }
  const out = bom + lines.join(eol);
  // Read back: words that open like a heading, a list or a fence are not a
  // lede, and neither edit may give the note frontmatter it did not have —
  // a `---` typed, or one uncovered by removing the paragraph above it.
  if (frontmatterOf(out) !== frontmatterOf(source) || (paragraph !== "" && ledeSource(out) !== paragraph)) {
    return { error: "those words would not read as a description" };
  }
  return { text: out };
}

/** The note's frontmatter block as written, or null for none. */
function frontmatterOf(text: string): string | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0] ?? "")) return null;
  const close = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
  return close === -1 ? null : lines.slice(0, close + 1).join("\n");
}

/**
 * Where the lede is in `lines`: `start`..`end` (exclusive), or, when the note
 * has none, `start === end` at the line a new one would go — after the
 * frontmatter and a title heading that opens the body. Null when the
 * frontmatter never closes.
 */
function findLede(lines: readonly string[]): { start: number; end: number } | null {
  let at = 0;
  if (/^---\s*$/.test(lines[0] ?? "")) {
    const close = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
    if (close === -1) return null;
    at = close + 1;
  }
  const bodyStart = at;
  let fence: string | null = null;
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

/** After the frontmatter, and after a `# title` that opens the body. */
function insertionPoint(lines: readonly string[], bodyStart: number): number {
  let at = bodyStart;
  while (at < lines.length && lines[at].trim() === "") at++;
  if (at < lines.length && /^\s{0,3}#\s/.test(lines[at])) return at + 1;
  return bodyStart;
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
