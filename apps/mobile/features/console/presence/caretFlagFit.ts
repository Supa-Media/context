/**
 * Keeping a peer's name flag inside the note.
 *
 * A flag opens to the right of its caret. A caret near the end of a line —
 * which is where a typist's caret usually is — then carries a flag that runs
 * past the text and, on a phone, off the glass: the owner's screenshot of the
 * homepage (2026-09-28) shows "jo Claude" cut in half by the screen edge.
 *
 * Only the drawn page knows where a caret landed and how wide a name is, so
 * this is a measurement, not a rule: after every update the flags are read,
 * and one that would cross the content's right edge opens leftwards instead,
 * its right edge on the caret. When neither side has room for the whole name
 * (a very long name on a narrow screen), it opens toward the wider side and is
 * capped to that room, ending in an ellipsis — never clipped to a sliver.
 *
 * Two flags that would overlap on one line are stacked: the later one is
 * lifted above the other, and its caret's bar grows up to meet it.
 *
 * Reads and writes go through `requestMeasure`, CodeMirror's own read/write
 * phase, so this never forces a layout in the middle of the editor's.
 */

import { ViewPlugin } from "@codemirror/view";
import type { EditorView, ViewUpdate } from "@codemirror/view";

/** A flag whose natural width does not fit on the side it opens toward. */
export const FLIP_CLASS = "cm-presence-label-flip";
/** The width, in px, a flag may take on the side it opens toward. */
export const ROOM_PROPERTY = "--cm-presence-room";
/**
 * How far, in px, a caret's flag is lifted above its usual place, set on the
 * caret so its bar grows up to meet the flag and the two still read as one.
 */
export const LIFT_PROPERTY = "--cm-presence-lift";
/** Levels a flag may be stacked to; past this they overlap rather than climb off the line. */
const MAX_LEVEL = 3;
/** Clear space, in px, two flags on one level keep between them. */
const GAP = 2;

export interface FlagGeometry {
  /** The caret's x, in the same coordinates as `left` and `right`. */
  caretX: number;
  /** The flag's natural width: the whole name, capped only by its own style. */
  width: number;
  /** The content's left and right edges, inside its padding. */
  left: number;
  right: number;
}

export interface FlagPlacement {
  /** Open leftwards, with the flag's right edge on the caret. */
  flip: boolean;
  /** A cap on the flag's width, or `null` when the whole name fits. */
  room: number | null;
}

/**
 * Which way a flag opens, and how wide it may be. Pure, for the tests.
 *
 * A flag sits one pixel left of its caret (`left: -1px`), so its room to the
 * right runs from there; flipped, it ends one pixel past the caret.
 */
export function placeFlag({ caretX, width, left, right }: FlagGeometry): FlagPlacement {
  const roomRight = right - (caretX - 1);
  const roomLeft = caretX + 1 - left;
  if (width <= roomRight) return { flip: false, room: null };
  if (width <= roomLeft) return { flip: true, room: null };
  const flip = roomLeft > roomRight;
  return { flip, room: Math.max(0, Math.floor(flip ? roomLeft : roomRight)) };
}

/** Where one flag lands horizontally, and which line its caret is on. */
export interface FlagSpan {
  /** The caret's top, which is the same for every caret on one visual line. */
  line: number;
  left: number;
  right: number;
}

/**
 * The level each flag is lifted to, 0 for none. Pure, for the tests.
 *
 * Two people typing a few characters apart put two flags on one spot. Taken
 * in order, each flag goes to the lowest level where it overlaps no flag
 * already placed on its line, so the later one of a pair is the one that
 * moves.
 */
export function stackFlags(spans: readonly FlagSpan[]): number[] {
  const placed: Array<FlagSpan & { level: number }> = [];
  return spans.map((span) => {
    let level = 0;
    const clashes = (at: number) =>
      placed.some(
        (one) =>
          one.level === at &&
          Math.abs(one.line - span.line) < 2 &&
          span.left < one.right + GAP &&
          one.left < span.right + GAP,
      );
    while (level < MAX_LEVEL && clashes(level)) level += 1;
    placed.push({ ...span, level });
    return level;
  });
}

interface Measured {
  label: HTMLElement;
  placement: FlagPlacement;
  /** px to lift this caret's flag by. */
  lift: number;
}

function read(view: EditorView): Measured[] {
  const labels = view.contentDOM.querySelectorAll<HTMLElement>(".cm-presence-label");
  if (labels.length === 0) return [];
  const box = view.contentDOM.getBoundingClientRect();
  const style = getComputedStyle(view.contentDOM);
  const left = box.left + (parseFloat(style.paddingLeft) || 0);
  const right = box.right - (parseFloat(style.paddingRight) || 0);
  const measured: Measured[] = [];
  const spans: FlagSpan[] = [];
  const heights: number[] = [];
  for (const label of labels) {
    const caret = label.parentElement;
    if (caret === null) continue;
    const at = caret.getBoundingClientRect();
    // `scrollWidth` is the whole name even while a previous pass capped it.
    let width = Math.max(label.scrollWidth, label.offsetWidth);
    if (label.classList.contains("cm-presence-label-compact")) {
      // The compact flag's own cap (9em in `caretTheme`) still applies.
      const em = parseFloat(getComputedStyle(label).fontSize);
      if (Number.isFinite(em) && em > 0) width = Math.min(width, em * 9);
    }
    const placement = placeFlag({ caretX: at.left, width, left, right });
    const drawn = placement.room === null ? width : Math.min(width, placement.room);
    // Mirrors the stylesheet: a flag's edge sits 1px past its caret.
    spans.push(
      placement.flip
        ? { line: at.top, left: at.left + 1 - drawn, right: at.left + 1 }
        : { line: at.top, left: at.left - 1, right: at.left - 1 + drawn },
    );
    heights.push(label.getBoundingClientRect().height);
    measured.push({ label, placement, lift: 0 });
  }
  // Levels are laid out in document order, which is the caret's order on a line.
  const levels = stackFlags(spans);
  measured.forEach((one, index) => {
    one.lift = levels[index]! * (heights[index]! + GAP);
  });
  return measured;
}

function write(measured: Measured[]): void {
  for (const { label, placement, lift } of measured) {
    label.classList.toggle(FLIP_CLASS, placement.flip);
    if (placement.room === null) label.style.removeProperty(ROOM_PROPERTY);
    else label.style.setProperty(ROOM_PROPERTY, `${placement.room}px`);
    const caret = label.parentElement;
    if (caret === null) continue;
    if (lift === 0) caret.style.removeProperty(LIFT_PROPERTY);
    else caret.style.setProperty(LIFT_PROPERTY, `${Math.round(lift)}px`);
  }
}

/** The measure request's two halves, exported so a test can tell it from CodeMirror's own. */
export const flagMeasure = { read, write };

/**
 * Re-measures after every update. A caret widget's DOM is reused while its
 * name, colour and size are unchanged (`CaretWidget.eq`), so a flag flipped at
 * the end of one line would stay flipped at the start of the next unless it is
 * measured again wherever it goes.
 */
export const caretFlagFit = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.schedule(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.geometryChanged || update.viewportChanged || update.transactions.length > 0) {
        this.schedule(update.view);
      }
    }

    schedule(view: EditorView): void {
      view.requestMeasure({ key: this, read, write });
    }
  },
);
