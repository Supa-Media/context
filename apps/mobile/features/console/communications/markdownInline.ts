/**
 * The safe half of "rendered as Markdown" for a message body: paragraphs and
 * inline emphasis, nothing that can navigate.
 *
 * **This deliberately does not linkify anything.** A channel-day message body
 * is unmoderated content from outside this context — `trust: untrusted` in
 * the note's own frontmatter — and it is fenced rather than defanged
 * (`packages/communications/src/note.js`'s own header: "Bodies are
 * deliberately NOT put through [defangLinks] — they are quoted verbatim
 * inside a fence"). So a sender's `[[.audit/anything]]` or
 * `[phish](https://…)` survives in the text exactly as they wrote it, and the
 * fence is what keeps every *other* reader of the note from treating it as
 * structure. A console that turned bracket syntax back into a pressable link
 * would be the one reader that undoes that fence. `tokenizeInline` therefore
 * recognises only emphasis — `**bold**`, `*italic*`, `` `code` `` — and never
 * looks at `[`, `]`, `(` or `)` at all: literal characters in, literal
 * characters out. See `docs/decisions/app-and-console.md`, *A message body is
 * rendered, never linkified*.
 */

/** One run of a paragraph, with the emphasis it carries. */
export interface InlineToken {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/** A body split into paragraphs on blank lines, blanks and surrounding whitespace dropped. */
export function splitParagraphs(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * One non-overlapping pass: `**bold**`, `` `code` ``, then `*italic*`. Marks
 * do not nest — `**a *b* c**` reads as bold containing the literal asterisks
 * around `b`, not bold-then-italic — which is a real limitation stated rather
 * than hidden: this is emphasis for a stranger's plain-text mail, not a
 * markdown engine, and the corpus it has to be safe against is hostile text,
 * not well-formed nested markdown.
 */
const TOKEN_PATTERN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;

export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) tokens.push({ text: text.slice(lastIndex, index) });
    const raw = match[0];
    if (raw.startsWith("**")) tokens.push({ text: raw.slice(2, -2), bold: true });
    else if (raw.startsWith("`")) tokens.push({ text: raw.slice(1, -1), code: true });
    else tokens.push({ text: raw.slice(1, -1), italic: true });
    lastIndex = index + raw.length;
  }
  if (lastIndex < text.length) tokens.push({ text: text.slice(lastIndex) });
  return tokens.length === 0 ? [{ text: "" }] : tokens;
}
