/**
 * The reveal rule for inline syntax: which marks hide, which node is the unit
 * that reveals them, and the class each formatted node is drawn with.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import type { SyntaxNode, Tree } from "@lezer/common";
import { frontmatterRange } from "./frontmatter";

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
export const HIDDEN_MARKS: ReadonlySet<string> = new Set([
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

export function isHiddenPlumbing(node: SyntaxNode): boolean {
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
export function swallowTrailingSpace(
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

  /*
    **A wiki link is drawn as its words, and the grammar cannot help.**

    `[[…]]` is not a node. The lezer Markdown dialect reads it as an ordinary
    `Link` around the inner `[…]`, so hiding that link's own marks — right for
    `[label](url)` — takes the *inner* bracket from each end and leaves the
    outer one, with the target and the pipe still in the middle of the
    sentence. `[[1-projects/foo/overview|Open the project]]` came out as
    `[1-projects/foo/overview|Open the project]`, which is what a screenshot
    reported. `cellRuns` has said this in its header the whole time and solved
    it for a table cell; outside one, nothing did.

    So the spans are found here, the same shape `noteLinksIn` parses, and this
    pass **owns them whole**: every node inside one is skipped below, because
    the grammar's answer for those characters is the wrong one and two
    decorations over the same text is the overlap this file warns about
    elsewhere.

    What is left visible is the alias where there is one and the target where
    there is not — never nothing. An empty alias (`[[path|]]`) is a typo in
    progress, and drawing it as an empty span would make the link invisible
    and unfixable without selecting blindly across it, so that falls back to
    showing the target too.

    An **embed** (`![[…]]`) is left completely alone: it is a picture rather
    than words, `imageBlock` replaces it with a widget, and hiding half of it
    here is how it came to read `![paste-1.png]`.
  */
  const wiki = doc === undefined ? [] : wikiLinkSpans(doc.sliceString(0, docLength), selection);
  const insideWiki = (from: number, to: number): boolean =>
    wiki.some((span) => from >= span.from && to <= span.to);

  tree.iterate({
    from: 0,
    to: docLength,
    enter(node) {
      if (front !== null && node.from < front.to) return;
      // See `wiki` above: this pass owns every character of a wiki link.
      if (insideWiki(node.from, node.to)) return;
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

  /*
    Merged rather than concatenated and sorted. `RangeSet.of` needs document
    order, and this function's header says a blanket sort would hide a bug
    where the tree is walked out of order — so the two lists, each already
    ordered by construction, are interleaved instead. A sort here would still
    produce the right answer today and would stop being a check tomorrow.
  */
  return mergeOrdered(hidden, wiki.flatMap((span) => span.hides));
}

/** Two ranges lists, already in document order, as one. */
function mergeOrdered(left: TextRange[], right: TextRange[]): TextRange[] {
  if (right.length === 0) return left;
  const out: TextRange[] = [];
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    out.push((left[a]!.from <= right[b]!.from ? left[a++] : right[b++])!);
  }
  while (a < left.length) out.push(left[a++]!);
  while (b < right.length) out.push(right[b++]!);
  return out;
}

/**
 * Every `[[…]]` in the text, with the ranges that should be drawn as nothing.
 *
 * The same shape `noteLinksIn` parses, deliberately: two readers of the same
 * syntax that disagree is how `[[a|b]]` ends up underlined as a link over text
 * that has already been folded away by somebody else.
 *
 * `hides` is empty — the span is still *owned*, so the grammar keeps out of it
 * — in the two cases where the source is what should be on screen: the caret
 * is inside it, or it is an embed and `imageBlock` is about to replace the
 * whole thing with a picture.
 */
function wikiLinkSpans(
  text: string,
  selection: readonly TextRange[],
): { from: number; to: number; hides: TextRange[] }[] {
  const spans: { from: number; to: number; hides: TextRange[] }[] = [];
  for (const match of text.matchAll(/!?\[\[([^[\]]+)\]\]/g)) {
    const from = match.index;
    const to = from + match[0].length;
    const embed = match[0].startsWith("!");
    if (embed || selectionTouches({ from, to }, selection)) {
      spans.push({ from, to, hides: [] });
      continue;
    }
    const inner = match[1]!;
    const innerFrom = from + 2;
    const bar = inner.indexOf("|");
    /*
      An alias is what the link is *called*, so it is the only thing left. A
      missing one leaves the target, and so does an empty one: `[[path|]]` is a
      typo in progress, and an empty span is a link nobody can see to fix.
    */
    const alias = bar === -1 ? "" : inner.slice(bar + 1);
    const openTo = alias.length > 0 ? innerFrom + bar + 1 : innerFrom;
    spans.push({
      from,
      to,
      hides: [
        { from, to: openTo },
        { from: to - 2, to },
      ],
    });
  }
  return spans;
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
    /*
      `<https://…>` and a bare `https://…` are links too, and `noteLinks.ts`
      follows them on a click; drawn plain, nobody would know to try.
    */
    case "Link":
    case "Autolink":
    case "URL":
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
