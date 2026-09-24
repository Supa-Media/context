/**
 * The grammar the editor parses, and the highlighting a fenced code block gets.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports these names and holds the module map.
 */

import type { Extension } from "@codemirror/state";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { GFM } from "@lezer/markdown";
import { tags } from "@lezer/highlight";

/**
 * The Markdown dialect this editor parses.
 *
 * GFM, because that is what the bucket already contains: these notes are
 * written in Obsidian and synced as plain files, and they use tables, task
 * lists and strikethrough. Parsing a narrower dialect would not corrupt
 * anything — nothing here serializes — but it would leave `~~struck~~` showing
 * its tildes, which reads as the editor being broken.
 *
 * A table is *parsed* and is still drawn as its own pipes and dashes. Turning
 * one into a laid-out grid means a block widget that replaces a range of lines,
 * which is a different and much larger piece of work than decorating inline
 * marks — and a half-drawn table is worse than an honest monospace one. Noted
 * as a gap rather than claimed as working.
 *
 * Exported so `__tests__/livePreview.test.ts` builds its states with the same
 * configuration the editor ships. A test that parsed a different dialect from
 * the product would be asserting against a grammar nobody uses.
 */
export function markdownLanguage() {
  return markdown({ extensions: [GFM], codeLanguages: FENCE_LANGUAGES });
}

/**
 * The three languages a fenced code block can be parsed *inside*, R3 in the
 * sweep.
 *
 * Only these three: `@codemirror/lang-javascript`, `-html` and `-css` are
 * already transitive dependencies of `@codemirror/lang-markdown` (GFM tables
 * and task lists pull in `lang-markdown`, and `lang-markdown` pulls these in
 * for embedded script/style blocks) — bytes the bundle carries whether or not
 * anything imports them. Reaching for `@codemirror/language-data`'s full
 * catalogue instead would add every language nobody asked for to a bundle
 * that is committed and shipped over the air (see `bundle.generated.ts`).
 *
 * A fence in any other language — bash, python, whatever a note happens to
 * quote — is left exactly as it was: an unhighlighted `CodeText` leaf, still
 * drawn in the mono face by `cm-lp-fence`. That is an honest gap rather than a
 * silently wrong highlight, the same choice R4 makes about a table this
 * editor cannot lay out.
 */
const FENCE_LANGUAGES: readonly LanguageDescription[] = [
  LanguageDescription.of({
    name: "javascript",
    alias: ["js", "jsx", "mjs", "cjs", "ts", "tsx", "typescript"],
    support: javascript({ jsx: true, typescript: true }),
  }),
  LanguageDescription.of({ name: "html", alias: ["htm"], support: html() }),
  LanguageDescription.of({ name: "css", support: css() }),
];

/**
 * Fenced code's own tokens, mapped to CSS classes rather than to inline
 * colours.
 *
 * Every other style in this file is a class reaching into `--lp-*` custom
 * properties (`livePreviewStyles` below, set from `features/design/tokens` by
 * `LiveEditor.web.tsx`) rather than a colour baked into the extension — so a
 * fourth palette-specific token is deliberately not added here. Three classes,
 * three of the tokens this file already has:
 *
 *  - `--lp-link` for a keyword — the same accent already used for a followable
 *    link, which is the other place this editor draws something "active".
 *  - `--lp-heading` for a string literal — the note's own emphasis colour.
 *  - `--lp-muted` for a comment, italic — code that is not code, same as a
 *    blockquote (`cm-lp-quote`) uses the identical pairing.
 *
 * Deliberately not exhaustive: numbers, types and tag names are left in the
 * body colour rather than spending a fourth or fifth class on a distinction a
 * note's code fences rarely need. `HighlightStyle`'s `class` field — rather
 * than the inline-style form most examples use — is what makes this compose
 * with the rest of the theme instead of fighting it.
 */
export const fenceHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier, tags.definitionKeyword],
    class: "cm-lp-code-keyword",
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: "cm-lp-code-string" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], class: "cm-lp-code-comment" },
]);

/** The extension that actually paints `fenceHighlightStyle`'s classes on. */
export function codeHighlighting(): Extension {
  return syntaxHighlighting(fenceHighlightStyle);
}
