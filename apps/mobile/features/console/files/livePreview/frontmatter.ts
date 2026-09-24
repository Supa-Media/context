/**
 * The YAML frontmatter block: where it is, and the two decorations that draw
 * it or put it away.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import { Decoration } from "@codemirror/view";

/**
 * The YAML frontmatter block at the top of a note, if there is one.
 *
 * ## Why this exists at all
 *
 * The lezer Markdown grammar has no frontmatter node, and the file comment
 * above already admitted as much — "a frontmatter key it has no node type for".
 * What it did not say is what happens instead, and it is not nothing:
 *
 *     ---
 *     updated: 2026-08-26
 *     status: active
 *     ---
 *
 * CommonMark reads the closing `---` as a **setext underline**, so the two YAML
 * keys above it become a level-2 heading. Every note in a bucket written by
 * Obsidian opens with its metadata drawn two-thirds the size of its title, in
 * bold, above the actual first line. It is the first thing on the screen and it
 * was the loudest thing on it.
 *
 * ## Why a pure function over the text, and not a block parser
 *
 * A `@lezer/markdown` block parser is the tidier-looking answer and cannot be
 * written correctly here: recognising the block means scanning forward for the
 * closing fence, `BlockContext` advances with `nextLine()` and cannot rewind,
 * and `peekLine()` sees exactly one line. So an unterminated `---` — an
 * ordinary horizontal rule on the first line — would swallow the rest of the
 * document with no way back.
 *
 * Reading the text is exact, total, and testable without a parser, which is the
 * rule the rest of this file already follows.
 *
 * Returns `null` unless the document *opens* with the fence: a `---` further
 * down is a horizontal rule and must stay one. The closing fence may be `---`
 * or `...`, which YAML allows and Obsidian accepts.
 */
export function frontmatterRange(doc: string): { from: number; to: number } | null {
  const lines = doc.split("\n");
  if (lines.length < 2 || !/^---[ \t]*$/.test(lines[0])) return null;

  let at = lines[0].length + 1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^(---|\.\.\.)[ \t]*$/.test(line)) return { from: 0, to: at + line.length };
    at += line.length + 1;
  }
  // Unterminated. Not frontmatter — the first line is a horizontal rule, and
  // pretending otherwise would dim the whole note.
  return null;
}

/**
 * The frontmatter block **and the blank lines it is separated from the note
 * by**, which is what gets put away while nobody is in it.
 *
 * `frontmatterRange` stops at the closing fence, because that is where the
 * YAML document stops and its own tests hold it there. Hiding exactly that
 * left a 28pt empty line above the note's title — the separator, still
 * separating, with nothing left on the other side of it. A blank line after a
 * fence exists because the fence is there; with the fence gone it is a gap
 * nobody typed for its own sake.
 *
 * Returns `null` for the same documents `frontmatterRange` does. The walk
 * stops at the first line with anything on it, so a note that is frontmatter
 * and then blank lines and then nothing gives back the whole document — which
 * is correct and is the case `openingCaret` clamps.
 */
export function frontmatterBlock(doc: string): { from: number; to: number } | null {
  const front = frontmatterRange(doc);
  if (front === null) return null;

  let to = front.to;
  for (let at = to + 1; at <= doc.length; ) {
    const end = doc.indexOf("\n", at);
    const lineEnd = end === -1 ? doc.length : end;
    if (doc.slice(at, lineEnd).trim() !== "") break;
    to = lineEnd;
    if (end === -1) break;
    at = end + 1;
  }
  return { from: front.from, to };
}

export const frontmatterLine = Decoration.line({ class: "cm-lp-frontmatter" });

/**
 * The whole frontmatter block, replaced while nobody is in it.
 *
 * `block: true` for `htmlPreviews`' reason: this stands in for whole lines
 * rather than a run of characters inside one, and `frontmatterRange` only ever
 * answers a range that starts at the document's first character and ends at
 * the end of the closing fence — exactly the shape a block decoration needs.
 */
export const frontmatterHidden = Decoration.replace({ block: true });
