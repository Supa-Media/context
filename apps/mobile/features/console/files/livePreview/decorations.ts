/**
 * The decoration pass: `decorationsFor`, the one pure function from an
 * `EditorState` to the whole Live Preview `DecorationSet`. Every other module
 * under `livePreview/` is something this reads; nothing reads this but the
 * extension and the tests.
 *
 * The order in which it collects line, style, done-task and hide/replace
 * decorations is the order in the original file, unchanged.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import { RangeSet, type EditorState, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { FormWidget, formFences, formHost } from "../formBlock";
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
} from "../imageBlock";
import { CalloutTitleWidget, callouts } from "./callouts";
import { revealSelection } from "./engagement";
import { frontmatterBlock, frontmatterHidden, frontmatterLine, frontmatterRange } from "./frontmatter";
import { HtmlPreviewWidget, htmlPreviews } from "./htmlPreview";
import { completedTasks, hangingIndents, listGlyphs } from "./lists";
import { BulletWidget, TaskWidget } from "./listWidgets";
import { hiddenMarkRanges, selectionTouches, styleClassFor } from "./reveal";
import { tableGrids, tableLines } from "./tableModel";
import { TableGridWidget } from "./tableWidget";

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
