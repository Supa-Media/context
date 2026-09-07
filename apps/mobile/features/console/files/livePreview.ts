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
export function decorationsFor(state: EditorState): DecorationSet {
  const tree = syntaxTree(state);
  const selection = state.selection.ranges.map((range) => ({
    from: range.from,
    to: range.to,
  }));

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
  for (const from of tableLines(state, frontEnd)) {
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
      styles.push(Decoration.mark({ class: className }).range(node.from, node.to));
    },
  });

  // `hiddenMarkRanges` excludes the frontmatter itself — see its own comment.
  const hides = hiddenMarkRanges(tree, selection, state.doc.length, state.doc).map((range) =>
    hideMark.range(range.from, range.to),
  );

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
 * The extension: recompute on every document or selection change.
 *
 * A `StateField` rather than a `ViewPlugin` because the decorations depend on
 * the selection, and a view plugin that maps its own decorations through
 * transactions would have to invalidate them on every cursor move anyway —
 * which is the entire workload. Recomputing from the tree is simpler and is
 * what makes `decorationsFor` a pure function worth testing.
 */
export function livePreview() {
  const decorations = StateField.define<DecorationSet>({
    create: (state) => decorationsFor(state),
    update(value, transaction) {
      if (!transaction.docChanged && !transaction.selection) return value;
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
  A table is not laid out — the pipes are still the author's — but it is drawn
  in the mono face, which is what makes the columns of a table that fits line
  up. See tableLines.
*/
.cm-lp-table {
  font-family: var(--lp-mono);
  font-size: 0.86em;
}
.cm-lp-table-delim { color: var(--lp-muted); }
.cm-lp-rule { color: var(--lp-muted); }
`;
