/**
 * Two measures the folder page lays itself out by: how wide its Board is on
 * a wide page, and which calendar day it is.
 */

import { space } from "../../../design/tokens";
import { noteColumnWidth } from "../../../app/frame";
import { BOARD_COLUMN } from "./Board";

/** The calendar day a moment falls on, so a list filtered by Due is laid out again when the day turns. */
export function dayOf(now: number): string {
  return new Date(now).toDateString();
}

/** What a board leaves either side of itself on a wide page. */
const BOARD_MARGIN = 48;

/**
 * As wide as its columns want, never narrower than the note's measure (so a
 * two-column board lines up under the title) and never wider than the page
 * less a margin each side, where its columns narrow and then scroll.
 */
export function boardWidth(columns: number, bands: number, pageWidth: number): number {
  const wanted = columns * BOARD_COLUMN + Math.max(0, columns - bands) * space.x4 + Math.max(0, bands - 1) * space.x6;
  const room = Math.max(0, pageWidth - 2 * BOARD_MARGIN);
  return Math.min(room, Math.max(wanted, Math.min(noteColumnWidth, room)));
}
