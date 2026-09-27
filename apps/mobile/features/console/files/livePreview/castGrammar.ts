/**
 * The grammar half of cast blocks (`castBlock.ts` draws them): an unclosed
 * ```` ```cast ```` fence is a line of text, not a code block that runs to the
 * end of the note.
 *
 * CommonMark runs an unclosed fence to the end of the document, so the first
 * keystroke of ```` ```cast ```` turned every heading, list and link below it
 * into code until the closing fence was typed. The shared parser already says
 * an unclosed block "is shown as it is"; this makes the editor agree.
 *
 * Its own module, with no local imports, because `language.ts` — the top of
 * the module map — installs it.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import type { BlockContext, Line, MarkdownConfig } from "@lezer/markdown";

/**
 * The opening line of a cast block, exactly as `websiteCast.ts` reads it:
 * backticks only, the word `cast` and nothing after it. ```` ```cast notes ````
 * is not a cast block there, so it is not one here either — two readers of
 * one syntax that disagree is a row that says "8 steps" over a block the
 * homepage never plays.
 */
export const CAST_OPEN = /^ {0,3}(`{3,})\s*cast\s*$/i;

/**
 * An opening ```` ```cast ```` line with no closing fence
 * below it is a line of text, not the start of a code block that never ends.
 *
 * A `BlockParser` placed before `FencedCode`, so it sees the line first. When
 * the block is closed it declines and the ordinary fence parser takes it,
 * unchanged. When it is not, the opening line is drawn as a line of text and
 * the note below parses as the note it is.
 *
 * Deciding "closed" means reading ahead, which `BlockContext` has no public
 * method for (`frontmatter.ts` says why that ruled out a block parser there).
 * It does hold the parse input, and reading forward from it is exact; the
 * field is typed `@internal`, so it is reached through one narrow cast and a
 * missing one declines — the note then parses as CommonMark says, which is the
 * old behaviour and not a broken one.
 *
 * ## Why the rest of the note is wrapped in a `CastPending` block
 *
 * Because the answer depends on text *below* the line, and the incremental
 * parser only re-reads what changed. Emitting the one line as a paragraph and
 * moving on was the first version, and it was right on a fresh parse and wrong
 * the moment somebody typed the closing fence: the paragraph ended long before
 * the edit, so the parser reused it, and the note came out with the script as
 * paragraphs and a new unclosed fence starting at the closer.
 *
 * So an unclosed cast opens an invisible container that runs to the end of the
 * document — the way a blockquote contains its lines, with no marker to strip
 * — and everything below parses inside it exactly as it would outside. Any
 * later edit is then an edit inside that node, which the parser cannot reuse,
 * so it reads the opening line again and this time finds its closer.
 * `castFences.test.ts` holds this against a from-scratch parse after typing
 * the closer a character at a time.
 *
 * Only at the top level of the document: a fence inside a quote or a list
 * carries that container's prefix on every line, and the homepage never plays
 * one there anyway.
 */
export const castGrammar: MarkdownConfig = {
  defineNodes: [{ name: "CastPending", block: true, composite: () => true }],
  parseBlock: [
    {
      name: "UnclosedCast",
      before: "FencedCode",
      parse(cx: BlockContext, line: Line): boolean | null {
        const open = CAST_OPEN.exec(line.text);
        if (open === null) return false;
        /*
          Inside the container every cast line is unclosed by construction —
          a closer below it would have closed the first one too — and that
          includes the opening line itself, which is read again once the
          container has started. Each is one line of text.
        */
        if (cx.depth === 2 && cx.parentType().name === "CastPending") {
          const from = cx.lineStart + line.pos;
          const to = cx.lineStart + line.text.length;
          cx.addElement(cx.elt("Paragraph", from, to, cx.parser.parseInline(line.text.slice(line.pos), from)));
          cx.nextLine();
          return true;
        }
        // `depth` counts the Document itself, so 1 is the top level.
        if (cx.depth !== 1) return false;
        const input = (cx as unknown as { input?: { length: number; read(from: number, to: number): string } })
          .input;
        if (input === undefined) return false;
        const lineEnd = cx.lineStart + line.text.length;
        const rest = input.read(Math.min(lineEnd + 1, input.length), input.length);
        if (closesFence(rest, open[1]!.length)) return false;
        cx.startComposite("CastPending", line.pos);
        return null;
      },
    },
  ],
};

/** Whether any line of `rest` closes a backtick fence `length` long (CommonMark's rule). */
function closesFence(rest: string, length: number): boolean {
  const closer = new RegExp(`^ {0,3}\`{${length},}[ \\t]*$`);
  return rest.split("\n").some((line) => closer.test(line));
}
