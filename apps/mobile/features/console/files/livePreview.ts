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
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
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
import { completedTasks, hangingIndents, listGlyphs } from "./livePreview/lists";
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
import { BulletWidget, TaskWidget, taskToggle } from "./livePreview/listWidgets";
import { HtmlPreviewWidget, htmlPreviews } from "./livePreview/htmlPreview";
export {
  HTML_PREVIEW_TAG,
  HtmlPreviewWidget,
  htmlPreviews,
  previewDocument,
  type HtmlPreview,
} from "./livePreview/htmlPreview";
import { formStyles } from "./livePreview/styles/forms";
import { imageStyles } from "./livePreview/styles/images";
import { tableStyles } from "./livePreview/styles/tables";
import { textStyles } from "./livePreview/styles/text";

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
 * The heading ladder: the first slice of `livePreviewStyles`, kept in this
 * file because `__tests__/typeScale.test.ts` holds these ratios to the tokens by
 * reading `livePreview.ts` as text (the comment inside says so). The rest of
 * the sheet is in `./livePreview/styles/`, in its original order.
 */
const headingStyles = `
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
.cm-lp-h4, .cm-lp-h5, .cm-lp-h6 { font-size: 1.05em; }`;

/**
 * How the rendered document looks.
 *
 * Sizes and colours come from `features/design/tokens` via CSS custom
 * properties set on the wrapper, so this file states relationships (a heading
 * is 1.6× body) and the theme states values. Deliberately not a full typographic
 * system: this is a note editor, and a document that looks like a magazine is
 * harder to edit than one that looks like a document.
 */
export const livePreviewStyles = headingStyles + textStyles + tableStyles + formStyles + imageStyles;
