/**
 * A note's first paragraph: reading it (`noteLede`, which lives with the
 * gateway's list grammar so the tree's properties table parses it the same
 * way) and changing it.
 */

import { findLede, noteLede } from "../../../../../mcp/src/lists/lede.js";

export { noteLede };

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

