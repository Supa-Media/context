/**
 * `==highlighted words==`, the marker-pen syntax Obsidian writes.
 *
 * Not in GFM, so lezer's Markdown grammar parses the equals signs as plain
 * text and a note full of highlights showed them raw — which reads as the
 * editor being broken, the same reason `language.ts` turns GFM on for `~~`.
 * Built exactly like GFM's own strikethrough: a two-character delimiter with
 * the same flanking rule, so `a == b` in a sentence (spaces on both sides) is
 * never a highlight, and `===` is not a delimiter at all.
 *
 * Its own module with no local imports, like `castGrammar.ts`, because
 * `language.ts` is the top of the grammar and everything reaches it.
 *
 * Drawn as `cm-lp-mark` (see `reveal.ts` and `styles/text.ts`) — a fill with
 * no underline, so it never reads as a comment, which is an amber wash *with*
 * an underline (`comments/styles.ts`). A comment's `<!--c:id-->` anchors are
 * inline HTML to this grammar and sit inside or around a highlight without
 * breaking it.
 */

import type { MarkdownConfig } from "@lezer/markdown";
import { tags } from "@lezer/highlight";

const EQUALS = 61;

/** lezer's own Punctuation class, which `@lezer/markdown` does not export. */
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1‐-‧]/;

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

export const highlightGrammar: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": tags.special(tags.content) } },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS) return -1;
        if (cx.char(pos + 2) === EQUALS || cx.char(pos - 1) === EQUALS) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = PUNCTUATION.test(before);
        const pAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        );
      },
      after: "Emphasis",
    },
  ],
};
