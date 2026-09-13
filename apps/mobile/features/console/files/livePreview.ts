/**
 * Live Preview — Obsidian's editing surface, and why it is this rather than a
 * block editor.
 *
 * The buffer **is** the Markdown. Nothing here parses the document into another
 * model and serializes it back; the decorations below only change how the text
 * that is already there is drawn. That is the whole argument for this approach
 * over a block editor (Yoopta, TipTap, Lexical), and it is two arguments:
 *
 *  - **Round-trip is lossless by construction.** There is no serializer, so
 *    there is nothing that can mangle an ASCII diagram, a raw HTML block, or a
 *    frontmatter key it has no node type for. `NoteEditor.tsx` used to say a
 *    WYSIWYG "can disagree with the file"; this keeps that true instead of
 *    reversing it.
 *  - **CodeMirror has no React peer.** A React DOM editor entering
 *    `apps/mobile`'s dependency tree is the exact move that broke native
 *    rendering twice in the sibling app, by pulling a second React into the
 *    lockfile and re-keying the Expo native-module graph onto it. The
 *    `reactResolution` guardrail in `__tests__/supa-framework.test.js` is what
 *    proves this stayed true; it is not a claim in a comment.
 *
 * ## The one behaviour that makes it feel right
 *
 * Markup hides when your cursor is elsewhere and comes back the instant you
 * enter it. `## Heading` renders as a heading until you click the line, and
 * then it is `## Heading` again — because you cannot edit syntax you cannot
 * see, and an editor that permanently hides its own markup is a block editor
 * with extra steps.
 *
 * The unit that reveals is the **whole containing node**, not the mark. Putting
 * the cursor between the asterisks of `**bold**` has to show you both pairs, or
 * the text jumps sideways as you arrow through it.
 *
 * ## Everything below the extension is pure
 *
 * `revealedRanges` and `decorationsFor` take a document, a tree and a selection
 * and return ranges. That is deliberate: this is the part with the interesting
 * edge cases — a selection spanning three nodes, a cursor exactly on a
 * boundary, a mark at the very end of the document — and it can be tested
 * without a browser, a renderer, or a mounted editor.
 */

import { EditorState, Range, RangeSet, StateField, type Extension } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { FormWidget, formFences, formHost } from "./formBlock";
/*
  The gateway's own inverse of what it writes into a response cell. Imported
  rather than reimplemented for the reason `formBlock.ts`'s header gives about
  the grammar: a second copy of this is a second answer that can disagree, and
  the disagreement would show up as a person's submitted text drawn back to them
  wrong. `forms.js` is pure, zero-dependency, DOM-free JavaScript; three
  surfaces already reach for it.
*/
import { unescapeCell } from "../../../../mcp/src/forms.js";
import { HighlightStyle, LanguageDescription, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { GFM } from "@lezer/markdown";
import { tags } from "@lezer/highlight";
import type { SyntaxNode, Tree } from "@lezer/common";

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

/**
 * Node types that are pure syntax: they exist to mark up the text around them
 * and are hidden when the cursor is not inside their parent.
 *
 * Named rather than pattern-matched on `/Mark$/`, because the lezer Markdown
 * grammar also has `LinkMark` inside an image, `CodeMark` on both a fence and
 * an inline span, and a `QuoteMark` that must NOT be hidden — a blockquote with
 * its `>` removed reflows into the paragraph above it and the reader cannot see
 * the quote at all.
 */
const HIDDEN_MARKS: ReadonlySet<string> = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrongEmphasisMark",
  "StrikethroughMark",
  "LinkMark",
  "CodeMark",
]);

/**
 * Nodes that are not *marks* but are still plumbing, hidden under the same
 * rule.
 *
 * `[label](target.md)` parses as LinkMark `[`, the label, LinkMark `](`, a
 * **URL** node, LinkMark `)`. Hiding only the marks leaves the target glued to
 * the label — "a link to the proposalproposal.md" — which is what shipped
 * before a screenshot caught it. The URL is what the link points at, not what
 * the author wrote for a reader to read.
 *
 * Guarded by the parent check in `isHiddenPlumbing`: an Autolink is a bare URL
 * that IS its own label, and hiding that one leaves an empty link.
 */
const HIDDEN_PLUMBING: ReadonlySet<string> = new Set(["URL", "LinkTitle"]);

function isHiddenPlumbing(node: SyntaxNode): boolean {
  if (!HIDDEN_PLUMBING.has(node.name)) return false;
  const parent = node.parent;
  // Only inside a real `[…](…)`. An Autolink's URL is the visible text.
  return parent !== null && (parent.name === "Link" || parent.name === "Image");
}

/**
 * Nodes whose whole extent is the "reveal unit" for the marks inside them.
 *
 * A mark reveals when the selection touches its containing node — so entering
 * `**bold**` anywhere shows both pairs of asterisks at once, rather than the
 * pair nearer the cursor. Anything not listed falls back to the mark's direct
 * parent, which is the right answer for the block-level cases (`ATXHeading1`
 * and friends are matched by prefix below).
 */
const REVEAL_CONTAINERS: ReadonlySet<string> = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "InlineCode",
  "Link",
  "Image",
]);

/** Block containers whose names vary by level (`ATXHeading1` … `ATXHeading6`). */
function isRevealContainer(name: string): boolean {
  return (
    REVEAL_CONTAINERS.has(name) ||
    name.startsWith("ATXHeading") ||
    name === "SetextHeading1" ||
    name === "SetextHeading2" ||
    name === "FencedCode"
  );
}

export interface TextRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Extend a mark's end over the single space that follows it.
 *
 * Only one space, and only if it is there. `##  Two spaces` is somebody's
 * deliberate formatting and eating both would change what the reader sees by
 * more than the syntax.
 */
function swallowTrailingSpace(
  doc: { sliceString: (from: number, to: number) => string } | undefined,
  to: number,
): number {
  if (doc === undefined) return to;
  return doc.sliceString(to, to + 1) === " " ? to + 1 : to;
}

/**
 * Does the selection touch this range?
 *
 * Inclusive at both ends on purpose. A cursor at `from` is *about* to type into
 * the node and a cursor at `to` has just left it; hiding the markup in either
 * position makes the text jump under a caret that is only moving one character
 * at a time, which is the single most irritating way to get this wrong.
 */
export function selectionTouches(
  range: TextRange,
  selection: readonly TextRange[],
): boolean {
  return selection.some((sel) => sel.to >= range.from && sel.from <= range.to);
}

/**
 * The reveal unit for a mark: its nearest containing node that a reader would
 * call "the thing being formatted".
 *
 * Falls back to the mark itself at the top of the tree — a mark with no parent
 * is malformed input, and revealing only that mark is the conservative answer.
 */
export function revealUnitFor(node: SyntaxNode): TextRange {
  let current: SyntaxNode | null = node.parent;
  while (current !== null) {
    if (isRevealContainer(current.name)) {
      return { from: current.from, to: current.to };
    }
    current = current.parent;
  }
  const parent = node.parent;
  return parent === null
    ? { from: node.from, to: node.to }
    : { from: parent.from, to: parent.to };
}

/**
 * Every markup range that should be hidden right now.
 *
 * Pure over (tree, selection): the same inputs always give the same ranges, so
 * the interesting cases are testable without an editor. Ranges are returned in
 * document order because `RangeSet.of` requires it and sorting afterwards would
 * hide a bug where the tree is walked out of order.
 */
export function hiddenMarkRanges(
  tree: Tree,
  selection: readonly TextRange[],
  docLength: number,
  doc?: { sliceString: (from: number, to: number) => string },
): TextRange[] {
  const hidden: TextRange[] = [];

  /*
    Nothing is hidden inside the frontmatter, and the asymmetry is why.

    The opening `---` parses as a HorizontalRule and the closing one as a setext
    HeaderMark — so mark-hiding took the closing fence away and left the opening
    one, and the block read as an unterminated rule above two stray keys. Both
    are metadata a person may need to edit, and the block is already drawn small
    and dim, which is what stops them shouting.

    Decided here rather than in `decorationsFor` so every caller gets it: this
    function is the one answer to "what is hidden", and a second copy of the
    rule beside it is a second thing to keep in step.
  */
  const front = doc === undefined ? null : frontmatterRange(doc.sliceString(0, docLength));

  tree.iterate({
    from: 0,
    to: docLength,
    enter(node) {
      if (front !== null && node.from < front.to) return;
      const isMark = HIDDEN_MARKS.has(node.name);
      if (!isMark && !isHiddenPlumbing(node.node)) return;
      // A zero-width mark is nothing to hide, and an empty replace decoration
      // at the same position as another is a CodeMirror range-set error rather
      // than a no-op.
      if (node.to <= node.from) return;

      const unit = revealUnitFor(node.node);
      if (selectionTouches(unit, selection)) return;

      hidden.push({
        from: node.from,
        // A heading's `##` is followed by a space that is part of the syntax,
        // not the text. Hiding the hashes alone leaves every heading indented
        // by one character — visible as soon as you look at a rendered note,
        // and invisible to a test that only compares hidden strings.
        to: node.name === "HeaderMark" ? swallowTrailingSpace(doc, node.to) : node.to,
      });
    },
  });

  return hidden;
}

/**
 * The class a formatted node is drawn with.
 *
 * Returned as a string rather than applied here so the mapping is testable and
 * so the actual styling lives in one stylesheet — see `livePreviewTheme`.
 */
export function styleClassFor(nodeName: string): string | null {
  if (/^ATXHeading[1-6]$/.test(nodeName)) {
    return `cm-lp-h${nodeName.slice("ATXHeading".length)}`;
  }
  switch (nodeName) {
    case "SetextHeading1":
      return "cm-lp-h1";
    case "SetextHeading2":
      return "cm-lp-h2";
    case "StrongEmphasis":
      return "cm-lp-strong";
    case "Emphasis":
      return "cm-lp-em";
    case "Strikethrough":
      return "cm-lp-strike";
    case "InlineCode":
      return "cm-lp-code";
    case "FencedCode":
      return "cm-lp-fence";
    case "Blockquote":
      return "cm-lp-quote";
    case "Link":
      return "cm-lp-link";
    case "ListMark":
      return "cm-lp-list-mark";
    case "TableDelimiter":
      return "cm-lp-table-delim";
    case "HorizontalRule":
      return "cm-lp-rule";
    default:
      return null;
  }
}

const hideMark = Decoration.replace({});

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

const frontmatterLine = Decoration.line({ class: "cm-lp-frontmatter" });

/* ---------------------------- lists and tables ---------------------------- */

/**
 * A line inside a list item, and how far its text sits from the margin.
 *
 * ## Why a list needed anything at all
 *
 * `- item` was drawn as the literal hyphen it is, in the body font, with no
 * indent — so a nested list read as three hyphens in a column and a wrapped
 * item's second line started back at the margin, underneath its own bullet.
 * On a phone, where almost every list item wraps, that is the whole of "bullet
 * points don't render properly": nothing about the text says which lines belong
 * to which item.
 *
 * ## Why an indent per *line* rather than per item
 *
 * A nested item's lines are also its parent's lines — the parent `ListItem`
 * spans the whole subtree — so the two would both want to indent them, by
 * different amounts. Resolving that in the range set would mean relying on
 * which of two line decorations at one position CodeMirror applies last.
 * Deciding it here instead is one map keyed by line, written in tree order, so
 * the deepest item is simply the last writer and the answer is a fact rather
 * than an ordering.
 *
 * ## Why `ch`
 *
 * The marker is `-`, `*`, `+` or `12.`, and what the wrapped text has to clear
 * is the marker plus the space after it, measured in characters. `ch` is the
 * width of a `0` in the current font, which in a proportional face is a little
 * wider than a hyphen and a space — so a wrapped line clears its bullet with a
 * small margin rather than landing exactly on the first letter. Exact alignment
 * would need the rendered width of that specific prefix, which is a measurement
 * and not a decoration, and being a few pixels generous is the failure that
 * still reads as a list.
 */
export interface HangingIndent {
  /** The start of one line. */
  readonly from: number;
  /** Characters of indent and marker that line's text should clear. */
  readonly columns: number;
}

/**
 * The hanging indent for every line that is inside a list item.
 *
 * Pure over the state, and exported for its own test: the interesting cases are
 * nesting, a wrapped item and a marker wider than one character, and all three
 * are properties of a tree rather than of a rendered editor.
 *
 * `frontEnd` is where the YAML frontmatter ends, and nothing before it is
 * touched — for the reason `hiddenMarkRanges` states at length. A `tags:` block
 * is a YAML sequence, the grammar reads it as a Markdown list, and indenting
 * somebody's metadata by two columns is the same class of mistake as drawing
 * it as a heading. Defaults to zero so a caller with no frontmatter — every
 * test that is not about this — says nothing.
 */
export function hangingIndents(state: EditorState, frontEnd = 0): HangingIndent[] {
  const byLine = new Map<number, number>();
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "ListItem") return;
      const mark = node.node.getChild("ListMark");
      if (mark === null) return;
      const first = state.doc.lineAt(mark.from);
      /*
        The marker's own columns, counted from the margin, plus the one space
        that separates it from the text. `12.` indents further than `-`, which
        is the whole reason this is measured rather than a constant.

        **A task's marker is `- [ ]`, not `-`.** `TaskMarker` is a child of the
        item beside `ListMark`, and measuring only the `ListMark` under-indented
        every wrapped line of a task by the width of its own checkbox — so the
        second line of a wrapped task ran back under the box, which is the exact
        thing this function exists to prevent, on the one list item that draws
        the widest marker. Seen in a browser at 390pt; no test covered it
        because every task fixture fitted on one line.
      */
      // `ListItem > Task > TaskMarker`, never a direct child — checked against
      // the real tree rather than assumed, because `getChild("TaskMarker")`
      // answers `null` here and reads exactly like a line that works.
      const task = node.node.getChild("Task")?.getChild("TaskMarker") ?? null;
      const columns = (task ?? mark).to - first.from + 1;
      for (let line = first; ; ) {
        // Written unconditionally: a deeper item is entered after its parent,
        // so the last write for a line is the innermost item that owns it.
        byLine.set(line.from, columns);
        if (line.to >= node.to || line.to >= state.doc.length) break;
        line = state.doc.lineAt(line.to + 1);
      }
    },
  });
  return [...byLine.entries()]
    .map(([from, columns]) => ({ from, columns }))
    .sort((a, b) => a.from - b.from);
}

/**
 * A piece of list syntax drawn as the thing it means.
 *
 * A union rather than one shape with optional fields, because the two are not
 * variations of each other: a bullet is a **character** standing in for a
 * character, and a checkbox is a **control** standing in for three. The first
 * version gave both a `glyph: string` and drew ☐ for a task, which is how a
 * checkbox came to be a piece of text in a text font — thin, differently shaped
 * on every platform, and not obviously pressable. See `TaskWidget`.
 */
export type ListGlyph =
  | { readonly kind: "bullet"; readonly from: number; readonly to: number }
  | {
      readonly kind: "task";
      readonly from: number;
      readonly to: number;
      /** `[x]` rather than `[ ]`. Decides both the box and its line's text. */
      readonly checked: boolean;
    };

/**
 * Is this `TaskMarker` ticked?
 *
 * "Anything that is not `[ ]`" rather than "is `[x]`", which reads as though it
 * were generous and is not: lezer's GFM grammar recognises only `[ ]`, `[x]`
 * and `[X]` as a `TaskMarker`, so a plugin's `[-]` for a cancelled task is
 * never a `Task` node and never reaches here. The phrasing is for the `[X]`
 * that a capital-writing editor produces, and the limit is pinned by a test —
 * a comment claiming the generous reading was written first and was wrong.
 */
function isTicked(
  doc: { sliceString: (from: number, to: number) => string },
  from: number,
  to: number,
): boolean {
  return doc.sliceString(from, to).toLowerCase() !== "[ ]";
}

/**
 * The text of every finished task, so it can be drawn as finished.
 *
 * The other half of a checkbox, and the half a glyph could never have: in
 * Obsidian a completed task's text is struck through and dimmed, which is what
 * lets somebody skim a list and see what is left without reading it. The box
 * alone says the same thing in a space one character wide.
 *
 * **Unconditional, unlike the box.** The markup a task is written in hides when
 * the caret leaves its line and comes back when it enters — that is the reveal
 * rule, and it applies to `[x]` because those are three characters somebody may
 * want to edit. Whether the task is *done* is not markup; it is what the note
 * says. So the strikethrough stays put while the caret moves through the line,
 * exactly as a heading stays large while you edit it. "Styling is unconditional
 * — that is the 'live' in Live Preview."
 *
 * The range starts after the marker and its one following space: a strikethrough
 * over leading whitespace draws a line into the gap before the first word.
 */
export function completedTasks(state: EditorState, frontEnd = 0): TextRange[] {
  const done: TextRange[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "Task") return;
      const marker = node.node.getChild("TaskMarker");
      if (marker === null || !isTicked(state.doc, marker.from, marker.to)) return;
      const from = swallowTrailingSpace(state.doc, marker.to);
      if (from >= node.to) return;
      done.push({ from, to: node.to });
    },
  });
  return done;
}

/**
 * Bullets and checkboxes, drawn as a bullet and a checkbox.
 *
 * ## The one construct in this file that does NOT reveal under the caret
 *
 * Everything else here hides its markup when the cursor is elsewhere and shows
 * it the instant the cursor arrives, because you cannot edit syntax you cannot
 * see. **A list marker is the exception, and on a touch screen the reveal rule
 * was not a nicety being traded away — it made the checkbox unpressable.**
 *
 * A tap on a phone places the caret before the synthesized `mousedown` arrives.
 * So the sequence was: finger lands, caret goes on that line, the line is now
 * "revealed", the decoration is recomputed, the widget is replaced by the
 * literal `- [x] ` — and then `mousedown` fires and finds nothing under it,
 * because the element the press was aimed at no longer exists. The owner
 * described it exactly: "it's impossible to click, it just goes back into text
 * form", on mobile, with desktop fine. Desktop was fine for an unrelated
 * reason: there the handler's own `preventDefault()` stops the caret landing,
 * so the box survived its own press.
 *
 * Obsidian does not reveal these either, and the owner's description of it is
 * the specification: "you are able to check the box in UI form, but still edit
 * it as text if you hit the back button". Which is what a replaced range gives
 * you for free — arrowing or backspacing into it edits the characters
 * underneath. Nothing is hidden from editing; it is drawn as what it means and
 * it stays drawn.
 *
 * The rest of the file is unchanged: `**bold**`, `## heading` and a link's
 * plumbing still come back the moment the caret enters them. The difference is
 * what the markup *is*. `**` is punctuation around text you are formatting, and
 * hiding it permanently would be a block editor with extra steps. `- ` and
 * `[x]` are a marker and a control — there is no formatted text inside them to
 * edit, and drawing them is the entire feature.
 *
 * An ordered list's `1.` is deliberately left alone. It is already the number a
 * reader wants to see, and replacing it with a drawn one would mean this editor
 * renumbering a list, which is a document model doing the counting — the exact
 * thing this file exists not to have.
 *
 * `frontEnd` excludes the frontmatter — see `hangingIndents`. A YAML sequence
 * drawn with bullets would be the editor decorating text it has already decided
 * to draw as plain metadata.
 */
export function listGlyphs(state: EditorState, frontEnd = 0): ListGlyph[] {
  const glyphs: ListGlyph[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name === "ListMark") {
        const parent = node.node.parent;
        // `1.` is a number, not a marker to redraw. See above.
        if (parent === null || parent.parent?.name !== "BulletList") return;
        glyphs.push({ kind: "bullet", from: node.from, to: node.to });
        return;
      }
      if (node.name !== "TaskMarker") return;
      glyphs.push({
        kind: "task",
        from: node.from,
        to: node.to,
        checked: isTicked(state.doc, node.from, node.to),
      });
    },
  });
  return glyphs;
}

/**
 * Every line a GFM table occupies.
 *
 * **This does not lay a table out, and saying so is the point.** The pipes stay
 * exactly where the author typed them; what changes is that the lines are drawn
 * in the mono face, so the columns of a table whose rows fit line up instead of
 * drifting apart under a proportional font. That was the whole of "tables don't
 * render properly" for a table that fits, and it is honest about the one that
 * does not: a wide table still wraps, and it wraps as text rather than as a
 * half-drawn grid.
 *
 * A real grid is a block widget replacing a range of lines, which is a much
 * larger piece of work than decorating what is there and is recorded as the
 * next step rather than claimed here.
 *
 * `frontEnd` excludes the frontmatter — see `hangingIndents`.
 */
export function tableLines(state: EditorState, frontEnd = 0): number[] {
  const lines: number[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "Table") return;
      for (let line = state.doc.lineAt(node.from); ; ) {
        lines.push(line.from);
        if (line.to >= node.to || line.to >= state.doc.length) break;
        line = state.doc.lineAt(line.to + 1);
      }
    },
  });
  return lines;
}

/* -------------------------------------------------------------------------- */
/*                          a table, actually laid out                        */
/* -------------------------------------------------------------------------- */

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

/** What the delimiter row said about a column, or `null` for the default. */
export type CellAlign = "left" | "center" | "right" | null;

/** One GFM table, read out of the tree and ready to draw. */
export interface TableGrid {
  readonly from: number;
  readonly to: number;
  /** The whole table verbatim. What `eq` compares on — see `TableGridWidget`. */
  readonly source: string;
  readonly align: readonly CellAlign[];
  readonly header: ReadonlyArray<readonly CellRun[]>;
  readonly rows: ReadonlyArray<ReadonlyArray<readonly CellRun[]>>;
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
function cellRuns(state: EditorState, cell: SyntaxNode): CellRun[] {
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

/**
 * The delimiter row, read for what it is actually for.
 *
 * `|:--|:-:|--:|` is not content — it is three column alignments and a count,
 * and drawing it to a reader (which is what the mono-face pass did) is showing
 * them the ruler instead of the measurement.
 */
export function alignmentsIn(text: string): CellAlign[] {
  const inner = text.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
  return inner.split("|").map((part) => {
    const spec = part.trim();
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

/**
 * THE COLUMNS OF ONE ROW — AND THE GRAMMAR DOES NOT GIVE YOU THESE.
 *
 * The obvious implementation is the `TableCell` children, and it is wrong in
 * the way that matters most here: **lezer emits no `TableCell` for an empty
 * cell.** `| 1 |  | 3 |` has two of them, so taking the children shifts every
 * column to its right — a reader is shown `3` under the header `b`, with no
 * hint that anything moved. In a form's response table an unanswered optional
 * field does exactly that to every column after it, which is the feature's own
 * output silently misattributed.
 *
 * So the columns are the gaps *between the delimiters*, which are the `|`
 * characters and are always in the tree. A gap holds the row's `TableCell` when
 * there is one and is an empty column when there is not.
 *
 * The leading and trailing gaps are dropped only when they are empty, which is
 * what makes this right for both pipe styles: `| a | b |` opens and closes on a
 * delimiter and has two columns, and GFM's optional `a | b` has no outer pipes
 * and also has two.
 *
 * Returns one entry per column, `null` where the column is empty.
 */
function cellsOf(row: SyntaxNode): Array<SyntaxNode | null> {
  const delimiters: Array<{ from: number; to: number }> = [];
  const cells: SyntaxNode[] = [];
  for (let child = row.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "TableDelimiter") delimiters.push({ from: child.from, to: child.to });
    else if (child.name === "TableCell") cells.push(child.node);
  }

  const gaps: Array<{ from: number; to: number }> = [];
  let at = row.from;
  for (const delimiter of delimiters) {
    gaps.push({ from: at, to: delimiter.from });
    at = delimiter.to;
  }
  gaps.push({ from: at, to: row.to });

  if (gaps.length > 0 && gaps[0].to <= gaps[0].from) gaps.shift();
  if (gaps.length > 0 && gaps[gaps.length - 1].to <= gaps[gaps.length - 1].from) gaps.pop();

  return gaps.map(
    (gap) => cells.find((cell) => cell.from >= gap.from && cell.to <= gap.to) ?? null,
  );
}

function readTable(state: EditorState, table: SyntaxNode): TableGrid | null {
  let align: CellAlign[] = [];
  let header: CellRun[][] | null = null;
  const rows: CellRun[][][] = [];

  for (let child = table.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "TableHeader") {
      header = cellsOf(child).map((cell) => (cell === null ? [] : cellRuns(state, cell)));
      continue;
    }
    if (child.name === "TableRow") {
      rows.push(cellsOf(child).map((cell) => (cell === null ? [] : cellRuns(state, cell))));
      continue;
    }
    /*
      The delimiter *row*, which is a `TableDelimiter` that is a direct child of
      the table — the single `|` separators are children of the rows instead, so
      there is nothing to disambiguate here beyond being on this level.
    */
    if (child.name === "TableDelimiter" && align.length === 0) {
      align = alignmentsIn(state.doc.sliceString(child.from, child.to));
    }
  }

  // No header is not a GFM table, whatever else the tree made of it.
  if (header === null || header.length === 0) return null;

  /*
    Every row is the header's width. GFM says a short row is padded and a long
    one is truncated, and the reason to follow it here is structural rather than
    conformance: a `<tr>` with the wrong number of cells shifts every column to
    its right for the rest of the table, so one malformed row would misdraw the
    rows under it rather than itself.
  */
  const width = header.length;
  const shaped = rows.map((row) => {
    const cells = row.slice(0, width);
    while (cells.length < width) cells.push([]);
    return cells;
  });

  return {
    from: table.from,
    to: table.to,
    source: state.doc.sliceString(table.from, table.to),
    align,
    header,
    rows: shaped,
  };
}

/**
 * Every table that should be drawn as a grid right now.
 *
 * **`state.readOnly`, and nothing else** — the form block's rule, and the same
 * sentence for the same reason. The rest of this file serves "you cannot edit
 * syntax you cannot see" by revealing markup when the caret touches it, and a
 * table cannot do that: the cell you want to edit is the thing the grid has
 * replaced, so a grid that gave way on selection would flicker between two
 * layouts as somebody arrowed through a row. A reader has no caret to reveal
 * with, so the two rules stop competing: editing shows the pipes exactly where
 * the author put them, reading shows the table.
 *
 * A table that does not start at the margin is left alone, for the reason
 * `htmlPreviews` gives: a block widget replaces whole lines, and one indented
 * inside a list item does not occupy them.
 *
 * `frontEnd` excludes the frontmatter — see `hangingIndents`.
 */
export function tableGrids(state: EditorState, frontEnd = 0): TableGrid[] {
  if (!state.readOnly) return [];
  const grids: TableGrid[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "Table") return;
      const table = node.node;
      if (
        state.doc.lineAt(table.from).from !== table.from ||
        state.doc.lineAt(table.to).to !== table.to
      ) {
        return;
      }
      const grid = readTable(state, table);
      if (grid !== null) grids.push(grid);
    },
  });
  return grids;
}

/**
 * A table, drawn as a table.
 *
 * A real `<table>` rather than a grid of divs, because this is tabular data and
 * the element carries the row and column relationships to a screen reader for
 * free — a reader who cannot see the alignment is exactly the one who needs to
 * be told which header a cell belongs to.
 *
 * Nothing here interprets the note as markup: every string reaches the DOM
 * through `textContent`, the way `FormWidget` does and for the same reason. The
 * one tag a cell may contain that means something — `<br>` — has already become
 * a `\n` in `cellRuns`, so the break is drawn by this file rather than parsed
 * by the browser.
 *
 * `ignoreEvent` is left at CodeMirror's default, which **ignores** events inside
 * the widget — the same behaviour `FormWidget` asks for explicitly. It costs
 * nothing today, because a grid exists only while the note is read-only and
 * there is no caret to place either way; it is named here so that a later
 * change making tables interactive knows it is a decision rather than an
 * oversight.
 */
export class TableGridWidget extends WidgetType {
  constructor(private readonly grid: TableGrid) {
    super();
  }

  /*
    Compared on the table's own text. Like `FormWidget.eq` this is load-bearing
    rather than an optimisation — the decoration set is rebuilt on every
    transaction, and a widget that reported itself new would have its DOM torn
    down and rebuilt on every keystroke elsewhere in the note.
  */
  eq(other: TableGridWidget): boolean {
    return other.grid.source === this.grid.source;
  }

  toDOM(): HTMLElement {
    /*
      The scroller is the wrapper rather than the table, so a table wider than
      the measure scrolls inside its own box. Without it the note itself scrolls
      sideways, and then every paragraph in the note is dragged off screen by
      one wide table.
    */
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-grid";

    const table = document.createElement("table");
    table.className = "cm-lp-grid-table";

    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    this.grid.header.forEach((cell, column) => {
      headRow.append(this.drawCell("th", cell, column));
    });
    head.append(headRow);
    table.append(head);

    const body = document.createElement("tbody");
    for (const row of this.grid.rows) {
      const tr = document.createElement("tr");
      row.forEach((cell, column) => {
        tr.append(this.drawCell("td", cell, column));
      });
      body.append(tr);
    }
    table.append(body);

    wrap.append(table);
    return wrap;
  }

  private drawCell(tag: "th" | "td", runs: readonly CellRun[], column: number): HTMLElement {
    const cell = document.createElement(tag);
    const align = this.grid.align[column] ?? null;
    if (align !== null) cell.classList.add(`cm-lp-grid-${align}`);

    const empty = runs.every((run) => run.text.trim() === "");
    if (empty) {
      /*
        A dash rather than nothing. An empty cell drawn as empty is
        indistinguishable from a column that failed to render, and a reader has
        no way to tell which they are looking at — the same argument as "an
        absent capability is reported, never faked".
      */
      cell.classList.add("cm-lp-grid-empty");
      return cell;
    }

    for (const run of runs) {
      // A `\n` is the hard break the author wrote as `<br>`; see `cellRuns`.
      const pieces = run.text.split("\n");
      pieces.forEach((piece, index) => {
        if (index > 0) cell.append(document.createElement("br"));
        if (piece === "") return;
        if (run.className === null) {
          cell.append(document.createTextNode(piece));
          return;
        }
        const span = document.createElement("span");
        span.className = run.className;
        span.textContent = piece;
        cell.append(span);
      });
    }
    return cell;
  }
}

/**
 * A bullet, drawn in place of the `-` that means it.
 *
 * Fixed-width by class rather than by the character's own metrics, so the
 * hanging indent above stays true on a wrapped line: a bullet stands in for
 * exactly one character and has to occupy exactly one character's worth of
 * room.
 */
class BulletWidget extends WidgetType {
  eq(): boolean {
    // Every bullet is the same bullet. Returning `true` lets CodeMirror reuse
    // the DOM across every redraw rather than rebuilding a span per list item
    // per keystroke.
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "\u2022";
    return span;
  }
  /* A click on a bullet should still place the caret on that line. */
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * A checkbox, drawn as a checkbox.
 *
 * ## Why this is not a character
 *
 * The first version of this drew ☐ and ☑, and they are *text*: they take the
 * body font's weight, they are a different shape in every font that has them at
 * all, several fonts do not and fall back to a box the reader has seen used for
 * "missing glyph", and none of them looks like something you press. The
 * complaint that followed was that checklists "just get rendered as plain
 * text", which was exactly right — they were rendered as text, because they
 * were text.
 *
 * So the box is **drawn**: a border, a radius, and a tick built from two
 * borders on a rotated pseudo-element. That is Obsidian's construction and it
 * is the reason it reads as a control — it does not depend on the reader having
 * a font, and it does not change weight when the surrounding text does.
 *
 * ## The three characters it stands in for
 *
 * The outer span is `3ch` wide and holds a box of about one em inside it, so
 * `[ ]` and the drawn box occupy the same room and `hangingIndents` stays true
 * for a wrapped task. The box is centred in that space rather than left in it,
 * because a `-` and a `[ ]` are different widths and a column of mixed items
 * should still have its text in one column.
 *
 * ## Accessibility
 *
 * `role="checkbox"` with `aria-checked`, because it is one — a screen reader
 * over the raw text would otherwise hear "left bracket x right bracket". It is
 * deliberately not focusable: the editor owns the caret, and a tab stop inside
 * the document would take Tab away from the text.
 */
class TaskWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }
  /*
    Compared on `checked`, and this is load-bearing rather than an optimisation:
    a widget that reported itself equal to a differently-ticked one would keep
    its old DOM when the box was pressed, so the buffer would say `[x]` and the
    screen would show an empty box until something else forced a redraw.
  */
  eq(other: TaskWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.checked ? "cm-lp-task cm-lp-task-on" : "cm-lp-task";
    span.setAttribute("role", "checkbox");
    span.setAttribute("aria-checked", this.checked ? "true" : "false");
    const box = document.createElement("span");
    box.className = "cm-lp-task-box";
    span.append(box);
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}


/* --------------------------- rendered previews ---------------------------- */

/**
 * The one fence tag this editor draws instead of printing, and the whole of the
 * convention: no new file format, no frontmatter switch, no per-note setting.
 *
 * ```` ```html-preview ```` is opt-in because a plain ```` ```html ```` block is
 * somebody quoting HTML — a snippet they are debugging, a fragment they are
 * explaining — and a note that talks about markup must not start executing it.
 */
export const HTML_PREVIEW_TAG = "html-preview";

/**
 * A fence that will be drawn, and the markup it will be drawn from.
 *
 * `from`/`to` are the whole fence including both ```` ``` ```` lines, because
 * that is the range the widget stands in for and the range the caret has to
 * touch to get the source back.
 */
export interface HtmlPreview {
  readonly from: number;
  readonly to: number;
  /** The fence's body, exactly as the file holds it. Never rewritten. */
  readonly html: string;
}

/** The first word of a fence's info string, lower-cased, or `null`. */
function fenceTag(
  doc: { sliceString: (from: number, to: number) => string },
  fence: SyntaxNode,
): string | null {
  const info = fence.getChild("CodeInfo");
  if (info === null) return null;
  const first = doc.sliceString(info.from, info.to).trim().split(/\s+/)[0];
  return first === undefined || first === "" ? null : first.toLowerCase();
}

/**
 * What is between a fence's two ```` ``` ```` lines, read off the text.
 *
 * Off the *text* rather than off a `CodeText` child, and that is not
 * incidental: `FENCE_LANGUAGES` makes the grammar parse the inside of an
 * `html`, `css` or `js` fence into real nodes, so "the fence's content" is one
 * leaf for some tags and a subtree for others. A tag that is wired up today is
 * one dependency bump away from being wired up tomorrow, and a preview that
 * silently renders half its diagram would be the failure. Two line boundaries
 * are exact whatever the grammar does inside them.
 *
 * An unterminated fence — the state a note is in for as long as somebody is
 * typing one — has a single `CodeMark`, and its body runs to the end of the
 * node.
 */
function fenceBody(
  doc: { lineAt: (pos: number) => { from: number; to: number }; length: number; sliceString: (from: number, to: number) => string },
  fence: SyntaxNode,
): string {
  const marks = fence.getChildren("CodeMark");
  const open = marks[0];
  if (open === undefined) return "";
  const start = doc.lineAt(open.from).to + 1;
  if (start > doc.length) return "";
  const close = marks.length > 1 ? marks[marks.length - 1] : null;
  const end = close === null ? fence.to : doc.lineAt(close.from).from - 1;
  return start >= end ? "" : doc.sliceString(start, end);
}

/**
 * Every `html-preview` fence that should be drawn right now.
 *
 * Pure over the state, like every other pass in this file, and conditional on
 * the selection like the mark-hiding is: **a drawn diagram becomes its own
 * fence again the moment the caret enters it.** That is this file's central
 * rule — you cannot edit syntax you cannot see — and a diagram is the case
 * where breaking it would hurt most, because the markup underneath is the only
 * place the diagram can be changed.
 *
 * Two fences are deliberately left as text rather than drawn:
 *
 *  - **One that does not start at the margin.** A fence indented inside a list
 *    item does not occupy whole lines, and a block widget can only replace
 *    whole lines. An honest code block beats a widget that eats half a list.
 *  - **One with an empty body.** There is nothing to draw, and a zero-height
 *    frame is a gap in the note that nothing explains.
 *
 * `frontEnd` excludes the frontmatter, for the reason `hangingIndents` states:
 * metadata is drawn as metadata, and a `---` block that happens to contain a
 * fence is still YAML.
 */
export function htmlPreviews(state: EditorState, frontEnd = 0): HtmlPreview[] {
  const previews: HtmlPreview[] = [];
  const selection = revealSelection(state);
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "FencedCode") return;
      const fence = node.node;
      if (fenceTag(state.doc, fence) !== HTML_PREVIEW_TAG) return;
      if (
        state.doc.lineAt(fence.from).from !== fence.from ||
        state.doc.lineAt(fence.to).to !== fence.to
      ) {
        return;
      }
      if (selectionTouches({ from: fence.from, to: fence.to }, selection)) return;
      const html = fenceBody(state.doc, fence);
      if (html.trim() === "") return;
      previews.push({ from: fence.from, to: fence.to, html });
    },
  });
  return previews;
}

/**
 * What the frame is allowed to reach, which is nothing.
 *
 * The `sandbox` attribute already stops the note being code. This stops it
 * being a **beacon**: `background:url(https://…)` needs no JavaScript, and a
 * fetch from a note a stranger emailed you is a read receipt on a document you
 * did not ask for — it tells the sender the moment you opened it, and which
 * note. `default-src 'none'` closes that, and `img-src data:` still lets a
 * diagram carry its own artwork inline. There is no `font-src`: a webfont is a
 * fetch like any other.
 */
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/**
 * The document the frame is handed, with the fence's markup inside it verbatim.
 *
 * **Nothing here filters anything, and that is the design rather than a gap.**
 * Writing an HTML sanitizer means maintaining a list of tags and attributes
 * against everyone who has ever found a way past one, and it would buy nothing:
 * the browser already refuses to run script in a bare-`sandbox` frame, for
 * free, with no bypass surface of our making. A second mechanism nobody tests
 * is not defence in depth.
 *
 * Exported so its own test can read it without a DOM.
 *
 * `color-scheme: light` and a white ground are the one opinion this document
 * holds, and it is the opposite of the rule the rest of this file follows about
 * never baking a colour in. The reason is that the host's `--lp-*` custom
 * properties cannot cross into the frame — a sandboxed document inherits no
 * cascade from its parent — so a diagram authored against a light ground, which
 * is every diagram anybody has written so far, would be dark ink on a dark
 * console. A preview is a drawing with a palette of its own, like an image, and
 * an image keeps its own background in dark mode too.
 */
export function previewDocument(html: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">
<style>
html { color-scheme: light; background: #ffffff; }
/* The frame is sized by the host and clipped by it; nothing in here scrolls. */
html, body { margin: 0; padding: 0; overflow: hidden; }
body { padding: 12px; box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
</style>
${html}
`;
}

/**
 * A diagram, drawn by the browser, in a frame that cannot run a line of code.
 *
 * ## The threat, stated once
 *
 * **Anyone can email `<name>@context.lc`** — that is the ingestion design, not
 * a gap in it. So a note this renders may have been written by a stranger, and
 * the console it renders in holds a live authenticated Convex connection. The
 * danger was never HTML or CSS; it is script execution inside that session.
 *
 * ## The mitigation is one attribute, and it is the browser's
 *
 * A `sandbox` attribute with an empty value denies **everything** the frame
 * could otherwise do, script execution included. There is no allow-list to keep
 * current and nothing of ours to get wrong.
 *
 *  - **`allow-scripts` is never added.** It would run the note's JavaScript, in
 *    an opaque origin — which still reaches `fetch`, `postMessage` to the
 *    parent, and anything the parent listens for.
 *  - **`allow-same-origin` is never added.** Together with `allow-scripts` the
 *    two are worse than either: a frame that is same-origin *and* scripted can
 *    reach `parent.document` and remove its own `sandbox` attribute.
 *
 * `__tests__/livePreview.test.ts` asserts on the attribute; `e2e/webkit/`
 * asserts that a `<script>` in the fence does not run, which is the half jsdom
 * cannot prove — jsdom does not enforce iframe sandboxing at all, so a green
 * jsdom test about script execution would be a false green.
 *
 * ## Why `pointer-events: none` on the frame
 *
 * The frame is a separate document and swallows its own clicks. Without this
 * there is no pointer route back to the source at all: you could see the
 * diagram and never click into the fence that draws it, which is precisely the
 * "an editor that hides syntax you cannot edit" failure this file exists to
 * avoid. The preview has nothing to interact with anyway — no scripts, and a
 * link in a bare-sandbox frame cannot navigate.
 */
export class HtmlPreviewWidget extends WidgetType {
  constructor(private readonly html: string) {
    super();
  }
  /*
    Compared on the markup, and load-bearing rather than an optimisation: the
    decoration set is rebuilt on every keystroke and every cursor move, and a
    widget that reported itself new each time would tear the iframe down and
    reload its document under the reader's eyes several times a second.
  */
  eq(other: HtmlPreviewWidget): boolean {
    return other.html === this.html;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-preview";
    const frame = document.createElement("iframe");
    frame.className = "cm-lp-preview-frame";
    /*
      The empty string is the value that denies everything. `setAttribute` with
      "" rather than a property assignment, because `frame.sandbox = ""` writes
      through a `DOMTokenList` and reads back as an empty list that is easy to
      mistake for an absent attribute in a test. The attribute is the security
      model; it is set in the plainest way there is.
    */
    frame.setAttribute("sandbox", "");
    frame.setAttribute("srcdoc", previewDocument(this.html));
    // A frame with no title is an unlabelled region to a screen reader, and
    // there is nothing inside this one it could read out instead.
    frame.setAttribute("title", "Rendered preview");
    frame.setAttribute("loading", "lazy");
    wrap.append(frame);
    return wrap;
  }
  /* A click on the preview should place the caret, which is what reveals it. */
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Tick and untick a checkbox by pressing it.
 *
 * A drawn checkbox that does nothing when it is pressed is worse than the `[ ]`
 * it replaced, because the `[ ]` never looked like a control. This edits the
 * three characters in the buffer — there is no other state — so the file is
 * exactly what somebody would have typed, and undo undoes it like any edit.
 *
 * Refused on a read-only note, for the reason `editorSetup`'s `runCommand`
 * states: `changeFilter` would drop the change anyway, but a refused
 * transaction still moves the selection and lands in the history.
 */
const taskToggle = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;
    /*
      `closest`, not `classList.contains`: the press usually lands on the drawn
      box *inside* the widget rather than on the widget itself, and the first
      version tested the class on the target alone — so the checkbox answered a
      press only on the sliver of padding around it.
    */
    const widget = target.closest(".cm-lp-task");
    if (widget === null) return false;
    if (view.state.readOnly) return false;
    /*
      `posAtDOM` answers where the widget sits, which is where the marker it
      replaced starts. Resolving one character in rather than at the boundary
      is what lands inside the node instead of beside it.
    */
    const at = view.posAtDOM(widget) + 1;
    const marker = nodeAt(syntaxTree(view.state).resolveInner(at, 1), "TaskMarker");
    if (marker === null) return false;
    view.dispatch({
      changes: {
        from: marker.from,
        to: marker.to,
        insert: isTicked(view.state.doc, marker.from, marker.to) ? "[ ]" : "[x]",
      },
      userEvent: "input",
    });
    // Claimed, so the press does not also drop a caret in the middle of the
    // three characters it just rewrote — which would reveal the markup and
    // replace the box the person is looking at with `[x]`.
    event.preventDefault();
    return true;
  },
});

/** `node`, or its nearest ancestor of that name, or `null`. */
function nodeAt(node: SyntaxNode | null, name: string): SyntaxNode | null {
  for (let current = node; current !== null; current = current.parent) {
    if (current.name === name) return current;
  }
  return null;
}

/**
 * Build the full decoration set for a state.
 *
 * Two passes over one iteration: styling is unconditional (a heading is drawn
 * large whether or not the cursor is in it — that is the "live" in Live
 * Preview), and hiding is conditional on the selection.
 *
 * Mark decorations must be added before replace decorations at the same
 * position, which is why styles and hides are collected separately and
 * concatenated rather than pushed as they are found.
 */
/**
 * The selection the reveal rule may act on.
 *
 * NOTHING REVEALS IN A DOCUMENT NOBODY CAN TYPE INTO. Markup comes back when
 * the caret enters it, because you cannot edit syntax you cannot see. A
 * read-only document has no caret to enter anything with — `editability` drops
 * `contenteditable` — but `state.selection` is still a range at 0, so the
 * note's first construct would draw its own asterisks at a reader who cannot
 * act on them, and an HTML preview at the top of a note would sit there as its
 * own source.
 *
 * So read-only is an empty selection, which is the same sentence the reveal
 * rule already makes: reveal for editing, and there is no editing. One
 * condition covers reading mode, `privacy.md` and an encrypted envelope, and it
 * is `state.readOnly` rather than a flag of this extension's own so there is
 * nothing for the two to disagree about.
 *
 * Both callers take it from here rather than each mapping the ranges, because
 * the two are one rule: `htmlPreviews` withdrawing a preview while
 * `decorationsFor` keeps the markup hidden is a half-revealed note.
 */
function revealSelection(state: EditorState): Array<{ from: number; to: number }> {
  if (state.readOnly) return [];
  return state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
}

export function decorationsFor(state: EditorState): DecorationSet {
  const tree = syntaxTree(state);
  const selection = revealSelection(state);

  /*
    Frontmatter is decided from the text, before the tree is consulted, and
    everything the tree says inside it is discarded — see `frontmatterRange`.
    The grammar reads the closing `---` as a setext underline, so without this
    a note's metadata is drawn as its largest heading.
  */
  const front = frontmatterRange(state.doc.toString());
  /*
    Passed to the three list/table passes below rather than recomputed by each
    of them, which is not only tidiness: `frontmatterRange` reads the whole
    document as a string, and this runs on every keystroke and every cursor
    move. One read, four consumers.
  */
  const frontEnd = front === null ? 0 : front.to;

  const lines: Range<Decoration>[] = [];
  if (front !== null) {
    for (
      let line = state.doc.lineAt(front.from);
      line.from <= front.to;
      line = state.doc.lineAt(line.to + 1)
    ) {
      lines.push(frontmatterLine.range(line.from));
      if (line.to >= state.doc.length) break;
    }
  }

  /*
    A list item's wrapped lines clear its own marker, and a table's lines are
    drawn in the mono face. Both are line decorations, so both join the block
    above rather than the mark pass below — see `hangingIndents` and
    `tableLines`.
  */
  for (const indent of hangingIndents(state, frontEnd)) {
    lines.push(
      Decoration.line({
        class: "cm-lp-li",
        attributes: {
          style: `padding-left:${indent.columns}ch;text-indent:-${indent.columns}ch`,
        },
      }).range(indent.from),
    );
  }
  /*
    A table is either laid out or left as its own pipes, never both: a line
    decoration inside a block replacement is a range set describing two
    different things for the same characters. `tableGrids` is empty unless the
    note is read-only, so an editable note still gets the mono face on every
    row, and a read-only one whose table `readTable` refused falls back to it.
  */
  const grids = tableGrids(state, frontEnd);
  const insideGrid = (pos: number): boolean =>
    grids.some((grid) => pos >= grid.from && pos < grid.to);
  for (const from of tableLines(state, frontEnd)) {
    if (insideGrid(from)) continue;
    lines.push(Decoration.line({ class: "cm-lp-table" }).range(from));
  }

  /*
    A finished task's text, drawn as finished. In the *unconditional* pass and
    not with the box, because being done is what the note says rather than
    markup somebody is editing — see `completedTasks`. Collected here so it
    sorts with the other marks; `styles` below is built in tree order and this
    is not.
  */
  const doneText = completedTasks(state, frontEnd).map((range) =>
    Decoration.mark({ class: "cm-lp-task-done" }).range(range.from, range.to),
  );

  /*
    A fence tagged `html-preview` is replaced wholesale by the diagram it
    describes — see `htmlPreviews`. Computed before the two passes below because
    both of them have to keep out of the range it swallows: a mark decoration or
    a hidden ```` ``` ```` sitting inside a block replacement is a range set
    describing two different things for the same characters, and the note that
    has both is the one that would find out.
  */
  const previews = htmlPreviews(state, frontEnd);
  /*
    A `form` fence is replaced the same way, and by the same rule about the two
    passes below keeping out of it — see `formFences`. It is a separate list
    rather than another kind of `HtmlPreview` because the two are opposites at
    the point that matters: a diagram is drawn from markup the note supplies and
    must be sandboxed away from this document, and a form is built from a parsed
    declaration and has to live *in* it to be usable.

    Empty unless the note is read-only, which is the whole of the reveal rule
    for forms.
  */
  const forms = formFences(state, frontEnd);
  const insidePreview = (pos: number): boolean =>
    previews.some((preview) => pos >= preview.from && pos < preview.to) ||
    forms.some((form) => pos >= form.from && pos < form.to) ||
    insideGrid(pos);

  const styles: Range<Decoration>[] = [];
  tree.iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      const className = styleClassFor(node.name);
      if (className === null) return;
      if (node.to <= node.from) return;
      // Inside the frontmatter the tree is describing a heading that is not
      // one. Drawn plain instead, by the line decoration above.
      if (front !== null && node.from < front.to) return;
      if (insidePreview(node.from)) return;
      styles.push(Decoration.mark({ class: className }).range(node.from, node.to));
    },
  });

  // `hiddenMarkRanges` excludes the frontmatter itself — see its own comment.
  const hides = hiddenMarkRanges(tree, selection, state.doc.length, state.doc)
    .filter((range) => !insidePreview(range.from))
    .map((range) => hideMark.range(range.from, range.to));

  /*
    `block: true` because this stands in for whole lines rather than for a run
    of characters inside one — which is also why `htmlPreviews` refuses a fence
    that does not start at the margin.
  */
  for (const preview of previews) {
    hides.push(
      Decoration.replace({
        widget: new HtmlPreviewWidget(preview.html),
        block: true,
      }).range(preview.from, preview.to),
    );
  }

  /*
    The host is read off the state rather than passed in, so `decorationsFor`
    stays a pure function of it — see `formHost`. A surface that configured none
    yields `null`, and the widget draws with its button disabled.
  */
  const host = state.facet(formHost);
  for (const form of forms) {
    hides.push(
      Decoration.replace({
        widget: new FormWidget(form, host),
        block: true,
      }).range(form.from, form.to),
    );
  }

  /*
    And the tables, by the same rule about the passes above keeping out of the
    range a block widget swallows. `tableGrids` has already refused anything
    that does not occupy whole lines.
  */
  for (const grid of grids) {
    hides.push(
      Decoration.replace({
        widget: new TableGridWidget(grid),
        block: true,
      }).range(grid.from, grid.to),
    );
  }

  /*
    Bullets and checkboxes are replacements rather than styles — the characters
    that mean them are taken off the screen and a glyph is drawn instead — so
    they belong with the hides, and they obey the same reveal rule. See
    `listGlyphs`.
  */
  for (const glyph of listGlyphs(state, frontEnd)) {
    hides.push(
      Decoration.replace({
        widget:
          glyph.kind === "bullet" ? new BulletWidget() : new TaskWidget(glyph.checked),
      }).range(glyph.from, glyph.to),
    );
  }

  // `sort: true` because the two lists interleave: a heading's style starts
  // before its own `##` mark ends, so neither list alone is in document order
  // once they are concatenated.
  return RangeSet.of([...lines, ...styles, ...doneText, ...hides], true);
}

/**
 * The extension: recompute whenever the answer can have changed.
 *
 * A `StateField` rather than a `ViewPlugin` because the decorations depend on
 * the selection, and a view plugin that maps its own decorations through
 * transactions would have to invalidate them on every cursor move anyway —
 * which is the entire workload. Recomputing from the tree is simpler and is
 * what makes `decorationsFor` a pure function worth testing.
 *
 * ## The three inputs, and the one that was missed
 *
 * `decorationsFor` reads exactly three things out of the state: the document,
 * the selection, and **`readOnly`**. The first two are what a transaction
 * obviously carries. The third is configuration, and it changes by a route that
 * carries neither — `LiveEditor`'s compartment swapping `editability(…)` when
 * the eye is pressed — so a guard of "document or selection" let the whole of
 * reading mode go stale.
 *
 * On screen that was the bug this comment exists for: **pressing the eye did
 * nothing until you clicked into the note.** A form fence stayed as its own
 * source, a table stayed as its pipes, and the markup a reader is not supposed
 * to see stayed revealed — all of it correct again the instant any click
 * produced a selection transaction and the cached set was finally thrown away.
 *
 * `readOnly` is compared rather than `transaction.reconfigured` being trusted,
 * and the difference is not pedantry in both directions:
 *
 *  - A reconfigure that leaves `readOnly` alone cannot change a decoration, and
 *    rebuilding the whole set from the tree is the work this field does per
 *    keystroke. Redoing it for an unrelated facet is waste on the hottest path
 *    here.
 *  - More importantly it says *what is actually being watched*. A fourth input
 *    added to `decorationsFor` later is a line to add here, and a condition
 *    naming `readOnly` is one somebody reads and notices; `reconfigured` is one
 *    that looks like it already covers everything and does not.
 */
export function livePreview() {
  const decorations = StateField.define<DecorationSet>({
    create: (state) => decorationsFor(state),
    update(value, transaction) {
      const readOnlyChanged = transaction.startState.readOnly !== transaction.state.readOnly;
      /*
        And the tree, which arrives late on a note of any size. CodeMirror parses
        the first few thousand characters synchronously and finishes the rest on
        an idle callback, announcing it with a transaction that carries no
        document change, no selection and no change of `readOnly` — the third
        input, by a fourth route. Without this a reader scrolling past roughly
        the first screen of a long note finds raw markdown below it until a
        click, which is the same symptom the `readOnly` comparison above was
        added to kill.

        Identity, not contents: the language state hands back a new `Tree` when
        it has parsed further, and the same one otherwise.
      */
      const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
      if (!transaction.docChanged && !transaction.selection && !readOnlyChanged && !treeChanged) {
        return value;
      }
      return decorationsFor(transaction.state);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  // The one place this extension is more than decorations: a drawn checkbox has
  // to answer a press. See `taskToggle`.
  return [decorations, taskToggle];
}

/**
 * How the rendered document looks.
 *
 * Sizes and colours come from `features/design/tokens` via CSS custom
 * properties set on the wrapper, so this file states relationships (a heading
 * is 1.6× body) and the theme states values. Deliberately not a full typographic
 * system: this is a note editor, and a document that looks like a magazine is
 * harder to edit than one that looks like a document.
 */
export const livePreviewStyles = `
.cm-lp-h1, .cm-lp-h2, .cm-lp-h3, .cm-lp-h4, .cm-lp-h5, .cm-lp-h6 {
  font-weight: 600;
  color: var(--lp-heading);
  line-height: 1.3;
}
/*
  Measured off Obsidian mobile rather than chosen: 1.625em, 1.3em and 1.15em
  against a 16px body. The multiples were 1.7 / 1.4 / 1.2, which is a wider
  ladder than a document needs and made an H1 the loudest thing on a phone
  screen that is mostly body text.
*/
.cm-lp-h1 { font-size: 1.625em; }
.cm-lp-h2 { font-size: 1.3em; }
.cm-lp-h3 { font-size: 1.15em; }
.cm-lp-h4, .cm-lp-h5, .cm-lp-h6 { font-size: 1.05em; }
/*
  A note's metadata, drawn as metadata. Not hidden: the buffer is the Markdown,
  and a block the editor refuses to show is a block you cannot fix. See
  frontmatterRange above for what this replaced. (No backticks in this comment:
  it is inside a template literal and one would end the string.)
*/
.cm-lp-frontmatter {
  font-family: var(--lp-mono);
  font-size: 0.82em;
  line-height: 1.7;
  color: var(--lp-muted);
}
.cm-lp-strong { font-weight: 650; color: var(--lp-heading); }
.cm-lp-em { font-style: italic; }
.cm-lp-strike { text-decoration: line-through; opacity: 0.7; }
.cm-lp-code {
  font-family: var(--lp-mono);
  font-size: 0.92em;
  background: var(--lp-code-bg);
  border-radius: 4px;
  padding: 0.1em 0.32em;
}
.cm-lp-fence {
  font-family: var(--lp-mono);
  font-size: 0.92em;
  background: var(--lp-code-bg);
}
/*
  R3 in the sweep: a fence in one of the three languages the bundle already
  carries (see FENCE_LANGUAGES) is coloured with tokens this file already has
  rather than a new one — see fenceHighlightStyle's own comment for why.
*/
.cm-lp-code-keyword { color: var(--lp-link); }
.cm-lp-code-string { color: var(--lp-heading); }
.cm-lp-code-comment { color: var(--lp-muted); font-style: italic; }
/*
  A rendered html-preview fence. See HtmlPreviewWidget for what is inside the
  frame and why nothing inside it can run.

  ## The height is fixed, and that is a gap rather than a choice

  Nothing here can measure the frame. Sizing an iframe to its content means
  script inside it reporting a height out, and script inside it is the one thing
  this feature never allows; the frame is also cross-origin by construction, so
  the host cannot reach in and read it either. So the box is a number, and it
  errs tall: a diagram drawn short leaves empty space under it, and a diagram
  drawn tall loses its bottom third. The second is the failure a reader notices.

  ## overflow: hidden is not tidying

  The markup in the fence may have been emailed in by a stranger, and a layout
  that escapes its box draws over real console UI — a toolbar, a save state, a
  privacy control. The clip is on the wrapper, so nothing the frame's own CSS
  does can widen it, and max-height keeps the box inside the viewport on a phone
  where 620px is most of the screen.

  pointer-events: none on the frame is what lets a click reach the editor and
  reveal the source. See the widget's comment.
*/
.cm-lp-preview {
  overflow: hidden;
  margin: 0.5em 0;
  border: 1px solid var(--lp-code-bg);
  border-radius: 8px;
  background: var(--lp-code-bg);
}
.cm-lp-preview-frame {
  display: block;
  width: 100%;
  height: 620px;
  max-height: 80vh;
  border: 0;
  pointer-events: none;
}
.cm-lp-quote { color: var(--lp-muted); font-style: italic; }
.cm-lp-link { color: var(--lp-link); text-decoration: underline; }
/*
  A list item's indent is arithmetic rather than taste, and it is not here: the
  padding and the negative text-indent are one number set per line by the
  decoration, because it depends on how wide that item's own marker is, so the
  first line starts at the margin with its marker and every wrapped line clears
  it. See hangingIndents. What is here is only the marker's colour.
*/
.cm-lp-list-mark { color: var(--lp-muted); }
/*
  Both widgets hold the width of the characters they replaced, so the hanging
  indent above stays true on a wrapped line. A bullet stands in for one
  character and a checkbox for three.

  ## text-indent: 0 is not tidying, it is the whole of "bullets look broken"

  The hanging indent is padding-left:Nch with text-indent:-Nch on the line,
  which puts the first line's content back at the margin and every wrapped line
  clear of the marker. TEXT-INDENT IS INHERITED, and both of these are
  inline-level boxes with their own inner line box — so each widget applied the
  line's negative indent a second time, inside itself. Measured in a browser at
  390pt: the bullet glyph drew at -20.4px, a full indent OUTSIDE the reading
  margin, while the text after it started correctly at 10.2px. A bullet adrift
  in the left gutter, a third of an inch from the line it belongs to — and a
  nested item, whose indent is twice as deep, drew its bullet off the left edge
  of the screen entirely.

  An ordered list was never affected and that is the tell: "1." is real text,
  not a widget, so it took the indent once and landed correctly. Only what was
  replaced went wrong.
*/
.cm-lp-bullet {
  display: inline-block;
  width: 1ch;
  text-indent: 0;
  color: var(--lp-muted);
}
/*
  The checkbox, and the reason it is drawn rather than written.

  It used to be the character U+2610, which is text: it takes the body font's
  weight, it is a different shape in every font that has it, plenty of fonts do
  not have it at all, and none of them looks like something you press. A border
  and a radius do not depend on a font being installed and do not change weight
  when the text around them does.

  The outer span is the three columns the source characters occupied and the box
  is centred in them, so a list mixing tasks and plain items keeps its text in
  one column.
*/
.cm-lp-task {
  display: inline-flex;
  align-items: center;
  /* Inherited text-indent, for .cm-lp-bullet's reason. */
  text-indent: 0;
  justify-content: center;
  width: 3ch;
  cursor: pointer;
  /* The press is the whole point; the system callout is the other thing that
     answers a long press over it. */
  -webkit-touch-callout: none;
}
.cm-lp-task-box {
  position: relative;
  box-sizing: border-box;
  width: 0.95em;
  height: 0.95em;
  border: 1.5px solid var(--lp-muted);
  border-radius: 3px;
  /* A hair below the text baseline, where a checkbox sits beside a line of
     prose rather than floating in the middle of it. */
  transform: translateY(0.04em);
}
.cm-lp-task-on .cm-lp-task-box {
  background: var(--lp-link);
  border-color: var(--lp-link);
}
/*
  The tick: two borders on a rotated box, which is the construction that needs
  no font and no image. Drawn in the editor background so it reads as cut out of
  the filled square rather than painted on it.
*/
.cm-lp-task-on .cm-lp-task-box::after {
  content: "";
  position: absolute;
  left: 0.27em;
  top: 0.09em;
  width: 0.17em;
  height: 0.40em;
  border: solid var(--lp-bg);
  border-width: 0 1.6px 1.6px 0;
  transform: rotate(45deg);
}
/*
  A finished task, drawn as finished — the half of a checkbox that a one-column
  glyph could never carry. This is what lets somebody skim a list and see what
  is left without reading it.
*/
.cm-lp-task-done {
  color: var(--lp-muted);
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}
/*
  AN EDITABLE table is not laid out — the pipes are still the author's — but it
  is drawn in the mono face, which is what makes the columns of a table that
  fits line up. A reader gets the grid below instead. See tableLines and
  tableGrids.
*/
.cm-lp-table {
  font-family: var(--lp-mono);
  font-size: 0.86em;
}
.cm-lp-table-delim { color: var(--lp-muted); }
/*
  A TABLE, LAID OUT FOR A READER.

  Hairlines and nothing else: no outer box, no fill, no zebra. A table in a
  note is part of the document rather than a panel sitting on it, and every
  edge spent here is an edge competing with the note's own structure. What
  separates the header from the body is one stronger rule, which is the only
  place this needs weight.

  The scroller is the wrapper, so a table wider than the measure scrolls in its
  own box rather than dragging the whole note sideways.
*/
.cm-lp-grid {
  overflow-x: auto;
  margin: 0.4em 0;
}
.cm-lp-grid-table {
  border-collapse: collapse;
  /*
    Sized by its content rather than stretched to the measure. A two-column
    table pushed to full width puts a hand-span of nothing between the label
    and its value, which is harder to read than the pipes were.
  */
  width: auto;
  max-width: 100%;
  font-size: 0.94em;
  line-height: 1.5;
  /* Digits in a column line up, which is most of why a column of them exists. */
  font-variant-numeric: tabular-nums;
}
.cm-lp-grid-table th {
  font-weight: 600;
  color: var(--lp-heading);
  text-align: left;
  padding: 7px 14px 8px;
  border-bottom: 1px solid var(--lp-line-strong);
  /*
    A header is a label, and a label that wraps to two lines over a one-line
    column is the table drawing attention to its own chrome.
  */
  white-space: nowrap;
}
.cm-lp-grid-table td {
  padding: 8px 14px;
  border-top: 1px solid var(--lp-line);
  vertical-align: top;
  color: var(--lp-content);
}
/*
  The outer columns lose their side padding, so the grid's own edges line up
  with the paragraph above it. Without this a table reads as indented from the
  text around it by however much cell padding happens to be, which is the one
  thing that gives away a rendered block as a rendered block.
*/
.cm-lp-grid-table tr > :first-child { padding-left: 0; }
.cm-lp-grid-table tr > :last-child { padding-right: 0; }
.cm-lp-grid-left { text-align: left; }
.cm-lp-grid-center { text-align: center; }
.cm-lp-grid-right { text-align: right; }
/*
  An empty cell says so. Drawn as nothing it is indistinguishable from a column
  that failed to render, and a reader cannot tell which they are looking at.
*/
.cm-lp-grid-empty::after {
  content: "—";
  color: var(--lp-muted);
}
.cm-lp-rule { color: var(--lp-muted); }
/*
  A FORM, DRAWN FROM ITS DECLARATION.

  Every colour here is one of the --lp-* properties the host already sets from
  the palette in force, so the form follows the theme without this file naming a
  single value — the rule the rest of these styles follow. --lp-code-bg is the
  one that does the most work: it is a translucent ink rather than a fixed grey,
  so it darkens a light ground and lightens a dark one, which is exactly what a
  field's fill and a card's hairline both want.

  The card is the same object as the note around it rather than a panel floating
  over it: one hairline, the page's own background, and the reading measure. A
  raised surface would be a second document inside the note, which is what the
  diagram frame beside it is and what a form is not.
*/
.cm-lp-form {
  /*
    A real hairline. This was --lp-code-bg, which is the code fence's FILL:
    #F5F5F5 on a #FFFFFF ground, so in light mode the card had no visible edge
    at all and the form read as loose controls dropped into the note. --lp-line
    is the palette's own separator and is the same value every hairline in the
    app is drawn in.
  */
  border: 1px solid var(--lp-line);
  /*
    One radius family — 10 on the card, 8 on the field, 8 on the button. It was
    12 / 9 / 11, three radii no two of which agreed, which is what made a small
    card read as three unrelated objects stacked up.
  */
  border-radius: 10px;
  /* The padding belongs to the three bands inside, so their rules can run edge
     to edge. */
  overflow: hidden;
  margin: 0.6em 0;
  font-family: var(--lp-body);
  font-size: 0.94em;
  line-height: 1.45;
  color: var(--lp-content);
}
/*
  WHAT THIS BOX IS, AND WHERE WHAT YOU TYPE GOES.

  See FormWidget.drawHead. The destination is the half that earns the strip:
  responses live in a sister note by design, and a reader had no way to learn
  which one before pressing Submit.
*/
.cm-lp-form-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 9px 14px;
  border-bottom: 1px solid var(--lp-line);
  background: var(--lp-code-bg);
}
.cm-lp-form-kind {
  font-family: var(--lp-mono);
  font-size: 0.72em;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lp-muted);
}
.cm-lp-form-dest { font-size: 0.82em; color: var(--lp-muted); }
.cm-lp-form-dest-path { font-family: var(--lp-mono); color: var(--lp-content); }
.cm-lp-form-fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
}
.cm-lp-form-row { display: flex; flex-direction: column; gap: 6px; }
/* The label and its character count, on one line. */
.cm-lp-form-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
/*
  A field's name is its label verbatim, with underscores spaced out. Sentence
  case is left alone rather than title-cased: the author wrote the name, and a
  form that renames somebody's field on screen is a form whose error messages
  are about a field they cannot find.
*/
.cm-lp-form-label {
  /*
    Small, spaced and upper-case: a field name is a label rather than a
    sentence, and at 0.85em in sentence case it read as body copy that happened
    to be grey — the note's own prose and the form's chrome in the same voice.
    The name itself is still verbatim; see drawField.
  */
  font-size: 0.76em;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--lp-muted);
}
/*
  The word rather than an asterisk. An asterisk has to be learned, is invisible
  to a screen reader that announces punctuation differently, and at 0.85em is
  three pixels of ink carrying the difference between a form that submits and
  one that is refused.
*/
.cm-lp-form-required {
  font-weight: 500;
  /* Not upper-cased with the name: it is a note about the field, not part of
     what the field is called. */
  text-transform: none;
  letter-spacing: 0.02em;
  color: var(--lp-muted);
  opacity: 0.85;
}
.cm-lp-form-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-family: var(--lp-body);
  color: var(--lp-content);
  background: var(--lp-code-bg);
  /*
    A real border at rest rather than a transparent one. A filled slab with no
    edge is a block of colour; the edge is what says "you type in here", and
    without it the only thing distinguishing a field from a code span was its
    width.
  */
  border: 1px solid var(--lp-line-strong);
  border-radius: 8px;
  padding: 8px 10px;
  /* Safari draws its own rounded fill over the one above without this. */
  -webkit-appearance: none;
  appearance: none;
}
.cm-lp-form-input::placeholder { color: var(--lp-muted); opacity: 0.7; }
/* The two controls that are meaningless at full width and a target at 18px. */
.cm-lp-form-input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--lp-link); }
.cm-lp-form-input[type="date"], .cm-lp-form-input[type="number"] { width: auto; min-width: 10em; }
.cm-lp-form-input:focus {
  outline: none;
  border-color: var(--lp-link);
  /*
    A ring as well as the border. The border alone moves one pixel of colour on
    focus, which is not enough to find the field you just tabbed to — and this
    is the control a keyboard user reaches Submit through.
  */
  box-shadow: 0 0 0 3px var(--lp-focus-ring);
}
textarea.cm-lp-form-input { resize: vertical; min-height: 5em; }
/*
  Right-aligned under the box it counts, in the muted ink: it is a fact about
  the room left rather than a message, and reading order should reach the next
  field before it.
*/
.cm-lp-form-count {
  font-size: 0.76em;
  color: var(--lp-muted);
  /* Digits that change under the reader's eye must not move the label. */
  font-variant-numeric: tabular-nums;
}
.cm-lp-form-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 11px 14px;
  /* The action is separated from the fields rather than being the next thing
     in the stack — pressing it is not the same kind of act as filling one in. */
  border-top: 1px solid var(--lp-line);
}
/*
  The app's primary button, in CSS: the accent fill, white ink, 11px corners and
  a 15px label. It is the one filled thing in the note, which is what a button
  in a document should be.
*/
.cm-lp-form-submit {
  font: inherit;
  font-family: var(--lp-body);
  font-weight: 600;
  color: #ffffff;
  background: var(--lp-link);
  border: none;
  border-radius: 8px;
  padding: 7px 16px;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}
.cm-lp-form-submit:focus-visible { outline: 2px solid var(--lp-link); outline-offset: 2px; }
.cm-lp-form-submit:disabled { opacity: 0.45; cursor: default; }
.cm-lp-form-status { font-size: 0.88em; color: var(--lp-muted); }
.cm-lp-form-status-ok { color: var(--lp-link); font-weight: 600; }
/*
  A refusal is drawn in the muted ink at full weight rather than in red. There
  is no --lp-danger, and inventing a hex here would be the one colour in this
  file that does not follow the theme — the failure the file's own header names.
  Weight carries it, and the words carry the rest.
*/
.cm-lp-form-status-bad { color: var(--lp-content); font-weight: 600; }
.cm-lp-form-status-quiet { opacity: 0.75; }
/*
  The sister file's rows, as the card's fourth band.

  Its own padding and no margin, because the card is now edge-to-edge bands
  separated by rules (see .cm-lp-form) rather than one padded box — a margin
  here would inset the rule and leave the rows flush against the border. The
  title takes the same small upper-case voice as a field label, so the two
  headings inside one card agree.
*/
.cm-lp-form-responses {
  border-top: 1px solid var(--lp-line);
  padding: 14px;
}
.cm-lp-form-responses-title {
  font-weight: 600;
  font-size: 0.76em;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--lp-muted);
  margin-bottom: 8px;
}
.cm-lp-form-responses-status { color: var(--lp-muted); font-size: 0.88em; }
.cm-lp-form-responses-scroll { overflow-x: auto; }
.cm-lp-form-responses-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
}
.cm-lp-form-responses-table th,
.cm-lp-form-responses-table td {
  border-bottom: 1px solid var(--lp-line);
  padding: 8px 10px 8px 0;
  text-align: left;
  vertical-align: top;
}
.cm-lp-form-responses-table th { color: var(--lp-muted); font-size: 0.88em; font-weight: 600; }
.cm-lp-form-voters { color: var(--lp-muted); white-space: nowrap; }
.cm-lp-form-vote-controls { display: flex; gap: 6px; margin-top: 6px; white-space: nowrap; }
.cm-lp-form-response-controls { display: flex; gap: 6px; white-space: nowrap; }
.cm-lp-form-vote {
  border: 1px solid var(--lp-line-strong);
  border-radius: 8px;
  padding: 4px 8px;
  color: var(--lp-link);
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.cm-lp-form-vote:disabled { opacity: 0.45; cursor: default; }
.cm-lp-form-vote-remove { color: var(--lp-muted); }
.cm-lp-form-response-action {
  border: 1px solid var(--lp-line-strong);
  border-radius: 8px;
  padding: 4px 8px;
  color: var(--lp-link);
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.cm-lp-form-response-action:disabled { opacity: 0.45; cursor: default; }
.cm-lp-form-delete { color: var(--lp-muted); }
/*
  "We can't display because the formatting is off", which is what the owner
  asked for. Dashed rather than solid so it reads as a gap in the note that
  something should fill, and muted rather than loud: a form that will not parse
  is the author's problem to fix and nobody else's to be alarmed by.
*/
.cm-lp-form-broken {
  border-style: dashed;
  border-color: var(--lp-line-strong);
  color: var(--lp-muted);
  /* No head, no fields, no foot — so this one carries its own padding. */
  padding: 14px;
}
.cm-lp-form-broken-title { font-weight: 600; color: var(--lp-content); }
.cm-lp-form-broken-why { font-family: var(--lp-mono); font-size: 0.85em; margin-top: 4px; }
.cm-lp-form-hint { font-size: 0.85em; margin-top: 6px; }
`;
