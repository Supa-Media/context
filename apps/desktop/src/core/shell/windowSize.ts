/**
 * How small the console window may get.
 *
 * The desktop app never shows the console's phone layout (decided by the owner,
 * 2026-10-21), and the page picks that layout from its own width in CSS pixels.
 * So the floor is a page width, `SHELL_MIN_PAGE_WIDTH_PX`, and the window's
 * floor is that times the zoom factor: Cmd-plus makes every CSS pixel bigger,
 * and a floor fixed in points is one that zooming in walks straight past.
 *
 * Pure, so `test/shell.test.mjs` checks it without Electron. `main/windows.ts`
 * applies it when the window opens, on every load and on every zoom change.
 */

import { SHELL_MIN_PAGE_WIDTH_PX } from "@context/desktop-bridge";

export const CONSOLE_MIN_HEIGHT = 480;

export interface WindowSize {
  width: number;
  height: number;
}

/** The window's minimum size at a zoom factor; a factor that is not a positive number counts as 1. */
export function consoleMinimumSize(zoomFactor: number): WindowSize {
  const factor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return { width: Math.ceil(SHELL_MIN_PAGE_WIDTH_PX * factor), height: CONSOLE_MIN_HEIGHT };
}

/**
 * The size to grow a window to so it meets its minimum, or `null` when it does.
 *
 * Raising the minimum does not resize a window that is already smaller on every
 * platform, so a zoom-in on a narrow window has to grow it explicitly.
 */
export function grownToMinimum(current: WindowSize, minimum: WindowSize): WindowSize | null {
  if (current.width >= minimum.width && current.height >= minimum.height) return null;
  return {
    width: Math.max(current.width, minimum.width),
    height: Math.max(current.height, minimum.height),
  };
}
