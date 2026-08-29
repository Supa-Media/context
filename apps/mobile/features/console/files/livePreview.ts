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

import { EditorState, Range, RangeSet, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
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
  return markdown({ extensions: [GFM] });
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

  tree.iterate({
    from: 0,
    to: docLength,
    enter(node) {
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
    default:
      return null;
  }
}

const hideMark = Decoration.replace({});

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

  const styles: Range<Decoration>[] = [];
  tree.iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      const className = styleClassFor(node.name);
      if (className === null) return;
      if (node.to <= node.from) return;
      styles.push(Decoration.mark({ class: className }).range(node.from, node.to));
    },
  });

  const hides = hiddenMarkRanges(tree, selection, state.doc.length, state.doc).map((range) =>
    hideMark.range(range.from, range.to),
  );

  // `sort: true` because the two lists interleave: a heading's style starts
  // before its own `##` mark ends, so neither list alone is in document order
  // once they are concatenated.
  return RangeSet.of([...styles, ...hides], true);
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
  return StateField.define<DecorationSet>({
    create: (state) => decorationsFor(state),
    update(value, transaction) {
      if (!transaction.docChanged && !transaction.selection) return value;
      return decorationsFor(transaction.state);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
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
  line-height: 1.25;
}
.cm-lp-h1 { font-size: 1.7em; }
.cm-lp-h2 { font-size: 1.4em; }
.cm-lp-h3 { font-size: 1.2em; }
.cm-lp-h4, .cm-lp-h5, .cm-lp-h6 { font-size: 1.05em; }
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
.cm-lp-quote { color: var(--lp-muted); font-style: italic; }
.cm-lp-link { color: var(--lp-link); text-decoration: underline; }
`;
