/**
 * The console window is never narrow enough for the phone layout.
 *
 * Dev, 2026-10-21: "desktop app should never have the mobile view". The page
 * picks its layout from its width in CSS pixels, so the window's floor is that
 * width times the zoom factor; `core/shell/windowSize.ts` is the rule.
 *
 * ## Sabotage record
 *
 *   `consoleMinimumSize` ignoring the zoom factor and rounding down          3
 *   `grownToMinimum` returning null for a window narrower than the floor     1
 */

import { SHELL_MIN_PAGE_WIDTH_PX } from "@context/desktop-bridge";
import {
  CONSOLE_MIN_HEIGHT,
  consoleMinimumSize,
  grownToMinimum,
} from "../src/core/shell/windowSize.ts";

export function runWindowSizeChecks(check) {
  check(
    "AT ACTUAL SIZE THE WINDOW'S FLOOR IS THE PAGE'S FLOOR",
    consoleMinimumSize(1).width === SHELL_MIN_PAGE_WIDTH_PX && consoleMinimumSize(1).height === CONSOLE_MIN_HEIGHT,
  );
  check(
    "ZOOMED IN, THE FLOOR RISES SO THE PAGE STAYS OUT OF THE PHONE LAYOUT",
    consoleMinimumSize(1.25).width === Math.ceil(SHELL_MIN_PAGE_WIDTH_PX * 1.25) &&
      consoleMinimumSize(1.25).width / 1.25 >= SHELL_MIN_PAGE_WIDTH_PX,
  );
  check(
    "...rounded up, so the page is never a fraction of a pixel short",
    [1.1, 1.2, 1.44, 1.728, 2.0736].every((f) => consoleMinimumSize(f).width / f >= SHELL_MIN_PAGE_WIDTH_PX),
  );
  check(
    "ZOOMED OUT, THE WINDOW MAY BE NARROWER, BECAUSE THE PAGE IS STILL WIDE ENOUGH",
    consoleMinimumSize(0.8).width === Math.ceil(SHELL_MIN_PAGE_WIDTH_PX * 0.8),
  );
  check(
    "a zoom factor that is not a positive number counts as actual size",
    [0, -1, Number.NaN, Number.POSITIVE_INFINITY].every(
      (f) => consoleMinimumSize(f).width === SHELL_MIN_PAGE_WIDTH_PX,
    ),
  );
  check(
    "A WINDOW NARROWER THAN THE NEW FLOOR IS GROWN TO IT, KEEPING ITS HEIGHT",
    JSON.stringify(grownToMinimum({ width: 900, height: 700 }, { width: 1100, height: 480 })) ===
      JSON.stringify({ width: 1100, height: 700 }),
  );
  check(
    "...and a window that already meets it is left alone",
    grownToMinimum({ width: 1100, height: 700 }, { width: 1100, height: 480 }) === null,
  );
}
