/**
 * What one table cell draws: its Markdown read into styled runs, with escapes,
 * entities, `<br>`, code spans and wiki links standing in for the text they
 * encode.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
/*
  The gateway's own inverse of what it writes into a response cell. Imported
  rather than reimplemented for the reason `formBlock.ts`'s header gives about
  the grammar: a second copy of this is a second answer that can disagree, and
  the disagreement would show up as a person's submitted text drawn back to them
  wrong. `forms.js` is pure, zero-dependency, DOM-free JavaScript; three
  surfaces already reach for it.
*/
import { unescapeCell } from "../../../../../mcp/src/forms.js";
import { HIDDEN_MARKS, isHiddenPlumbing, styleClassFor } from "./reveal";

/**
 * One run of text inside a rendered cell, and the classes to draw it in.
 *
 * A cell is a list of these rather than a string because a cell is markdown:
 * `**bold**`, an inline `code` span, a strikethrough. The classes are the same
 * ones `styleClassFor` hands the rest of the note, so a phrase looks the same
 * inside a grid as it does in the paragraph above it — one renderer, not two.
 *
 * A `\n` in `text` is a **hard break the author asked for** (`<br>`), which is
 * the only way a newline can reach a cell: a raw one ends the row. The widget
 * draws it as a line break.
 */
export interface CellRun {
  readonly text: string;
  /** Space-separated live-preview classes, or `null` for the body face. */
  readonly className: string | null;
}

/**
 * The entities `escapeCell` writes, and the numeric forms a person might.
 *
 * Deliberately short. This is not an HTML entity table and must not become
 * one: the job is reading back what the gateway wrote (`&amp;`, `&lt;`,
 * `&gt;`) plus the handful somebody types by hand. Anything else is left as the
 * characters the author typed, which is always a defensible thing to draw.
 */
const CELL_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&apos;", "'"],
  ["&nbsp;", " "],
]);

function decodeEntity(source: string): string | null {
  const known = CELL_ENTITIES.get(source.toLowerCase());
  if (known !== undefined) return known;
  const numeric = /^&#(x[0-9a-f]+|\d+);$/i.exec(source);
  if (numeric === null) return null;
  const digits = numeric[1];
  const code =
    digits[0].toLowerCase() === "x" ? Number.parseInt(digits.slice(1), 16) : Number.parseInt(digits, 10);
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return null;
  /*
    Surrogates are refused explicitly rather than left to throw, because
    `String.fromCodePoint` does **not** throw for a lone one — it happily
    returns an unpaired code unit. Drawing `&#xD800;` as itself is the same
    answer this function gives every entity it does not understand, and is
    better than putting a half character into the DOM.
  */
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

/** The one HTML tag a cell may contain that means something here. */
const BREAK_TAG_RE = /^<br\s*\/?>$/i;

/** `a` and `b` as one class attribute, dropping the empties. */
function joinClasses(outer: string | null, own: string | null): string | null {
  if (outer === null) return own;
  if (own === null) return outer;
  return `${outer} ${own}`;
}

/**
 * A wiki link, drawn as the words rather than as its own brackets.
 *
 * `[[note]]` is not a grammar node — the lezer Markdown dialect reads it as an
 * ordinary `Link` around `[note]` with the outer brackets as plain text, so
 * hiding the link's own marks (which is right for `[label](url)`) leaves the
 * reader `[note]`: one bracket at each end and no link. `noteLinks` normally
 * covers for this by decorating the whole span, and it cannot reach inside a
 * block widget.
 *
 * So the cell finds them itself, the same shape `noteLinksIn` parses, and draws
 * the alias where there is one. Drawn in the link colour and **not followable**
 * — the ref that resolves a path against the open note belongs to `noteLinks`
 * and does not reach here. That is a real gap against the mono-line rendering
 * this replaces, and it is stated rather than papered over: the link is one
 * press of the eye away, where it is followable again.
 */
const WIKI_LINK_RE = /!?\[\[([^[\]]+)\]\]/g;

/**
 * One `TableCell` node, as the runs that draw it.
 *
 * Built as a per-character map and then merged into runs rather than by walking
 * children recursively, because the interesting content is **not** a clean
 * tree: an escape, an entity, a `<br>` and a wiki link each stand for different
 * text than they are written as, and they nest inside styled spans. A position
 * map answers "what is drawn here, in what face" once for each of them.
 *
 * Four kinds of range stand in for other text, and it is not a coincidence that
 * the first three are exactly what `apps/mcp/src/forms.js` writes — `forms.js`
 * escapes every value it puts in a response row:
 *
 *  - **`Escape`** — `\|` is how a pipe survives a cell, `\\` a backslash.
 *    Drawing the backslash would put one in front of every pipe somebody typed.
 *  - **`HTMLTag`** — `<br>` is how a newline survives one. Every other tag is
 *    drawn as its own text: this file has no `innerHTML` and is not gaining one.
 *  - **`Entity`** — `&lt;` is how a `<` survives the above. Decoded *after* the
 *    break is recognised, which is what keeps somebody who typed a literal
 *    `<br>` seeing `<br>` — the ordering `escapeCell` sorts its replacements for.
 *  - **`InlineCode`** — taken whole, and its text run through the gateway's own
 *    `unescapeCell`. The grammar emits no `Escape`, `Entity` or `HTMLTag` inside
 *    a code span (CommonMark says its content is literal), so the three rules
 *    above simply do not fire there and a submitted `` `a|b` `` came back as
 *    `` `a\|b` ``. GFM unescapes a cell's pipes before inline parsing, so this
 *    is the spec's answer as well as the round trip's, and using `unescapeCell`
 *    rather than a second copy of it is what stops the two readers disagreeing.
 *
 * Marks are dropped under exactly the rule the rest of the note follows, so a
 * cell is never the one place `**` shows through.
 */
export function cellRuns(state: EditorState, cell: SyntaxNode): CellRun[] {
  const base = cell.from;
  const text = state.doc.sliceString(cell.from, cell.to);
  /** The classes covering each character, innermost last. */
  const classAt: (string | null)[] = new Array<string | null>(text.length).fill(null);
  /** Pure syntax, drawn as nothing. */
  const hidden: boolean[] = new Array<boolean>(text.length).fill(false);
  /** Ranges that stand in for other text, keyed by where they start. */
  const stands = new Map<number, { to: number; text: string; className: string | null }>();
  /** Code spans, whose content is literal and so claims its whole range. */
  const literal: Array<{ from: number; to: number }> = [];

  const paint = (from: number, to: number, className: string): void => {
    for (let at = from; at < to; at += 1) {
      classAt[at - base] = joinClasses(classAt[at - base], className);
    }
  };

  syntaxTree(state).iterate({
    from: cell.from,
    to: cell.to,
    enter(node) {
      // Ancestors of the cell overlap the range; they are not in it.
      if (node.from < cell.from || node.to > cell.to || node.to <= node.from) return;

      if (HIDDEN_MARKS.has(node.name) || isHiddenPlumbing(node.node)) {
        for (let at = node.from; at < node.to; at += 1) hidden[at - base] = true;
        return false;
      }

      const source = state.doc.sliceString(node.from, node.to);
      const outer = classAt[node.from - base];

      if (node.name === "InlineCode") {
        literal.push({ from: node.from, to: node.to });
        /*
          The marks are the backtick runs at either end; what is between them is
          the literal content, and `unescapeCell` is the inverse of what wrote it.
        */
        const opening = node.node.firstChild;
        const closing = node.node.lastChild;
        const innerFrom = opening === null ? node.from : opening.to;
        const innerTo = closing === null ? node.to : closing.from;
        stands.set(node.from, {
          to: node.to,
          text: unescapeCell(state.doc.sliceString(innerFrom, innerTo)) as string,
          className: joinClasses(outer, "cm-lp-code"),
        });
        return false;
      }
      if (node.name === "Escape") {
        stands.set(node.from, { to: node.to, text: source.slice(1), className: outer });
        return false;
      }
      if (node.name === "HTMLTag") {
        stands.set(node.from, {
          to: node.to,
          text: BREAK_TAG_RE.test(source) ? "\n" : source,
          className: outer,
        });
        return false;
      }
      if (node.name === "Entity") {
        stands.set(node.from, { to: node.to, text: decodeEntity(source) ?? source, className: outer });
        return false;
      }

      const own = styleClassFor(node.name);
      if (own !== null) paint(node.from, node.to, own);
      return undefined;
    },
  });

  /*
    Wiki links last, and not inside a code span: `` `[[note]]` `` is literal
    text and the span has already said what it draws. Only a code span blocks
    one — an `Escape` *inside* the link is how an alias is written in a table
    cell at all (`[[target\|alias]]`, because a bare pipe would end the cell),
    so treating any overlapping replacement as a clash would refuse exactly the
    links that are written correctly.
  */
  WIKI_LINK_RE.lastIndex = 0;
  for (let found = WIKI_LINK_RE.exec(text); found !== null; found = WIKI_LINK_RE.exec(text)) {
    const from = base + found.index;
    const to = from + found[0].length;
    if (literal.some((span) => span.from < to && span.to > from)) continue;
    /*
      The alias, which is what a reader is meant to see. Split on the last pipe
      and then unescape, so the backslash that let the pipe survive the cell is
      not drawn — the target keeps it, and the target is not what is drawn.
    */
    const inside = found[1];
    const pipe = inside.lastIndexOf("|");
    const shown = pipe === -1 ? inside : inside.slice(pipe + 1);
    stands.set(from, {
      to,
      text: (unescapeCell(shown) as string).trim(),
      className: joinClasses(classAt[found.index], "cm-lp-link"),
    });
  }

  const raw: CellRun[] = [];
  const add = (piece: string, className: string | null): void => {
    if (piece !== "") raw.push({ text: piece, className });
  };
  for (let at = 0; at < text.length; ) {
    const stand = stands.get(base + at);
    if (stand !== undefined) {
      add(stand.text, stand.className);
      at = stand.to - base;
      continue;
    }
    if (hidden[at]) {
      at += 1;
      continue;
    }
    add(text[at], classAt[at]);
    at += 1;
  }

  // Adjacent runs in the same face are one run. Not cosmetic: the widget makes
  // a span per run, and the loop above emits one per character.
  const runs: CellRun[] = [];
  for (const run of raw) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.className === run.className) {
      runs[runs.length - 1] = { text: last.text + run.text, className: last.className };
      continue;
    }
    runs.push(run);
  }
  return runs;
}
