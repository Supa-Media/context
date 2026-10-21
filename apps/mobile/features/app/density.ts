/**
 * The window's density, split out of `frame.ts` (which re-exports it) so that
 * file stays under the architecture check's review threshold.
 */

import { getDesktopBridge } from "@context/desktop-bridge";
import { layout } from "../design/tokens";

/**
 * How much room there is, in three named steps.
 *
 *  - `compact` — a phone, or a narrow window. One region owns the screen and
 *    the bottom bar carries the verbs.
 *  - `medium` — a tablet, a split-screen laptop window. The explorer earns a
 *    permanent column beside the editor.
 *  - `wide` — a real desktop window. Everything is visible at once.
 */
export type Density = "compact" | "medium" | "wide";

export function densityFor(width: number, inDesktopShell: boolean = pageInDesktopShell()): Density {
  if (width < layout.narrowBreakpoint && !inDesktopShell) return "compact";
  if (width < layout.wideBreakpoint) return "medium";
  return "wide";
}

/**
 * Whether this page runs inside the Mac app, which never shows the phone layout.
 *
 * Decided by the owner, 2026-10-21: "desktop app should never have the mobile
 * view". The shell keeps the window at least `SHELL_MIN_PAGE_WIDTH_PX` wide, but
 * that floor ships in the app, and an update installs only when the app quits,
 * which a menu-bar app rarely does. The page is served live to every build, so
 * it refuses `compact` here too: a narrow Mac window is `medium`, the explorer
 * beside the note, whichever build is running.
 *
 * Remembered per bridge object, because `densityFor` runs on every render and
 * the check walks the bridge's members.
 */
export function pageInDesktopShell(): boolean {
  const candidate = (globalThis as { desktop?: unknown }).desktop;
  if (candidate === undefined || candidate === null) return false;
  if (candidate !== checkedBridge) {
    checkedBridge = candidate;
    checkedAnswer = getDesktopBridge() !== null;
  }
  return checkedAnswer;
}

let checkedBridge: unknown = undefined;
let checkedAnswer = false;
