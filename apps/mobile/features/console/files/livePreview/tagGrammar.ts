/**
 * `#tags` written in a note's text, as their own node: `Tag`.
 *
 * The owner asked for inline tags to be tags (2026-10-13), so the editor draws
 * them as such (`cm-lp-tag`, see `reveal.ts` and `styles/text.ts`). Which words
 * are tags is decided once, in `lists/inlineTags.js`, the reader every count of
 * tags uses; this grammar takes its character rule and its "not all digits"
 * rule from there, so a word the editor marks is a word lists and search count.
 *
 * What keeps it off things that are not tags is mostly the grammar around it:
 * a heading's `#` is block syntax, read before any inline parser sees the line,
 * and links, autolinks, inline code and HTML comments are consumed by their own
 * parsers before a `#` inside them is reached. What is left is the rule a `#`
 * starts a tag only after whitespace, an opening bracket or the start of the
 * text, which is what keeps `issue#12` and `page#top` plain.
 *
 * Its own module, importing nothing local but that shared rule, like
 * `highlightGrammar.ts`, because `language.ts` is the top of the grammar and
 * everything reaches it.
 */

import type { MarkdownConfig } from "@lezer/markdown";
import { tags } from "@lezer/highlight";
import { isTagBody } from "../../../../../mcp/src/lists/inlineTags.js";

const HASH = 35;
const BODY = /^[\p{L}\p{N}_\-/]+/u;

export const tagGrammar: MarkdownConfig = {
  defineNodes: [{ name: "Tag", style: tags.labelName }],
  parseInline: [
    {
      name: "Tag",
      parse(cx, next, pos) {
        if (next !== HASH) return -1;
        const before = pos > cx.offset ? cx.char(pos - 1) : -1;
        if (before !== -1 && !/[\s(]/.test(String.fromCharCode(before))) return -1;
        const body = BODY.exec(cx.slice(pos + 1, cx.end))?.[0] ?? "";
        if (!isTagBody(body)) return -1;
        const end = pos + 1 + body.replace(/\/+$/, "").length;
        return cx.addElement(cx.elt("Tag", pos, end));
      },
    },
  ],
};
