/**
 * The formatting verbs, as CodeMirror commands over markdown source.
 *
 * `editorSetup.ts` already had three of these inline — `wrapSelection`,
 * `toggleLinePrefix`, `insertLink` — and they were right where they were while
 * the only thing that ran them was the accessory bar's six keys. They are here
 * now because two more surfaces want the same verbs and one of them wants a
 * dozen of them: a ⌘B/⌘I keymap, and a right-click menu over the note body on
 * the web console. A verb reached from three places and written in three places
 * is three behaviours with one name.
 *
 * Nothing here touches React, react-native or the DOM. Same rule as
 * `editorSetup.ts`, and for the same reason: this module is compiled twice —
 * by Metro for the browser and by esbuild into the committed iOS guest bundle
 * (`webview/bundle.generated.ts`) — so an import either bundler cannot follow
 * would break one of the two hosts, and the tests for it run in plain node.
 *
 * ## Why toggling, rather than inserting
 *
 * `wrapSelection` inserted a pair of markers and nothing took them off again.
 * That was survivable on a bar where Bold is one key among six and a mis-press
 * is undone with the undo key sitting beside it. It is not survivable on ⌘B,
 * because ⌘B is *the* chord people press twice — once to start a bold word and
 * once to end it — and an editor that answers the second press with `****bold**`
 * is an editor that punishes the most ordinary thing anybody does with it.
 *
 * So every marker verb here is a toggle, and the toggle is the *same* function
 * the bar's Bold key now runs. The bar did not ask for that, and it gets it
 * anyway, deliberately: two meanings of Bold on two surfaces is the drift
 * `editorSetup.ts`'s own header exists to prevent.
 */

import { EditorSelection, type ChangeSpec, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { focusGridCell } from "./livePreview";

/**
 * The marker pairs, named once.
 *
 * Three surfaces reach for these — the ⌘B/⌘I/⌘⇧X keymap in `editorSetup.ts`,
 * the accessory bar's Bold and Italic keys, and the web console's right-click
 * menu — and a fourth spelling of "italic" would be a fourth behaviour. `*`
 * rather than `_` for italic because that is what the rest of these notes
 * already use and what the bar has always inserted; the grammar accepts both.
 */
export const MARKERS = {
  bold: { before: "**", after: "**" },
  italic: { before: "*", after: "*" },
  strikethrough: { before: "~~", after: "~~" },
  code: { before: "`", after: "`" },
} as const;

export type MarkerName = keyof typeof MARKERS;

/**
 * What one range's toggle decided, before it is turned into a transaction.
 *
 * Separated from the dispatch so the decision is testable on its own and so
 * `toggleWrap` can require **agreement** across a multi-range selection before
 * it removes anything — see there.
 */
interface RangePlan {
  changes: ChangeSpec[];
  range: SelectionRange;
  /** True when this range took markers off rather than putting them on. */
  removed: boolean;
}

/** A character that can be part of a word for the purpose of "the word the caret is in". */
function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

/**
 * The word the caret sits in or beside, or the caret itself.
 *
 * ⌘B with nothing selected has two defensible answers and only one of them is
 * what people mean. Inserting a bare `****` and parking the caret between the
 * pairs is what a naive implementation does; bolding the word already under the
 * caret is what Obsidian, Word and every rich editor do, and it is what
 * somebody who has just typed a word and reached for ⌘B is asking for.
 *
 * The caret on whitespace or at the start of an empty line has no word to act
 * on, and then the bare pair *is* the right answer — that is the "I am about to
 * type something bold" case, and it is why this returns the range unchanged
 * rather than hunting for the nearest word on the line.
 */
function wordAround(doc: string, range: SelectionRange): SelectionRange {
  if (!range.empty) return range;
  let from = range.from;
  let to = range.to;
  // No line bound is needed: a newline is not a word character, so neither
  // walk can leave the caret's own line.
  while (from > 0 && isWordChar(doc[from - 1])) from -= 1;
  while (to < doc.length && isWordChar(doc[to])) to += 1;
  return from === to ? range : EditorSelection.range(from, to);
}

/**
 * How many of `char` run up to `at`, and away from it.
 *
 * Every marker this module knows is a run of one repeated character — `*`,
 * `**`, `~~`, `` ` `` — and that is what makes the rule below expressible at
 * all. A marker that was not (`<u>`…`</u>`, say) would need a different
 * question asked, and this is the assumption to revisit first if one is added.
 */
function runBefore(doc: string, at: number, char: string): number {
  let count = 0;
  while (at - count > 0 && doc[at - count - 1] === char) count += 1;
  return count;
}

function runAfter(doc: string, at: number, char: string): number {
  let count = 0;
  while (at + count < doc.length && doc[at + count] === char) count += 1;
  return count;
}

/**
 * Is a marker of `width` present, given a run of `run` marker characters?
 *
 * **This is the rule that stops ⌘I quietly turning bold text into italic**, and
 * it was a real defect the first time round: `**words**` with `words` selected
 * has a `*` immediately either side of the selection, so a naive "is the marker
 * there?" said yes, took one off each end, and left `*words*` — the same words
 * saying something else, from a keystroke that was supposed to add emphasis.
 *
 * A run of asterisks is read the way CommonMark reads it. A single-character
 * marker is present only in an **odd** run: `*x*` is italic, `**x**` is bold and
 * contains no italic, `***x***` is both. A two-character marker is present in
 * any run of two or more, so ⌘B on `***x***` leaves `*x*` rather than reaching
 * for a fifth asterisk.
 *
 * The consequence worth stating is that the two chords compose the way people
 * expect: bold then italic gives `***x***`, and either one pressed again takes
 * its own pair off and leaves the other.
 */
function markerPresent(run: number, width: number): boolean {
  return width === 1 ? run % 2 === 1 : run >= width;
}

/**
 * Plan one range's toggle: take the markers off if they are there, put them on
 * if they are not.
 *
 * The two ways markers can already be there are both real and neither is the
 * unusual one:
 *
 *  - **Outside the selection** — somebody double-clicked the word inside
 *    `**bold**` and pressed ⌘B. The selection is `bold`; the markers are the
 *    four characters either side of it.
 *  - **Inside the selection** — somebody dragged across `**bold**` including
 *    its markers, which is what a triple-click or a drag from the margin gives
 *    you, and what ⌘B leaves selected after it has just wrapped something.
 *
 * Checked in that order because the first is what the caret-only case reduces
 * to (`**|**` is a caret with the markers outside it), and because a selection
 * that satisfies both — `**` selected inside `****` — should lose the pair it
 * is sitting between rather than eat itself.
 */
function planToggle(
  doc: string,
  original: SelectionRange,
  before: string,
  after: string,
): RangePlan {
  const range = wordAround(doc, original);
  const { from, to } = range;
  const char = before[0];
  const width = before.length;

  if (
    markerPresent(runBefore(doc, from, char), width) &&
    markerPresent(runAfter(doc, to, char), width)
  ) {
    return {
      changes: [
        { from: from - width, to: from, insert: "" },
        { from: to, to: to + after.length, insert: "" },
      ],
      range: EditorSelection.range(from - width, to - width),
      removed: true,
    };
  }

  if (
    to - from >= before.length + after.length &&
    markerPresent(runAfter(doc, from, char), width) &&
    markerPresent(runBefore(doc, to, char), width)
  ) {
    return {
      changes: [
        { from, to: from + width, insert: "" },
        { from: to - after.length, to, insert: "" },
      ],
      range: EditorSelection.range(from, to - before.length - after.length),
      removed: true,
    };
  }

  return {
    changes: [
      { from, insert: before },
      { from: to, insert: after },
    ],
    /*
      The original selection shifted by the opening marker, so wrapping a word
      leaves the word selected and wrapping nothing leaves the caret between
      the two markers — which is the behaviour that makes `**` on an empty line
      worth pressing at all. Inherited verbatim from `wrapSelection`, which is
      what this replaced.
    */
    range: EditorSelection.range(from + before.length, to + before.length),
    removed: false,
  };
}

/**
 * Bold, italic, strikethrough, an inline code span — the pair of markers around
 * the selection, on and off again.
 *
 * `changeByRange` rather than one dispatch per marker, because a document with
 * more than one cursor in it is an ordinary CodeMirror document and two
 * separate dispatches would apply the second against positions the first has
 * already moved.
 *
 * ## Why the ranges have to agree
 *
 * With three cursors, two inside bold text and one outside it, per-range
 * decisions produce a transaction that bolds one and unbolds two — a single
 * press leaving the document in a state nobody asked for and no second press
 * undoes. So the *document* decides once: markers come off only if **every**
 * range already has them, and otherwise every range gets them. That is the rule
 * a person can hold in their head ("it does the same thing everywhere"), and it
 * is the one that makes the second press the inverse of the first.
 */
export function toggleWrap(view: EditorView, before: string, after: string): void {
  const doc = view.state.doc.toString();
  const proposed = view.state.selection.ranges.map((range) =>
    planToggle(doc, range, before, after),
  );
  const removing = proposed.every((plan) => plan.removed);
  const plans = removing
    ? proposed
    : view.state.selection.ranges.map((range, index) =>
        proposed[index].removed ? planWrapOnly(doc, range, before, after) : proposed[index],
      );

  /*
    A counter rather than a lookup by identity: `changeByRange` visits
    `state.selection.ranges` in order, which is the order `plans` was built in,
    and an `indexOf` over ranges would answer the wrong index for a document
    holding two identical empty cursors.
  */
  let next = 0;
  view.dispatch(
    view.state.update(
      view.state.changeByRange(() => {
        const plan = plans[next];
        next += 1;
        return { changes: plan.changes, range: plan.range };
      }),
      { scrollIntoView: true, userEvent: "input" },
    ),
  );
}

/** The wrap half of `planToggle`, for a range overruled by the ones beside it. */
function planWrapOnly(
  doc: string,
  original: SelectionRange,
  before: string,
  after: string,
): RangePlan {
  const range = wordAround(doc, original);
  return {
    changes: [
      { from: range.from, insert: before },
      { from: range.to, insert: after },
    ],
    range: EditorSelection.range(range.from + before.length, range.to + before.length),
    removed: false,
  };
}

/**
 * A blank GFM table, `rows` body rows by `cols` columns, with the caret in the
 * first header cell.
 *
 * ## Why it is padded with spaces
 *
 * `|  |  |` is a valid table and it is unreadable in the source. That used to
 * be what the author was looking at while they filled it in; it is not any
 * more — the grid is drawn while the note is being written and the cells are
 * typed into directly (`livePreview.ts`). The padding stays anyway, for the
 * reader this product cannot see: the file is open in Obsidian, in a text
 * editor and in `git diff`, and three spaces is the width of the `---` under
 * it, so an empty table's columns line up in the monospace face and stay lined
 * up for a cell of up to three characters.
 *
 * ## Why it may insert two newlines before itself
 *
 * A GFM table cannot interrupt a paragraph — a delimiter row directly under a
 * line of prose is parsed as more prose, and what the person gets for their
 * trouble is a row of pipes in the middle of a sentence. So a table asked for
 * on a line that already has text is put *after* that paragraph, with the blank
 * line the grammar requires. On an empty line it lands where the caret is.
 */
export function insertTable(view: EditorView, rows: number, cols: number): void {
  const columns = Math.max(1, Math.trunc(cols));
  const bodyRows = Math.max(0, Math.trunc(rows));

  const blank = `| ${Array.from({ length: columns }, () => "   ").join(" | ")} |`;
  const rule = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
  const table = [blank, rule, ...Array.from({ length: bodyRows }, () => blank)].join("\n");

  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const lead = line.text.trim() === "" ? "" : "\n\n";
  const at = lead === "" ? head : line.to;

  view.dispatch(
    view.state.update(
      {
        changes: { from: at, to: at, insert: `${lead}${table}\n` },
        /*
          Two characters past the opening pipe is the first header cell's own
          text, which is where somebody who has just chosen "4 × 3" is about to
          type. Not the start of the table: a caret sitting on a `|` looks like
          it is in the cell and types outside it.

          This is now the fallback rather than the answer: the table is drawn
          as a grid the moment it exists, so the caret lands inside a block
          nobody can see. `focusGridCell` below puts it in the drawn cell
          instead, and this selection is what is left when there is no grid —
          a table the grid refused, or a surface without the extension.
        */
        selection: EditorSelection.cursor(at + lead.length + 2),
      },
      { scrollIntoView: true, userEvent: "input" },
    ),
  );

  /*
    After the dispatch, because the grid is drawn by the transaction this
    command just made: CodeMirror updates its DOM synchronously, so the cell
    exists by the time this line runs.
  */
  focusGridCell(view, at + lead.length, -1, 0);
}
