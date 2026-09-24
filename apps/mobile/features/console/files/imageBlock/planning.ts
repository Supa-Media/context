/**
 * Everything a gesture decides, as a pure function of the state.
 *
 * Split out of `imageBlock.ts` — see that file's header for the whole
 * picture. `planResize`, `planAlign`, `planDrop`, `planInsert`, `planAlt`,
 * `planReplace` and `planRemove` each take a state and return a transaction
 * spec; the DOM code in `./widget.ts` does no arithmetic and makes no
 * decisions of its own — it reads a pointer and calls one of these.
 */

import type { EditorState, TransactionSpec } from "@codemirror/state";

import {
  embedFor,
  joinRows,
  lineWithAlign,
  lineWithAlt,
  lineWithTarget,
  lineWithWidth,
  lineWithout,
  type ImageAlign,
} from "../imageLine";
import { MIN_IMAGE_WIDTH, WIDTH_STEPS, type ImageRow } from "./model";

/**
 * The width a drag has reached, snapped to the quarters of the measure.
 *
 * Snapping is a default and not a cage: `precise` — the ⌥ key at the call site
 * — skips it. The tolerance is in pixels rather than a fraction so it feels the
 * same on a phone-width measure as on a wide one.
 */
export function widthFromDrag(options: {
  startWidth: number;
  deltaX: number;
  measure: number;
  precise?: boolean;
}): number {
  const { startWidth, deltaX, measure, precise = false } = options;
  const raw = Math.round(startWidth + deltaX);
  const bounded = Math.max(MIN_IMAGE_WIDTH, Math.min(measure, raw));
  if (precise) return bounded;
  for (const step of WIDTH_STEPS) {
    const snap = Math.round(measure * step);
    if (Math.abs(bounded - snap) <= 14) return snap;
  }
  return bounded;
}

/** The whole-line replacement every planner below ends in. */
function replaceLine(
  state: EditorState,
  row: ImageRow,
  text: string,
): TransactionSpec | null {
  if (text === row.text) return null;
  return {
    changes: { from: row.from, to: row.to, insert: text },
    // The selection is deliberately left where it was: a resize that moved the
    // caret onto the line would reveal the markup and take the handle out from
    // under the pointer mid-drag.
    scrollIntoView: false,
  };
}

/** Resize image `index` of `row`. */
export function planResize(
  state: EditorState,
  row: ImageRow,
  index: number,
  width: number | null,
): TransactionSpec | null {
  return replaceLine(state, row, lineWithWidth(row.text, index, width));
}

/** Set the row's alignment. */
export function planAlign(
  state: EditorState,
  row: ImageRow,
  align: ImageAlign,
): TransactionSpec | null {
  return replaceLine(state, row, lineWithAlign(row.text, align));
}

/**
 * What dropping image `index` of `row` at `dropPos` should do.
 *
 * Two outcomes, and the difference is what is already at the drop:
 *
 *  - dropped on another **image line** → the two rows join, and the image sits
 *    beside the ones already there. This is the side-by-side gesture, and it is
 *    one line edit because a row is a line.
 *  - dropped anywhere else → the whole line moves there, which is the ordinary
 *    "move a block" and is what `⌥↑`/`⌥↓` do without a pointer.
 *
 * A drop inside the row's own line is `null` — nothing moved — rather than a
 * no-op edit, so it never lands in the undo history.
 */
export function planDrop(
  state: EditorState,
  row: ImageRow,
  index: number,
  dropPos: number,
): TransactionSpec | null {
  const target = state.doc.lineAt(Math.max(0, Math.min(state.doc.length, dropPos)));
  if (target.from === row.from) return null;
  const joined = joinRows(target.text, row.text, index);
  if (joined !== null) {
    const changes: Array<{ from: number; to: number; insert: string }> = [
      { from: target.from, to: target.to, insert: joined.onto },
    ];
    if (joined.from === "") {
      // The source row is empty now, so the block goes with it rather than
      // leaving a blank line behind: a drag that tidied nothing is a drag
      // somebody has to finish by hand.
      changes.push({ ...cutBlock(state, row.from), insert: "" });
    } else {
      changes.push({ from: row.from, to: row.to, insert: joined.from });
    }
    return { changes };
  }
  /*
    A plain move. Both ranges are positions in the document as it is now, which
    is what CodeMirror maps a change set against — computing the insert against
    the post-cut document is the classic off-by-a-line in this shape.

    The blank line is not cosmetic: `one\ntwo` is one paragraph with a soft
    break in CommonMark, so an image line pushed directly under a sentence would
    join that sentence in every other reader of the file, however this editor
    chose to draw it.
  */
  return {
    changes: [
      { ...cutBlock(state, row.from), insert: "" },
      { from: target.to, to: target.to, insert: `\n\n${row.text}` },
    ],
  };
}

/**
 * The range that deletes the block a line is, blank line and all.
 *
 * Deleting only the line leaves the blank lines that separated it from its
 * neighbours stacked on each other, which is a visible gap in the note and a
 * diff nobody asked for. Which side the blank line is taken from depends on
 * where the line sits, and the three cases are exactly the three positions a
 * block can be in: with something after it, at the end of the note, or packed
 * against its neighbours with no blank lines at all.
 */
export function cutBlock(state: EditorState, at: number): { from: number; to: number } {
  const doc = state.doc;
  const line = doc.lineAt(at);
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
  const previous = line.number > 1 ? doc.line(line.number - 1) : null;
  if (next !== null && next.text.trim() === "") {
    return { from: line.from, to: Math.min(doc.length, next.to + 1) };
  }
  if (next === null && previous !== null && previous.text.trim() === "") {
    return { from: Math.max(0, previous.from - 1), to: line.to };
  }
  return { from: line.from, to: Math.min(doc.length, line.to + 1) };
}

/**
 * Where a pasted image lands, and where the caret goes after it.
 *
 * On its own line, always, because a row is a line and an embed dropped into
 * the middle of a sentence would be prose rather than an image this editor can
 * lay out.
 *
 * **The caret goes to the line *after* it, and that is the whole of the second
 * version of this function.** The first put the caret after the embed, which is
 * on the image's own line — and the reveal rule then does exactly what it is
 * supposed to do: the line the selection is in shows its markup. So a paste
 * ended with the raw `![[…]]` on screen, drawn as a link, and the image
 * appeared only once somebody clicked somewhere else. Reported as "just pasted
 * an image, and got this", with a screenshot of a link.
 *
 * A blank line is written under the embed when there is not already one, so
 * there is somewhere for the caret to be that is not the image's line — and
 * it is where you would keep typing anyway.
 */
export function planInsert(
  state: EditorState,
  target: string,
  width: number | null,
): TransactionSpec {
  const embed = embedFor(target, width);
  const line = state.doc.lineAt(state.selection.main.head);
  const onEmptyLine = line.text.trim() === "";
  const from = onEmptyLine ? line.from : line.to;
  const insert = `${onEmptyLine ? "" : "\n"}${embed}\n`;
  return {
    changes: { from, to: onEmptyLine ? line.to : line.to, insert },
    // After the newline this just wrote: the image's own line is left alone, so
    // the row draws the moment the paste lands.
    selection: { anchor: from + insert.length },
  };
}

/**
 * The image files on a clipboard or drop event, in the order they arrive.
 *
 * **Both lists, because neither is always the one with the image in it.**
 * `files` is populated for a drag from the desktop and for a screenshot pasted
 * by current Chrome and Safari; `items` is what an older WebKit and some
 * applications put a pasted image in, with `files` left empty. Reading one and
 * not the other is a paste that works on the machine it was written on.
 *
 * De-duplicated by identity, since a browser that populates both populates them
 * with the same `File`.
 */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (data === null) return [];
  const images = (list: readonly (File | null)[]): File[] =>
    list.filter((file): file is File => file !== null && file.type.startsWith("image/"));
  /*
    `files` FIRST, AND ONLY ITS ANSWER WHEN IT HAS ONE.

    Both lists describe the same clipboard, and the first version of this read
    both and de-duplicated by identity — which is wrong, because
    `DataTransferItem.getAsFile()` mints a NEW `File` object on every call. So a
    browser that fills both (Chrome, for one) handed back the same screenshot
    twice, it was uploaded twice, and the note got two embeds of one image.
    Reported as "images paste twice", with a screenshot of the duplicate.

    `items` is still read, because an older WebKit and some applications leave
    `files` empty and put the image only there — but as a fallback, never as a
    second source to merge.
  */
  const direct = images(Array.from(data.files ?? []));
  if (direct.length > 0) return direct;
  return images(
    Array.from(data.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile()),
  );
}

/** Set alt text on image `index` of `row`. */
export function planAlt(
  state: EditorState,
  row: ImageRow,
  index: number,
  alt: string,
): TransactionSpec | null {
  return replaceLine(state, row, lineWithAlt(row.text, index, alt));
}

/** Point image `index` of `row` at another object. */
export function planReplace(
  state: EditorState,
  row: ImageRow,
  index: number,
  target: string,
): TransactionSpec | null {
  return replaceLine(state, row, lineWithTarget(row.text, index, target));
}

/**
 * Take image `index` out of the note.
 *
 * The last image on a line takes the line with it — a blank line where a
 * picture was is a gap somebody has to tidy by hand — and the **object stays in
 * the bucket** either way: deleting a paragraph should not delete somebody's
 * screenshot, and the unreferenced sweep offers it by name later.
 */
export function planRemove(
  state: EditorState,
  row: ImageRow,
  index: number,
): TransactionSpec | null {
  const rest = lineWithout(row.text, index);
  if (rest === null) return { changes: { ...cutBlock(state, row.from), insert: "" } };
  return replaceLine(state, row, rest);
}
