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

import {
  ChangeSet,
  EditorSelection,
  type ChangeSpec,
  type SelectionRange,
} from "@codemirror/state";
import { GFM, parser as markdownParser } from "@lezer/markdown";

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
 * Used now only for the empty pair `**|**`, which the grammar does not call
 * emphasis and so has to be read off the characters; every other decision
 * asks the grammar (`spansAround`). The rule is kept for that case because it
 * was a real defect the first time round: `**words**` with `words` selected
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

/* -------------------------------------------------------------------------- */
/*                     where the markers already are                          */
/* -------------------------------------------------------------------------- */

/**
 * One formatted run as the grammar reads it: `**` … `**`, with the positions
 * of both markers.
 */
interface Span {
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
}

/**
 * The node the grammar gives each marker pair, keyed by its opening marker.
 *
 * `_` is here as well as `*` because the grammar accepts both for italic and a
 * note written elsewhere uses either; the toggle still only ever *inserts* `*`.
 */
const NODE_FOR: Readonly<Record<string, string>> = {
  "**": "StrongEmphasis",
  __: "StrongEmphasis",
  "*": "Emphasis",
  _: "Emphasis",
  "~~": "Strikethrough",
  "`": "InlineCode",
};

/** GFM, because `~~` is GFM and because it is what `markdownLanguage` parses notes with. */
const inlineParser = markdownParser.configure(GFM);

/**
 * How far either way `blockAround` will walk looking for a paragraph's edge.
 *
 * A paragraph is almost always a handful of lines. The bound is there so a
 * pathological note — thousands of lines with no blank one — costs a press a
 * bounded parse rather than the whole document.
 */
const BLOCK_LINES = 200;

/**
 * The block of consecutive non-blank lines around `[from, to]`.
 *
 * **Why the text is parsed at all, rather than read off runs of asterisks.**
 * The toggle used to decide "is this bold?" by counting the marker characters
 * immediately either side of the selection. That answers correctly for a word
 * that is the whole bold run and wrongly for everything else anybody does:
 * the caret inside one word of `**two words**` saw no `**` next to the word,
 * so ⌘B wrapped it again and wrote `****two** words**`. What a person means by
 * "this is bold" is what the grammar means by it, so the grammar is asked.
 *
 * A paragraph rather than a line because emphasis can run across a soft line
 * break, and a paragraph rather than the document because a press should not
 * cost a parse of the whole note.
 */
function blockAround(doc: string, from: number, to: number): { start: number; end: number } {
  let start = doc.lastIndexOf("\n", from - 1) + 1;
  let end = doc.indexOf("\n", to);
  if (end === -1) end = doc.length;
  for (let walked = 0; start > 0 && walked < BLOCK_LINES; walked += 1) {
    const previous = doc.lastIndexOf("\n", start - 2) + 1;
    if (doc.slice(previous, start - 1).trim() === "") break;
    start = previous;
  }
  for (let walked = 0; end < doc.length && walked < BLOCK_LINES; walked += 1) {
    let next = doc.indexOf("\n", end + 1);
    if (next === -1) next = doc.length;
    if (doc.slice(end + 1, next).trim() === "") break;
    end = next;
  }
  return { start, end };
}

/** Every run of this marker's kind in the block around `[from, to]`, innermost last. */
function spansAround(doc: string, from: number, to: number, before: string): Span[] {
  const name = NODE_FOR[before];
  if (name === undefined) return [];
  const { start, end } = blockAround(doc, from, to);
  const spans: Span[] = [];
  const tree = inlineParser.parse(doc.slice(start, end));
  tree.iterate({
    enter(node) {
      if (node.name !== name) return;
      const open = node.node.firstChild;
      const close = node.node.lastChild;
      if (open === null || close === null || open.from === close.from) return;
      spans.push({
        openFrom: start + open.from,
        openTo: start + open.to,
        closeFrom: start + close.from,
        closeTo: start + close.to,
      });
    },
  });
  return spans;
}

/** The innermost span satisfying `test`, or `null`. */
function innermost(spans: readonly Span[], test: (span: Span) => boolean): Span | null {
  let found: Span | null = null;
  for (const span of spans) if (test(span)) found = span;
  return found;
}

/* -------------------------------------------------------------------------- */
/*                                the plan                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a press means: whatever the text already says (`"toggle"`), or "make
 * this formatted" regardless (`"add"`) — the latter for a range overruled by
 * the ranges beside it; see `toggleWrap`.
 */
export type ToggleMode = "toggle" | "add";

/**
 * Plan one range's toggle: take the formatting off if it is there, put it on
 * if it is not.
 *
 * Every answer here is what a rich editor does with the same keystroke,
 * because that is what people's hands already expect of ⌘B:
 *
 *  - **A caret at the end of bold text steps out of it.** ⌘B, type a word, ⌘B,
 *    keep typing: the second press is "stop being bold", which is what it
 *    means in every word processor. It used to *unbold the word* and leave it
 *    selected, so the next keystroke replaced it — ⌘B, `bold`, ⌘B, ` after`
 *    wrote `start  after`, measured in Chromium. The step out moves the caret
 *    past the closing marker and changes nothing else; a press just past a
 *    run steps back in, so the pair of presses is still the identity.
 *  - **A caret anywhere else inside bold text unbolds the whole run**, not the
 *    word under it.
 *  - **A caret in a plain word bolds the word**, and on whitespace inserts an
 *    empty pair with the caret between, ready to type.
 *  - **A selection inside bold text unbolds just the selection**, splitting
 *    the run around it: `**bold text**` with `text` selected is
 *    `**bold** text`.
 *  - **A selection that is not all bold becomes bold**, merged with any run it
 *    overlaps, rather than nesting a second pair inside the first — which the
 *    grammar reads as literal asterisks.
 *  - **Whitespace at either end of a selection stays outside the markers.**
 *    `**word **` is not bold in CommonMark; it is four asterisks. A drag
 *    across a word usually picks up the space after it.
 *  - **A selection across lines formats each line**, after its list bullet,
 *    heading hashes or quote marker, because emphasis cannot cross a block
 *    and `**- item` is not a list item.
 */
export function planToggle(
  doc: string,
  original: SelectionRange,
  before: string,
  after: string,
  mode: ToggleMode = "toggle",
): RangePlan {
  if (original.empty) return planCaret(doc, original.head, before, after, mode);

  const segments = segmentsOf(doc, original.from, original.to);
  if (segments.length === 0) return planCaret(doc, original.from, before, after, mode);

  const spans = spansAround(doc, segments[0].from, segments[segments.length - 1].to, before);
  const inside = segments.map((segment) =>
    innermost(spans, (span) => span.openFrom <= segment.from && segment.to <= span.closeTo),
  );
  const removing = mode === "toggle" && inside.every((span) => span !== null);

  const changes: ChangeSpec[] = [];
  const ends: { from: number; to: number }[] = [];
  if (removing) {
    /*
      One run can hold several segments — `**one\ntwo**` selected across its
      soft break — and its markers can only be taken off once, so segments
      that share a run are unformatted as the one stretch they cover.
    */
    for (let index = 0; index < segments.length; ) {
      const span = inside[index]!;
      let last = index;
      while (last + 1 < segments.length && inside[last + 1] === span) last += 1;
      const planned = unformat(doc, { from: segments[index].from, to: segments[last].to }, span);
      changes.push(...planned.changes);
      ends.push(planned.keep);
      index = last + 1;
    }
  } else {
    /*
      A run across a soft break cannot be absorbed by either line's segment —
      both would reach for its markers — so its markers come off once here,
      and each line is then wrapped on its own like any other.
    */
    const first = segments[0].from;
    const last = segments[segments.length - 1].to;
    for (const span of spans) {
      const crosses = doc.slice(span.openFrom, span.closeTo).includes("\n");
      if (!crosses || span.openFrom >= last || span.closeTo <= first) continue;
      changes.push(
        { from: span.openFrom, to: span.openTo, insert: "" },
        { from: span.closeFrom, to: span.closeTo, insert: "" },
      );
    }
    for (const segment of segments) {
      const planned = format(doc, segment, spans, before, after);
      changes.push(...planned.changes);
      ends.push(planned.keep);
    }
  }

  const set = ChangeSet.of(changes, doc.length);
  const first = ends[0];
  const last = ends[ends.length - 1];
  return {
    changes,
    range: EditorSelection.range(set.mapPos(first.from, 1), set.mapPos(last.to, -1)),
    removed: removing,
  };
}

/** A caret: step out, step in, unbold the run, bold the word, or an empty pair. */
function planCaret(
  doc: string,
  pos: number,
  before: string,
  after: string,
  mode: ToggleMode,
): RangePlan {
  const width = before.length;
  const caret = (at: number, removed: boolean): RangePlan => ({
    changes: [],
    range: EditorSelection.cursor(at),
    removed,
  });

  if (mode === "toggle") {
    /*
      `**|**` — what a press on an empty spot leaves behind. The grammar does
      not call an empty pair emphasis, so this is read off the characters, with
      the CommonMark run rule that stops `*` mistaking `**` for its own.
    */
    const char = before[0];
    if (
      markerPresent(runBefore(doc, pos, char), width) &&
      markerPresent(runAfter(doc, pos, char), width) &&
      doc.slice(pos - width, pos) === before &&
      doc.slice(pos, pos + after.length) === after
    ) {
      return {
        changes: [{ from: pos - width, to: pos + after.length, insert: "" }],
        range: EditorSelection.cursor(pos - width),
        removed: true,
      };
    }

    const spans = spansAround(doc, pos, pos, before);
    const leaving = innermost(spans, (span) => span.closeFrom === pos);
    if (leaving !== null) return caret(leaving.closeTo, true);
    const reentering = innermost(spans, (span) => span.closeTo === pos);
    if (reentering !== null) return caret(reentering.closeFrom, false);
    const entering = innermost(spans, (span) => span.openFrom === pos);
    if (entering !== null) return caret(entering.openTo, false);

    const within = innermost(spans, (span) => span.openFrom < pos && pos < span.closeTo);
    if (within !== null) {
      const changes = [
        { from: within.openFrom, to: within.openTo, insert: "" },
        { from: within.closeFrom, to: within.closeTo, insert: "" },
      ];
      const set = ChangeSet.of(changes, doc.length);
      return {
        changes,
        range: EditorSelection.cursor(set.mapPos(Math.max(pos, within.openTo), -1)),
        removed: true,
      };
    }
  }

  /*
    The word under the caret, or the caret itself on whitespace. The caret
    stays a caret, where it was in the word — not the word selected, which is
    what this used to leave, and which the next typed character then replaced.
  */
  const word = wordAround(doc, EditorSelection.cursor(pos));
  return {
    changes: [
      { from: word.from, insert: before },
      { from: word.to, insert: after },
    ],
    range: EditorSelection.cursor(pos + width),
    removed: false,
  };
}

/** A contiguous piece of one line that markers can go around. */
interface Segment {
  from: number;
  to: number;
}

/**
 * The block prefix a line opens with: indentation, `#`s, `>`, a bullet or a
 * number, a task box. Markers go after it, or the line stops being what it is.
 */
const BLOCK_PREFIX = /^[ \t]*(?:(?:#{1,6}|>|[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)*/;

/**
 * The selection cut into one segment per line, each clear of its line's block
 * prefix and trimmed of whitespace at both ends. Blank segments are dropped.
 */
function segmentsOf(doc: string, from: number, to: number): Segment[] {
  const segments: Segment[] = [];
  let lineStart = doc.lastIndexOf("\n", from - 1) + 1;
  while (lineStart <= to) {
    let lineEnd = doc.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = doc.length;
    const prefix = BLOCK_PREFIX.exec(doc.slice(lineStart, lineEnd))?.[0].length ?? 0;
    let start = Math.max(from, lineStart + prefix);
    let end = Math.min(to, lineEnd);
    while (start < end && /\s/.test(doc[start])) start += 1;
    while (end > start && /\s/.test(doc[end - 1])) end -= 1;
    if (start < end) segments.push({ from: start, to: end });
    if (lineEnd >= doc.length) break;
    lineStart = lineEnd + 1;
  }
  return segments;
}

/**
 * Take the formatting off `segment`, which lies inside `span`.
 *
 * Whatever of the run is left on either side keeps its formatting, closed or
 * reopened at the nearest non-space character so the piece that is left is
 * still a run the grammar accepts.
 */
function unformat(
  doc: string,
  segment: Segment,
  span: Span,
): { changes: ChangeSpec[]; keep: Segment } {
  const from = Math.max(segment.from, span.openTo);
  const to = Math.min(segment.to, span.closeFrom);
  const left = doc.slice(span.openTo, from);
  const right = doc.slice(to, span.closeFrom);
  const open = doc.slice(span.openFrom, span.openTo);
  const close = doc.slice(span.closeFrom, span.closeTo);
  const changes: ChangeSpec[] = [];

  if (left.trim() === "") changes.push({ from: span.openFrom, to: span.openTo, insert: "" });
  else changes.push({ from: span.openTo + left.trimEnd().length, insert: close });

  if (right.trim() === "") changes.push({ from: span.closeFrom, to: span.closeTo, insert: "" });
  else changes.push({ from: to + (right.length - right.trimStart().length), insert: open });

  return { changes, keep: { from, to } };
}

/**
 * Put the formatting on `segment`, absorbing every run of the same kind it
 * overlaps into one.
 *
 * A marker already sitting at the merged run's edge is kept rather than taken
 * off and put back, so the change is the smallest one that says the same thing.
 */
function format(
  doc: string,
  segment: Segment,
  spans: readonly Span[],
  before: string,
  after: string,
): { changes: ChangeSpec[]; keep: Segment } {
  /*
    Only runs on this segment's own line are absorbed here; one across a soft
    break has already been taken apart by `planToggle`, once, because two
    segments reaching for the same markers would be two changes to the same
    characters, which is not a transaction at all.
  */
  const lineFrom = doc.lastIndexOf("\n", segment.from - 1) + 1;
  const lineEnd = doc.indexOf("\n", segment.to);
  const lineTo = lineEnd === -1 ? doc.length : lineEnd;
  const overlapping = spans.filter(
    (span) =>
      span.openFrom < segment.to &&
      span.closeTo > segment.from &&
      span.openFrom >= lineFrom &&
      span.closeTo <= lineTo,
  );
  const from = Math.min(segment.from, ...overlapping.map((span) => span.openFrom));
  const to = Math.max(segment.to, ...overlapping.map((span) => span.closeTo));
  const changes: ChangeSpec[] = [];
  let keptOpen: Span | null = null;
  let keptClose: Span | null = null;

  for (const span of overlapping) {
    if (span.openFrom === from && keptOpen === null) keptOpen = span;
    else changes.push({ from: span.openFrom, to: span.openTo, insert: "" });
    if (span.closeTo === to && keptClose === null) keptClose = span;
    else changes.push({ from: span.closeFrom, to: span.closeTo, insert: "" });
  }
  if (keptOpen === null) changes.push({ from, insert: before });
  if (keptClose === null) changes.push({ from: to, insert: after });

  return {
    changes,
    keep: {
      from: keptOpen === null ? from : keptOpen.openTo,
      to: keptClose === null ? to : keptClose.closeFrom,
    },
  };
}
