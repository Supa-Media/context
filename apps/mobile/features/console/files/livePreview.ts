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

import {
  EditorState,
  Range,
  RangeSet,
  StateField,
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { FormWidget, formFences, formHost } from "./formBlock";
/*
  Images are a separate module for the reason `formBlock.ts` is one: the grammar
  and the gestures are testable without a tree, and this file is already the
  longest in the console. What lands here is only the two things that have to be
  decided in one place — which lines the reveal rule hides, and that a block
  widget's range is nobody else's to decorate.
*/
import {
  imageRowDecoration,
  imageRows,
  imageHost,
  imageSelection,
  type ImageRow,
} from "./imageBlock";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

export { codeHighlighting, fenceHighlightStyle, markdownLanguage } from "./livePreview/language";
import {
  frontmatterBlock,
  frontmatterHidden,
  frontmatterLine,
  frontmatterRange,
} from "./livePreview/frontmatter";
export { frontmatterBlock, frontmatterRange } from "./livePreview/frontmatter";
import { hiddenMarkRanges, selectionTouches, styleClassFor } from "./livePreview/reveal";
export {
  hiddenMarkRanges,
  revealUnitFor,
  selectionTouches,
  styleClassFor,
  type TextRange,
} from "./livePreview/reveal";
import { completedTasks, hangingIndents, isTicked, listGlyphs } from "./livePreview/lists";
export {
  completedTasks,
  hangingIndents,
  listGlyphs,
  type HangingIndent,
  type ListGlyph,
} from "./livePreview/lists";
import { CalloutTitleWidget, callouts } from "./livePreview/callouts";
export {
  CalloutTitleWidget,
  calloutLabel,
  callouts,
  type Callout,
} from "./livePreview/callouts";
import { writingTable } from "./livePreview/writingTable";
export { showTableSource, stopWritingTable, writingTable } from "./livePreview/writingTable";
import { editorEngaged, revealSelection, setEditorEngaged } from "./livePreview/engagement";
export { editorEngaged, engageEditor } from "./livePreview/engagement";
import { tableGrids, tableLines } from "./livePreview/tableModel";
export {
  alignmentsIn,
  tableGrids,
  tableLines,
  type CellAlign,
  type CellRun,
  type CellSpan,
  type TableGrid,
} from "./livePreview/tableModel";
export { focusGridCell } from "./livePreview/gridDom";
export { toggleMarkerInCell } from "./livePreview/cellEditing";
import { TableGridWidget } from "./livePreview/tableWidget";
export { TableGridWidget } from "./livePreview/tableWidget";

const hideMark = Decoration.replace({});

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
 * The tables a caret steps over, as a range set.
 *
 * The frontmatter is excluded the same way `decorationsFor` excludes it, and
 * for the same reason: nothing in a note's metadata is a table, and a caret
 * that could not enter the block would be a caret that could not fix it.
 *
 * Memoised on the state, because this is a facet CodeMirror reads on **cursor
 * motion** rather than on a transaction: every arrow key asks it, more than
 * once, and the honest implementation reads the whole document as a string and
 * walks the tree. One answer per state is the same work `decorationsFor`
 * already does once, rather than a document scan per keypress in a long note.
 */
const gridRangeCache = new WeakMap<EditorState, RangeSet<Decoration>>();

function gridRanges(state: EditorState): RangeSet<Decoration> {
  const cached = gridRangeCache.get(state);
  if (cached !== undefined) return cached;
  const front = frontmatterRange(state.doc.toString());
  const ranges = RangeSet.of(
    tableGrids(state, front === null ? 0 : front.to).map((grid) => ({
      from: grid.from,
      to: grid.to,
      value: Decoration.mark({}),
    })),
    true,
  );
  gridRangeCache.set(state, ranges);
  return ranges;
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
  const doc = state.doc.toString();
  const front = frontmatterRange(doc);
  /*
    The block plus the blank lines under it — see `frontmatterBlock`. Used for
    both halves of the fold, so the range that is hidden is the same range that
    reveals when the caret reaches it: a caret on a blank line that is not on
    screen would otherwise be a caret nothing could put anywhere.
  */
  const frontBlock = frontmatterBlock(doc);
  /*
    Passed to the three list/table passes below rather than recomputed by each
    of them, which is not only tidiness: `frontmatterRange` reads the whole
    document as a string, and this runs on every keystroke and every cursor
    move. One read, four consumers.
  */
  const frontEnd = front === null ? 0 : front.to;

  /**
   * Whether the block is on screen at all.
   *
   * **It used to always be**, drawn small and dim, and the argument for that
   * was "metadata a person may need to edit" — which is right about *editing*
   * and was answering a question nobody asked about *reading*. Measured in
   * Chromium at 1440×900 against the console's own demo note: `---`,
   * `updated: 2026-08-26`, `status: active`, `---`, four lines of filing above
   * the note's own title, on every note anybody had ever filed anything on.
   * Dim is not the same as out of the way.
   *
   * So it follows the rule every other mark in this file follows: hidden while
   * you are reading, there the moment the selection reaches it. Arrowing up
   * from the first line, clicking where it is, or a ⌘A all put the caret in
   * range and the block comes back in full, editable, with its own small-and-
   * dim styling — which is what keeps the editor the one thing in the product
   * that can change a note's metadata (`NoteEditor`'s `Properties` is a
   * reader, and `frontmatter.ts` argues why there is no YAML writer here).
   *
   * `selectionTouches` over the whole range rather than per line, because the
   * block is one object: revealing the two keys and not the fences would be
   * the half-hidden state this file's own header calls the worst of both.
   */
  const frontShown = frontBlock !== null && selectionTouches(frontBlock, selection);

  const lines: Range<Decoration>[] = [];
  if (front !== null && frontShown) {
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
  /*
    The callout box. Line decorations, so they join this block rather than the
    mark pass — and computed here because the marker's own replacement below
    needs the same list and must not read the tree twice.
  */
  const boxes = callouts(state, frontEnd);
  for (const box of boxes) {
    box.lines.forEach((from, index) => {
      lines.push(
        Decoration.line({
          class: index === 0 ? "cm-lp-callout cm-lp-callout-head" : "cm-lp-callout",
        }).range(from),
      );
    });
  }

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
  /*
    A line that is nothing but image embeds is drawn as the images — see
    `imageRows`. Third in the list of block replacements and under the same rule
    as the other two: the passes below keep out of the range it swallows, and it
    withdraws the moment the selection reaches the line, because a width you
    cannot see is a width you cannot edit by hand.
  */
  /*
    Images do not follow the reveal rule, which is the one exception in this
    file and is argued in `imageRows`: the markup of an image is a filename
    nobody types, and clicking a picture to have it turn back into
    `![[paste-….png]]` was reported as "really weird" the day it shipped. The
    toolbar on the selected image is what replaced it.
  */
  const rows: ImageRow[] = imageRows(state, frontEnd);
  const insidePreview = (pos: number): boolean =>
    previews.some((preview) => pos >= preview.from && pos < preview.to) ||
    forms.some((form) => pos >= form.from && pos < form.to) ||
    rows.some((row) => pos >= row.from && pos < row.to) ||
    insideGrid(pos);

  /*
    THE MARKERS THIS PASS IS ACTUALLY REPLACING, and why the rest of the file
    has to keep out of them.

    `[!bible]` is a callout marker to Obsidian and a **shortcut link** to lezer,
    which is precisely how the reported bug looked the way it did: the brackets
    were hidden as `LinkMark`s and `!bible` was painted `cm-lp-link`, leaving one
    blue underlined word in front of the reference. Replacing the marker without
    taking those out does not fix it, it doubles it — two decorations describing
    the same characters, which this file warns about for tables and previews and
    is the same hazard one span wide. Measured: the note came out reading
    `> hn 3:16 - NIV`, three characters eaten by the overlap.

    Empty for a marker the caret is inside, because that one is not being
    replaced — it is revealed, and a revealed `[!bible]` should be marked up
    exactly as the text it is.

    Only the *hides* consult this, not the styles. A first version filtered both
    and the style half was unobservable: a `Decoration.mark` over a range that a
    `Decoration.replace` covers has no text left to paint, so `!bible` keeping
    its `cm-lp-link` class changes nothing anybody can see. Sabotaging it
    reddened no test, which is this repo's own definition of a guard that is not
    one, so it came back out.
  */
  const hiddenMarkers = boxes
    .map((box) => box.marker)
    .filter((marker) => !selectionTouches(marker, selection) && !insidePreview(marker.from));
  const insideMarker = (pos: number): boolean =>
    hiddenMarkers.some((marker) => pos >= marker.from && pos < marker.to);

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
    .filter((range) => !insidePreview(range.from) && !insideMarker(range.from))
    .map((range) => hideMark.range(range.from, range.to));

  /*
    The frontmatter block, put away while the caret is elsewhere — see
    `frontShown` above for why, and `frontmatterHidden` for why it is a block
    decoration. First in the set because it starts at position 0 and
    `RangeSet.of` wants document order; everything `hiddenMarkRanges` returned
    is after `front.to`, which its own comment is about.
  */
  if (frontBlock !== null && !frontShown) {
    hides.unshift(frontmatterHidden.range(frontBlock.from, frontBlock.to));
  }

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
    The images. `editable` comes off the state's own `readOnly` facet rather
    than from a second flag: a viewer who may not write the note gets the row
    drawn and no handles at all, which is `editability`'s rule about a control
    that would only ever fail.
  */
  for (const row of rows) {
    hides.push(
      imageRowDecoration(
        row,
        state.facet(imageHost),
        !state.readOnly,
        state.field(imageSelection, false) ?? null,
      ).range(row.from, row.to),
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
        widget: new TableGridWidget(grid, !state.readOnly),
        block: true,
      }).range(grid.from, grid.to),
    );
  }

  /*
    The `[!type]` marker, taken off the screen — the whole of what looked wrong
    in the report. With a title the author wrote it is hidden outright; without
    one it is replaced by the type, because hiding it whole would leave an empty
    `> ` reading as a blank first line rather than as a heading.

    Under the same reveal rule as every other mark here: the caret inside it
    brings it back, or the type could not be edited. `selectionTouches` is the
    same predicate `hiddenMarkRanges` uses, so the two cannot disagree about
    what "inside" means.
  */
  for (const box of boxes) {
    if (insideMarker(box.marker.from)) {
      hides.push(
        (box.title === null
          ? Decoration.replace({ widget: new CalloutTitleWidget(box.type) })
          : hideMark
        ).range(box.marker.from, box.marker.to),
      );
    }
    /*
      And the `>` on each line — per line, not per callout, so the caret on one
      line does not bring back the quote marks on the four it is not editing.
      Hidden here rather than by adding `QuoteMark` to `HIDDEN_MARKS`, because
      that set is global and a plain blockquote must keep its `>`: without it a
      quote reflows into the paragraph above and stops looking quoted at all.
      A callout has the box to say so instead.
    */
    for (const mark of box.marks) {
      if (selectionTouches(mark, selection)) continue;
      if (insidePreview(mark.from)) continue;
      hides.push(hideMark.range(mark.from, mark.to));
    }
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
        Engagement, which is the fourth input and arrives by its own route: a
        transaction carrying only `setEditorEngaged` changes no document, no
        selection and no `readOnly`, so without this the whole document would
        stay as it was drawn when nobody was in it — clicking into a note would
        put a caret in markup that never came back.
      */
      const focusChanged =
        transaction.startState.field(editorEngaged, false) !==
        transaction.state.field(editorEngaged, false);
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
      /*
        And which image is selected, which arrives by a fifth route and is the
        reason clicking a picture did nothing at all for a day: `selectImage`
        carries no document change, no selection, no `readOnly` and no new
        tree, so this gate held the old decorations and the toolbar was never
        drawn. The effect was reaching the field; the field was reaching
        nothing.
      */
      const pickChanged =
        transaction.startState.field(imageSelection, false) !==
        transaction.state.field(imageSelection, false);
      if (
        !transaction.docChanged &&
        !transaction.selection &&
        !readOnlyChanged &&
        !treeChanged &&
        !focusChanged &&
        !pickChanged
      ) {
        return value;
      }
      return decorationsFor(transaction.state);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  // The one place this extension is more than decorations: a drawn checkbox has
  // to answer a press. See `taskToggle`.
  return [
    editorEngaged,
    // The table being typed, which is the only one not drawn as a grid.
    writingTable,
    /*
      A drawn table is one object rather than a run of characters — the same
      sentence `imageBlock.ts` makes about a row of images, and it matters more
      here because the grid is drawn while the note is editable: without this,
      arrowing down into a table walks an invisible caret through three lines of
      pipes that are not on screen. With it the caret steps over the whole
      table, and a selection takes it whole, so Backspace deletes the table
      rather than a character of markup nobody can see.
    */
    EditorView.atomicRanges.of((view) => gridRanges(view.state)),
    /*
      Focus opens the gate and never closes it — see `editorEngaged`. Tabbing
      into the editor is somebody arriving to write, and a blur is a popover,
      not a departure.
    */
    EditorView.focusChangeEffect.of((_state, focusing) =>
      focusing ? setEditorEngaged.of(true) : null,
    ),
    decorations,
    taskToggle,
  ];
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
  THE TYPE SCALE, RESTATED AS MULTIPLES OF THE BODY.

  30 / 23 / 19 against a 16px body, which is pointerType's title, h2 and h3
  exactly -- the scale this product already declares, arrived at here by
  division rather than by a second opinion.

  It was 1.625 / 1.3 / 1.15, measured off Obsidian mobile, and that was a third
  ladder: neither the tokens' nor the 1.7 / 1.4 / 1.2 it replaced. Two scales in
  one application is one of them being wrong wherever they meet, and where they
  met was the note -- a 30pt title in the tokens, a 26pt one on the page. The
  design canvas sides with the tokens.

  Literals rather than a custom property because these are ratios to the
  editor's own font size, which is what em means here. typeScale.test.ts holds
  them to tokens.ts by reading this file as text.

  (No backticks anywhere in this comment: it is inside a template literal and
  one would end the string. That is not hypothetical -- writing this comment
  with them is what broke the build a minute before it was rewritten.)
*/
.cm-lp-h1 { font-size: 1.875em; }
.cm-lp-h2 { font-size: 1.4375em; }
.cm-lp-h3 { font-size: 1.1875em; }
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
/*
  A dictated phrase the engine has not settled on yet.

  Grey and italic because that is what "heard, not written" has to look like:
  the reader has to be able to tell at a glance which words are in their file
  and which are the machine still thinking. It is a widget, so it is not in
  the document and cannot be selected, copied or saved — see dictate.ts.
*/
.cm-dictation-interim {
  color: var(--lp-muted);
  font-style: italic;
  white-space: pre-wrap;
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
/*
  A CALLOUT — an Obsidian blockquote that opens with [!type].

  A box rather than the quote's italic muted run, because that is the whole
  point of the syntax: the author is setting this apart from the prose around
  it. The callout's own lines override the quote styling they inherit, since
  every line of one is also a Blockquote and would otherwise be drawn as an
  aside inside its own box.

  NO PER-TYPE COLOUR, deliberately, and it is the restraint this file already
  states about its palette: Obsidian has thirteen callout types and thirteen
  colours, and each one here would be another --lp-* token crossing the WebView
  bridge for a distinction the box and the title already carry. The icon in the
  report that prompted this is not Obsidian's either — it is the plugin's own
  stylesheet, which Context does not load into the trusted realm.

  The left bar is the one piece of the quote's vocabulary kept, so a callout
  still reads as a quoted block rather than as a code fence.
*/
.cm-lp-callout {
  background: var(--lp-code-bg);
  border-left: 3px solid var(--lp-line-strong);
  color: var(--lp-content);
  font-style: normal;
  padding-left: 10px;
}
.cm-lp-callout .cm-lp-quote { color: inherit; font-style: inherit; }
/* Rounded at the ends, so a run of lines reads as one box. */
.cm-lp-callout-head { border-top-right-radius: 6px; padding-top: 2px; }
/* The title line carries the weight; the type stands in when there is none. */
.cm-lp-callout-head .cm-lp-quote { color: var(--lp-heading); font-weight: 600; }
.cm-lp-callout-type { color: var(--lp-heading); font-weight: 600; font-style: normal; }
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
/*
  Scoped to the table rather than left as bare classes, because the header's
  own rule above sets text-align and was winning on equal specificity: a
  column aligned right had right-aligned values under a left-aligned heading,
  which is not what the delimiter row says and not what any other renderer
  does with it.
*/
.cm-lp-grid-table .cm-lp-grid-left { text-align: left; }
.cm-lp-grid-table .cm-lp-grid-center { text-align: center; }
.cm-lp-grid-table .cm-lp-grid-right { text-align: right; }
/*
  An empty cell says so. Drawn as nothing it is indistinguishable from a column
  that failed to render, and a reader cannot tell which they are looking at.
*/
.cm-lp-grid-empty::after {
  content: "—";
  color: var(--lp-muted);
}
/*
  A TABLE THAT CAN BE TYPED INTO, and the rules that are only true of one.

  The frame shrinks to the table so the controls sit against the columns they
  add to rather than at the right edge of the measure. Pinned rather than laid
  out, so a table nobody is working in occupies exactly what a reader's does --
  the moment the chrome takes room in the flow, an editable note and a read one
  are two different documents.
*/
.cm-lp-grid-frame {
  position: relative;
  display: inline-block;
  min-width: 0;
  max-width: 100%;
}
/*
  ROOM FOR THE CHROME, which the first version of this deliberately did not
  reserve -- and looking at it in a browser is what settled the argument. The
  bar was pinned above the frame with a negative offset so an editable table
  occupied exactly what a reader's does. In the running app it was drawn over
  the last line of the paragraph above and then cut in half by this box, whose
  overflow-x makes overflow-y a clip too. Half a control over somebody's
  sentence is worse than a table that sits a line lower while it can be edited,
  so the space is reserved, and only while the grid is live.
*/
.cm-lp-grid-live { padding-top: 1.7em; }
/*
  AND ROOM ACROSS, for the same reason and found the same way. The frame
  shrinks to the table, an absolutely positioned box cannot be wider than the
  box it is positioned in, and a two-column table of single characters is
  narrower than four buttons -- so in the browser the bar wrapped every label
  down its own column and drew "+ r o w" on top of "+ c o l". The frame keeps
  a floor wide enough for the chrome while the grid is live; the table inside
  it is still sized by its own content.
*/
.cm-lp-grid-live .cm-lp-grid-frame { min-width: 12em; }
/*
  Something to aim at. An empty cell in an editable grid is a box a person
  clicks into, and a box with no width cannot be clicked -- while the reader's
  dash, which exists so an empty cell is not mistaken for a broken one, would
  be a character they have to delete before typing.
*/
.cm-lp-grid-live th, .cm-lp-grid-live td { min-width: 3ch; }
.cm-lp-grid-live .cm-lp-grid-empty::after { content: ""; }
.cm-lp-grid-cell:focus {
  outline: none;
  /*
    Inset so it does not move the column: an outline drawn outside the cell
    shifts every row of the table by a pixel as the caret moves along it.
  */
  box-shadow: inset 0 0 0 2px var(--lp-line-strong);
  border-radius: 2px;
}
.cm-lp-grid-controls {
  position: absolute;
  /*
    Inside the padding above rather than outside the box, and against the left
    edge rather than the right: a table wider than the measure scrolls inside
    its own box, and chrome pinned to the far edge of a wide one is chrome
    nobody can reach without scrolling to it first.
  */
  top: -1.5em;
  left: 0;
  display: flex;
  gap: 4px;
  /*
    Out of the way until wanted. Opacity rather than display, so the buttons
    keep their size and the bar does not appear to jump into existence.
  */
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}
.cm-lp-grid-frame:hover .cm-lp-grid-controls,
.cm-lp-grid-frame:focus-within .cm-lp-grid-controls {
  opacity: 1;
  pointer-events: auto;
}
.cm-lp-grid-add {
  font-family: var(--lp-body);
  white-space: nowrap;
  font-size: 0.66em;
  line-height: 1;
  padding: 3px 6px;
  color: var(--lp-muted);
  background: var(--lp-bg);
  border: 1px solid var(--lp-line-strong);
  border-radius: 4px;
  cursor: pointer;
}
.cm-lp-grid-add:hover { color: var(--lp-content); }
/*
  THE HANDLES, which are cells of the table rather than boxes over it.

  The gutter column and the strip above the header are laid out by the table
  itself, so a handle is always beside its own row or above its own column at
  whatever width that column came out. They take room only while the note can
  be edited, and a reader's table has neither.
*/
.cm-lp-grid-gutter, .cm-lp-grid-corner, .cm-lp-grid-colslot {
  padding: 0 !important;
  border: none !important;
  width: 1.2em;
  vertical-align: middle;
  text-align: center;
  background: none;
}
.cm-lp-grid-colslot { width: auto; height: 1.1em; }
.cm-lp-grid-handle {
  font-family: var(--lp-body);
  font-size: 0.8em;
  line-height: 1;
  padding: 1px 2px;
  color: var(--lp-muted);
  background: none;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  /*
    Invisible until the row or column it belongs to is wanted, and *still
    there*: a handle that is display:none cannot be tabbed to and moves the
    table every time a pointer crosses it.
  */
  opacity: 0;
  transition: opacity 120ms ease;
}
.cm-lp-grid-table tr:hover .cm-lp-grid-handle,
.cm-lp-grid-strip:hover .cm-lp-grid-handle,
.cm-lp-grid-frame:focus-within .cm-lp-grid-handle,
.cm-lp-grid-handle:focus { opacity: 1; }
.cm-lp-grid-handle:hover { color: var(--lp-content); background: var(--lp-code-bg); }
/*
  The row or column a menu is about, said on the table rather than only in the
  menu's own wording. The control that this replaced acted on a row nobody
  could see, which is the whole reason the chrome was rewritten.
*/
.cm-lp-grid-target { background: var(--lp-focus-ring); }
.cm-lp-grid-menu {
  z-index: 40;
  min-width: 11em;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--lp-bg);
  border: 1px solid var(--lp-line-strong);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.14);
  font-family: var(--lp-body);
  font-size: 0.8em;
}
.cm-lp-grid-menu-item {
  appearance: none;
  text-align: left;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--lp-content);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.cm-lp-grid-menu-item:hover, .cm-lp-grid-menu-item:focus {
  background: var(--lp-code-bg);
  outline: none;
}
/* The alignment a column already has, marked rather than repeated elsewhere. */
.cm-lp-grid-menu-current::after { content: " ✓"; color: var(--lp-muted); }
.cm-lp-grid-menu-destructive { color: var(--lp-danger); }
/*
  A FINGER IS NOT A POINTER, and this chrome is reached by both: the phone
  cannot hover, so a handle appears with the caret there and is then tapped.
  At the pointer size that tap target is about ten pixels, which is under
  every touch floor this app has. Widened where the input is coarse rather
  than everywhere, because on a desktop the same size would be chrome
  shouting over the note.
*/
@media (pointer: coarse) {
  .cm-lp-grid-handle { font-size: 1em; padding: 6px; }
  .cm-lp-grid-gutter, .cm-lp-grid-corner { width: 1.9em; }
  .cm-lp-grid-menu-item { padding: 11px 12px; }
  .cm-lp-grid-add { padding: 7px 10px; }
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
    ONE GUTTER, DECLARED ONCE.

    Every band inside measures its own edge from this, and so does the first and
    last cell of the response table — which is the only way rows that scroll
    sideways can line up with a heading that does not. It was 14px written out
    in four rules and 9 / 11 / 14 vertically in three of them, and no two bands
    agreeing on where their edge was is the whole of "the spacing looks off".

    Deliberately NOT --lp-form-gutter. In this file --lp-* names a value the
    host supplies over the bridge, and two tests hold every one of them to
    themeVars and to the guest's own :root for a reason worth keeping: an
    undeclared custom property does not fall back, it invalidates the whole
    declaration that names it. This is a layout constant declared on the only
    element whose descendants read it, so it is not that kind of property and
    does not borrow that prefix.
  */
  --form-gutter: 14px;
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
  padding: 10px var(--form-gutter);
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
  padding: var(--form-gutter);
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
  padding: 12px var(--form-gutter);
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
/*
  THE BAND IS PADDED; THE TABLE INSIDE IT IS NOT.

  The heading and the status line carry the card's gutter themselves so the
  scroll box can run wall to wall. A scroll inset by the card's padding leaves
  a dead strip on each side that the rows slide *under*, which reads as the
  table being clipped rather than as there being more of it to the right.
*/
.cm-lp-form-responses {
  border-top: 1px solid var(--lp-line);
  padding: var(--form-gutter) 0;
}
.cm-lp-form-responses-title {
  font-weight: 600;
  font-size: 0.76em;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--lp-muted);
  margin: 0 var(--form-gutter) 10px;
}
.cm-lp-form-responses-status {
  color: var(--lp-muted);
  font-size: 0.88em;
  margin: 0 var(--form-gutter);
}
.cm-lp-form-responses-scroll {
  overflow-x: auto;
  /*
    A sideways swipe over the table scrolls the table and stops there. Without
    this it chains to the page once the last column is reached, which on iOS is
    the back gesture — leaving the note to read one more column is not a trade
    anybody is offering.
  */
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
}
/*
  THE TABLE IS AS WIDE AS ITS COLUMNS NEED.

  This was width: 100%, and with seven columns inside a card the width of the
  reading measure the browser's only move is to shrink every one of them until
  the whole thing fits: a handle broken across two lines mid-word, a timestamp
  taking four, one response 190px tall, and every column equally unreadable in
  service of showing all of them at once.

  max-content asks for the width the columns actually want and lets the box
  above scroll to the rest of it — which is what Notion does, and what the owner
  asked for by pointing at it. min-width is the other half: when the columns
  do NOT need the whole card, the rules still run its full width instead of the
  table huddling against the left edge.
*/
.cm-lp-form-responses-table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
}
.cm-lp-form-responses-table th,
.cm-lp-form-responses-table td {
  border-bottom: 1px solid var(--lp-line);
  /*
    A rule between columns as well as between rows. On a table narrow enough to
    fit, row rules alone are enough; on one you scroll, the vertical rule is
    what tells you which column you have arrived at once its heading is off the
    left edge.
  */
  border-right: 1px solid var(--lp-line);
  padding: 7px 12px;
  text-align: left;
  vertical-align: top;
}
/* The gutter the band gave up, carried by the columns at each end so the rows
   line up with the heading above them. */
.cm-lp-form-responses-table th:first-child,
.cm-lp-form-responses-table td:first-child { padding-left: var(--form-gutter); }
/* ...and no rule on the last column, which would otherwise hang in the card's
   own padding with nothing to its right to separate. */
.cm-lp-form-responses-table th:last-child,
.cm-lp-form-responses-table td:last-child {
  padding-right: var(--form-gutter);
  border-right: none;
}
.cm-lp-form-responses-table th { color: var(--lp-muted); font-size: 0.88em; font-weight: 600; }
/*
  AN ANSWER WRAPS; A FACT ABOUT IT DOES NOT.

  Notion clips a cell to one line and gives you the row to open when you need
  the rest. This table has no row to open, and the answers are the entire point
  of the feature — a feature request truncated at 40 characters in the list of
  feature requests is the list not working. So the cap is on the column's
  *width*, at about a reading measure, and the text wraps inside it.
*/
.cm-lp-form-cell-value {
  /*
    24em is about one phone-width of column: at this table's size that is 324px
    against the ~350px a 390pt phone gives the card, so the answer is readable
    before any sideways scroll and the columns about it are one swipe away.

    The vw term is what makes the swipe DISCOVERABLE. At 24em flat the column
    filled a phone exactly, the next one started precisely at the card's edge,
    and a table with more to the right looked identical to one without — the
    scrollbar that says so on a desktop is a transient overlay on a phone and
    is not there at rest. Capped a little under the viewport, the next column
    always peeks, which is the same hint Notion leaves at the right edge. On
    anything wider than a phone the em term wins and the note keeps its
    measure.
  */
  max-width: min(24em, 72vw);
  /* A pasted URL or a 40-character token has nowhere to break, and one would
     otherwise push every column after it off the card on its own. */
  overflow-wrap: anywhere;
}
/*
  A handle broken across two lines mid-word is the screenshot this came from.
  A handle, an ISO timestamp and a row of buttons are each one token: wrapping
  buys nothing and is paid for in the height of every row.
*/
.cm-lp-form-cell-meta { white-space: nowrap; }
.cm-lp-form-cell-at { color: var(--lp-muted); font-variant-numeric: tabular-nums; }
/*
  THE VOTES CELL IS ONE LINE, BECAUSE IT SETS EVERY ROW'S HEIGHT.

  The voters and the two buttons were stacked, which made the tallest cell in
  the table one that holds no answer — every row paid two lines for it whatever
  it contained. Side by side they cost width instead, and width is the thing
  this table now has: it scrolls.
*/
/* On the text's baseline rather than the buttons' box, so the voters line up
   with By and At across the row instead of riding half a button lower. */
.cm-lp-form-votes { display: flex; align-items: baseline; gap: 10px; }
/*
  A REFUSAL LANDS HERE, AND A SENTENCE IN A NOWRAP CELL WOULD SET THE TABLE'S
  WIDTH.

  When a vote is declined the gateway's message replaces the voters (see
  drawResponses), and when a delete is declined it replaces the button's label.
  Inside a cell that never wraps, and a table that is now as wide as its widest
  content, one sentence would push every column to its right off the card and
  keep them there. So these two — the only places server text reaches a meta
  column — wrap inside a cap of their own. The buttons beside them still do
  not: their labels are short and fixed.
*/
.cm-lp-form-voters { color: var(--lp-muted); white-space: normal; max-width: 18em; }
.cm-lp-form-vote-controls { display: flex; gap: 6px; }
.cm-lp-form-response-controls { display: flex; gap: 6px; }
/*
  The row's own buttons, sized as chrome rather than as the content.

  At font: inherit with a 4/8 pad these were body size, and the two in a Votes
  cell made it taller than the response it belongs to — a whole row of height
  spent on controls in a table whose job is to be scanned. They are still the
  full 8mm target on the axis that matters for a thumb.
*/
.cm-lp-form-vote,
.cm-lp-form-response-action {
  font: inherit;
  font-size: 0.86em;
  line-height: 1.35;
  border: 1px solid var(--lp-line-strong);
  border-radius: 6px;
  padding: 4px 9px;
  color: var(--lp-link);
  background: transparent;
  cursor: pointer;
  /*
    And the labels wrap, inside a cap. Their own are short and fixed, but a
    declined delete replaces this one with the gateway's refusal — inside a
    column that never wraps, in a table now as wide as its widest content, one
    sentence would push every column to its right off the card and keep them
    there. Same reason, and same shape, as the cap on the voters above.
  */
  white-space: normal;
  max-width: 14em;
}
.cm-lp-form-vote:disabled,
.cm-lp-form-response-action:disabled { opacity: 0.45; cursor: default; }
.cm-lp-form-vote-remove { color: var(--lp-muted); }
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
/*
  IMAGES IN A NOTE — the row, the selected image, and its bar.

  Two things here are not cosmetic. The controls appear on the SELECTED image
  only, because a picture wearing permanent furniture reads as a form control
  rather than as a picture; and they are real buttons, so focus-visible keeps
  them reachable without a pointer. The image is painted on the code wash rather
  than on nothing, so a PNG with transparency has a ground in dark mode — an
  image keeps its own background here, the same argument previewDocument makes.
*/
.cm-lp-images {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin: 10px 0;
  position: relative;
}
.cm-lp-image {
  position: relative;
  margin: 0;
  max-width: 100%;
  min-width: 96px;
  flex: 0 1 auto;
}
/*
  THE CURSORS ARE THE INSTRUCTIONS.

  Over a writable image the pointer says "you can pick this up" — grab, and
  grabbing while it is moving. Over the side handles it says "you can pull this
  wider". Nothing about the picture says "type here", because you cannot.
*/
.cm-lp-image-live { cursor: grab; }
.cm-lp-image-moving { cursor: grabbing; opacity: 0.5; }
.cm-lp-image-img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 8px;
  background: var(--lp-code-bg);
}
/* A hairline on hover: enough to say the picture is a thing, not a decoration. */
.cm-lp-image-live:hover .cm-lp-image-img {
  outline: 1px solid var(--lp-line-strong);
  outline-offset: 3px;
}
.cm-lp-image-on .cm-lp-image-img,
.cm-lp-image-live.cm-lp-image-on:hover .cm-lp-image-img {
  outline: 2px solid var(--lp-link);
  outline-offset: 3px;
}
/*
  The handles. The two side bars are on every writable image and appear under
  the pointer, because resizing is the commonest thing anybody does to a picture
  and it should not need a click first; the corners belong to the selected one.
*/
.cm-lp-image-handle {
  position: absolute;
  padding: 0;
  border: 0;
  background: var(--lp-link);
  opacity: 0;
  touch-action: none;
}
.cm-lp-image-handle-w,
.cm-lp-image-handle-e {
  top: calc(50% - 17px);
  width: 6px;
  height: 34px;
  border-radius: 3px;
  cursor: ew-resize;
}
.cm-lp-image-handle-w { left: -5px; }
.cm-lp-image-handle-e { right: -5px; }
.cm-lp-image-handle-nw,
.cm-lp-image-handle-ne,
.cm-lp-image-handle-sw,
.cm-lp-image-handle-se {
  width: 11px;
  height: 11px;
  border-radius: 3px;
}
.cm-lp-image-handle-nw { left: -8px; top: -8px; cursor: nwse-resize; }
.cm-lp-image-handle-ne { right: -8px; top: -8px; cursor: nesw-resize; }
.cm-lp-image-handle-sw { left: -8px; bottom: -8px; cursor: nesw-resize; }
.cm-lp-image-handle-se { right: -8px; bottom: -8px; cursor: nwse-resize; }
.cm-lp-image-live:hover .cm-lp-image-handle,
.cm-lp-image-on .cm-lp-image-handle,
.cm-lp-image-handle:focus-visible {
  opacity: 1;
}
/* A handle under a moving image would be a target chasing the pointer. */
.cm-lp-image-moving .cm-lp-image-handle { opacity: 0; }
.cm-lp-image-badge {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 3px 7px;
  border-radius: 5px;
  font-family: var(--lp-mono);
  font-size: 11px;
  color: var(--lp-content);
  background: var(--lp-code-bg);
}
/*
  The bar floats above the image it belongs to, which is where the hand already
  is. It is absolutely positioned so it cannot change the row's height and make
  the note jump as an image is selected and deselected.
*/
.cm-lp-image-bar {
  position: absolute;
  left: 0;
  bottom: calc(100% + 12px);
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px 6px;
  border: 1px solid var(--lp-line-strong);
  border-radius: 9px;
  background: var(--lp-code-bg);
  white-space: nowrap;
}
.cm-lp-image-chip,
.cm-lp-image-tool {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--lp-muted);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
.cm-lp-image-chip-on,
.cm-lp-image-tool-on {
  background: var(--lp-link);
  color: var(--lp-code-bg);
  font-weight: 600;
}
.cm-lp-image-tool-text {
  color: var(--lp-content);
}
.cm-lp-image-remove {
  color: var(--lp-heading);
}
.cm-lp-image-divider {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--lp-line-strong);
}
/* Alt text, in a field that opens under the bar and closes when it is done. */
.cm-lp-image-alt {
  position: absolute;
  left: 0;
  top: calc(100% + 10px);
  z-index: 2;
  width: min(420px, 100%);
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--lp-line-strong);
  border-radius: 9px;
  background: var(--lp-code-bg);
}
.cm-lp-image-alt-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lp-muted);
}
.cm-lp-image-alt-field {
  font-family: inherit;
  font-size: 13px;
  color: var(--lp-content);
  background: transparent;
  border: 1px solid var(--lp-line-strong);
  border-radius: 7px;
  padding: 8px 10px;
}
.cm-lp-image-alt-hint {
  font-size: 12px;
  line-height: 1.45;
  color: var(--lp-muted);
}
/*
  Where the line will land. Drawn in the scroller rather than in the row,
  because the drop can be anywhere in the note and a caret parented to the image
  would be clipped by it.
*/
.cm-lp-image-caret {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--lp-link);
  pointer-events: none;
}
.cm-lp-image-missing {
  display: block;
  font-family: var(--lp-mono);
  font-size: 0.85em;
  color: var(--lp-muted);
  padding: 6px 0;
}
`;
