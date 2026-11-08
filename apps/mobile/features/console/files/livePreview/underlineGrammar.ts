/**
 * `<u>underline</u>`, parsed as a construct of its own rather than as two
 * stray HTML tags.
 *
 * Markdown has no underline. The phone's writing bar offers one anyway (owner,
 * 2026-11-08: "bold italic, underline when a word is highlighted"), and `<u>`
 * is what every Markdown reader that has one already understands: Obsidian,
 * GitHub and a browser all draw it underlined, and a plain text editor shows
 * two short tags anyone can read. So the file stays plain Markdown and the
 * editor draws it the way it draws `==highlight==` (`highlightGrammar.ts`):
 * `Underline` around the words, `UnderlineMark` on each tag, and the marks
 * hidden under the same reveal rule as `**`.
 *
 * Delimiters rather than one element: the words between the tags are still
 * parsed, so `<u>**both**</u>` is bold and underlined. Only the exact
 * lowercase tags count; `<U>`, `<u class>` and a tag that never closes stay
 * the inline HTML they were.
 *
 * Parsed before `HTMLTag`, which would otherwise take each tag as an opaque
 * piece of HTML first.
 */

import type { MarkdownConfig } from "@lezer/markdown";
import { tags } from "@lezer/highlight";

const LESS_THAN = 60;
const OPEN = "<u>";
const CLOSE = "</u>";

const UnderlineDelim = { resolve: "Underline", mark: "UnderlineMark" };

export const underlineGrammar: MarkdownConfig = {
  defineNodes: [
    { name: "Underline", style: { "Underline/...": tags.special(tags.content) } },
    { name: "UnderlineMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Underline",
      parse(cx, next, pos) {
        if (next !== LESS_THAN) return -1;
        if (cx.slice(pos, pos + OPEN.length) === OPEN) {
          return cx.addDelimiter(UnderlineDelim, pos, pos + OPEN.length, true, false);
        }
        if (cx.slice(pos, pos + CLOSE.length) === CLOSE) {
          return cx.addDelimiter(UnderlineDelim, pos, pos + CLOSE.length, false, true);
        }
        return -1;
      },
      before: "HTMLTag",
    },
  ],
};

export const UNDERLINE_OPEN = OPEN;
export const UNDERLINE_CLOSE = CLOSE;
