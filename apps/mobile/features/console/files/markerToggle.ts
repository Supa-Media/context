/**
 * A marker pair, on and off again — over a plain string.
 *
 * Lifted out of `markdownFormat.ts` unchanged, because a second caller
 * appeared that cannot reach it there: a table cell is `contenteditable` DOM
 * belonging to a widget, so ⌘B in a cell has to toggle the markers in **the
 * cell's own text** rather than in the document, and `livePreview.ts` is where
 * that happens. `markdownFormat.ts` already imports `livePreview.ts`, so the
 * rule could not simply move the other way.
 *
 * Nothing here touches the DOM, CodeMirror's view, or a document: it takes a
 * string and a range and says what to change. That is what makes it usable by
 * both, and what keeps `markdownFormat.test.ts`'s cases about the CommonMark
 * run rule exactly where they were.
 */

import { EditorSelection, type ChangeSpec, type SelectionRange } from "@codemirror/state";

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
export interface RangePlan {
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
export function wordAround(doc: string, range: SelectionRange): SelectionRange {
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
export function planToggle(
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
