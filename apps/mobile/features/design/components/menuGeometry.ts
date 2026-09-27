/**
 * The popover's geometry: how big each row is and where the box goes.
 *
 * Out of `Menu.web.tsx` because it is arithmetic the component reads rather
 * than anything it draws, and the box's declared size and the flip-above
 * decision are only as right as these numbers.
 */

import type { ViewStyle } from "react-native";
import type { MenuItem } from "../../console/files/menu";
import { space } from "../tokens";
import type { Box } from "./popoverPlacement";

/** Compact: this is a pointer target, and 44pt rows would make it a list. */
export const ROW_HEIGHT = 28;
/**
 * The thumb target, and the floor rather than the aim: the padding takes an
 * ordinary single-line row past it, and this keeps a short label honest.
 */
export const TOUCH_ROW_MIN_HEIGHT = 44;
/** The hairline plus the air above and below it. */
export const SEPARATOR_BLOCK = 1 + space.x1 * 2;
export const PADDING = 6;
export const BORDER = 1;
export const MIN_WIDTH = 200;
export const MAX_WIDTH = 340;
/**
 * Roughly the advance width of the 13px UI face, used to size the box to its
 * longest row. An estimate, and the only one here — but it decides the box's
 * declared `width`, so whatever it estimates is what the browser then lays out.
 * Placement stays exact even when the guess is generous.
 */
export const CHAR_WIDTH = 7;
export const ROW_CHROME = 34;
/**
 * The radio gutter's width plus its gap — what a `checked` row adds in front of
 * its label.
 *
 * Measured rather than left to the layout for the reason `DETAIL_BLOCK` is:
 * `widthFor` decides the box's declared `width`, and a row rendered wider than
 * it was measured is a label clipped mid-word. Every row in a group that has
 * one reserves it, including the unchecked ones, so three radio rows line up.
 */
export const CHECK_BLOCK = 18;

/**
 * What a `detail` line adds to a row.
 *
 * `treeMeta` is 10px on `leading(10, 1.55)` — 15.5 — plus the 2px gap the label
 * column puts between the two lines, rounded up. It is a *measured* addition
 * rather than slack: `heightFor` decides the box's declared height and that
 * height is what the flip-above-the-pointer decision reads, so a row rendered
 * taller than it was measured is a menu that runs off the bottom of the window
 * rather than flipping.
 */
export const DETAIL_BLOCK = 18;

/** A `leading` mark (a presence face, 24px) plus the row's gap after it. */
export const LEADING_BLOCK = 24 + space.x3;

/** The height one row occupies, which is not the same for every row. */
export function rowHeight(item: MenuItem<string>): number {
  return ROW_HEIGHT + (item.detail === undefined ? 0 : DETAIL_BLOCK);
}

export function widthFor(items: readonly MenuItem<string>[]): number {
  let widest = MIN_WIDTH;
  for (const item of items) {
    const chord = item.shortcut === undefined ? 0 : item.shortcut.length + 3;
    const chevron = item.items === undefined ? 0 : 2;
    const gutter = (item.checked === undefined ? 0 : CHECK_BLOCK) + (item.leading === undefined ? 0 : LEADING_BLOCK);
    widest = Math.max(
      widest,
      (item.label.length + chord + chevron) * CHAR_WIDTH + ROW_CHROME + gutter,
    );
    // A detail sits under the label with none of the row's trailing furniture
    // beside it, so it is measured on its own. Wrapping is still allowed —
    // `MAX_WIDTH` wins, and the text is capped at two lines — but a sentence
    // that fits should not be broken to keep the box narrow.
    if (item.detail !== undefined) {
      widest = Math.max(widest, item.detail.length * CHAR_WIDTH + ROW_CHROME + gutter);
    }
  }
  return Math.min(MAX_WIDTH, Math.round(widest));
}

export function heightFor(items: readonly MenuItem<string>[]): number {
  const rules = items.filter((item) => item.separatorBefore === true).length;
  const rows = items.reduce((total, item) => total + rowHeight(item), 0);
  return PADDING * 2 + BORDER * 2 + rows + rules * SEPARATOR_BLOCK;
}

/** How far below the top of the box a given row's own top edge sits. */
export function offsetOfRow(items: readonly MenuItem<string>[], index: number): number {
  let offset = PADDING + BORDER;
  for (let at = 0; at < index; at += 1) {
    if (items[at].separatorBefore === true) offset += SEPARATOR_BLOCK;
    offset += rowHeight(items[at]);
  }
  if (items[index]?.separatorBefore === true) offset += SEPARATOR_BLOCK;
  return offset;
}

/** `position: fixed` is web-only and absent from React Native's style type. */
export function fixedAt(box: Box): ViewStyle {
  return {
    position: "fixed",
    left: box.left,
    top: box.top,
    width: box.width,
    maxHeight: box.height,
  } as unknown as ViewStyle;
}
