/**
 * An empty list item ends the paragraph above it: `- ` typed on the line
 * straight under some text starts the list right away.
 *
 * CommonMark lets a list item interrupt a paragraph only once the item has
 * content, so `text` over `- ` parsed as one paragraph ending in a literal
 * dash, and the bullet appeared only when the first word did. Typed, that
 * reads as the editor not knowing lists (Dev2, 2026-11-27). The share page and
 * website reader (`share/markdown.ts`, `isBlockStart`) already end a paragraph
 * at any `- `, `* `, `+ ` or `1. ` line, so this makes the editor agree with
 * them. A lone `-` with no space stays text there and here, so a `---` rule
 * typed a dash at a time never flickers through a bullet.
 *
 * Only the *empty* case is added: an item with content already interrupts a
 * paragraph under the default rules, and an ordered one that does not start at
 * 1 is matched too, as the reader does. Once the paragraph ends, the ordinary
 * list parsers take the line, unchanged. The Markdown on disk is untouched.
 *
 * Its own module, with no local imports, because `language.ts` — the top of
 * the module map — installs it. Part of the Live Preview extension;
 * `../livePreview.ts` is the facade that re-exports the public names.
 */

import type { MarkdownConfig } from "@lezer/markdown";

/** A list marker and at least one space, then nothing else on the line. */
const EMPTY_ITEM = /^(?:[-*+]|\d{1,9}[.)])[ \t]+$/;

export const listUnderTextGrammar: MarkdownConfig = {
  parseBlock: [
    {
      name: "EmptyListItemBreak",
      parse: () => false,
      endLeaf: (_cx, line) => EMPTY_ITEM.test(line.text.slice(line.pos)),
    },
  ],
};
