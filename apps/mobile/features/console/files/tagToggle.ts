import { EditorSelection, type ChangeSpec, type SelectionRange } from "@codemirror/state";

/**
 * Toggling a marker that is a pair of tags, `<u>`…`</u>`, rather than a run of
 * one repeated character.
 *
 * `markerToggle.ts` decides `**`, `*`, `~~` and `` ` `` by counting runs of the
 * marker's character, and says so: a tag cannot be counted that way. The
 * underline key on the writing bar (owner, 2026-11-08) is the first tag, so
 * this is the smaller rule it needs, and `planToggle` hands any marker that is
 * not a run to it:
 *
 *  - **A caret in a word underlines the word**; on whitespace it inserts an
 *    empty pair with the caret between, ready to type.
 *  - **A selection gets the tags around it**, with whitespace at either end
 *    left outside, as `planToggle` does for bold.
 *  - **A selection already inside the tags, or holding them at both ends,
 *    takes them off.** That is the second press undoing the first, which is
 *    the whole contract a toggle key has.
 *
 * No splitting of a longer underlined run around a selection, and no merging:
 * underline is a key for a word or a phrase, and the simple rule is the one a
 * person can predict.
 */

export interface TagPlan {
  changes: ChangeSpec[];
  range: SelectionRange;
  removed: boolean;
}

/** Whether `marker` is a run of one repeated character (`**`, `~~`), which `markerToggle.ts` handles. */
export function isRunMarker(marker: string): boolean {
  return marker.length > 0 && [...marker].every((char) => char === marker[0]);
}

const WORD = /[\p{L}\p{N}_'’-]/u;

export function planTagToggle(
  doc: string,
  original: SelectionRange,
  before: string,
  after: string,
  mode: "toggle" | "add" = "toggle",
): TagPlan {
  let from = original.from;
  let to = original.to;
  if (from === to) {
    while (from > 0 && WORD.test(doc[from - 1]!)) from -= 1;
    while (to < doc.length && WORD.test(doc[to]!)) to += 1;
  } else {
    while (from < to && /\s/.test(doc[from]!)) from += 1;
    while (to > from && /\s/.test(doc[to - 1]!)) to -= 1;
  }

  if (mode === "toggle" && from !== to) {
    if (doc.slice(from - before.length, from) === before && doc.slice(to, to + after.length) === after) {
      return {
        changes: [
          { from: from - before.length, to: from, insert: "" },
          { from: to, to: to + after.length, insert: "" },
        ],
        range: EditorSelection.range(from - before.length, to - before.length),
        removed: true,
      };
    }
    if (
      to - from >= before.length + after.length &&
      doc.slice(from, from + before.length) === before &&
      doc.slice(to - after.length, to) === after
    ) {
      return {
        changes: [
          { from, to: from + before.length, insert: "" },
          { from: to - after.length, to, insert: "" },
        ],
        range: EditorSelection.range(from, to - before.length - after.length),
        removed: true,
      };
    }
  }

  if (from === to) {
    return {
      changes: [{ from, insert: before + after }],
      range: EditorSelection.cursor(from + before.length),
      removed: false,
    };
  }
  return {
    changes: [
      { from, insert: before },
      { from: to, insert: after },
    ],
    range: EditorSelection.range(from + before.length, to + before.length),
    removed: false,
  };
}
