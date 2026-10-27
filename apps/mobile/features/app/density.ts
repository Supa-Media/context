/**
 * The window's density, split out of `frame.ts` (which re-exports it) so that
 * file stays under the architecture check's review threshold.
 */

import { getDesktopBridge } from "@context/desktop-bridge";
import { layout } from "../design/tokens";

/**
 * How much room there is, in three named steps.
 *
 *  - `compact` — a phone, or a narrow touch screen. One region owns the screen and
 *    the bottom bar carries the verbs.
 *  - `medium` — a tablet, a split-screen laptop window. The explorer earns a
 *    permanent column beside the editor.
 *  - `wide` — a real desktop window. Everything is visible at once.
 */
export type Density = "compact" | "medium" | "wide";

export function densityFor(width: number, onComputer: boolean = pageOnComputer()): Density {
  if (width < layout.narrowBreakpoint && !onComputer) return "compact";
  if (width < layout.wideBreakpoint) return "medium";
  return "wide";
}

/**
 * Whether this page is on a computer, which never shows the phone layout.
 *
 * Decided by the owner: "desktop app should never have the mobile view"
 * (2026-10-21), then, of a narrow browser tab on context.lc, "why web version
 * transforming into mobile UI?" (2026-10-27). The phone layout is for a hand
 * holding a screen, not for a narrow window, so `compact` needs both a narrow
 * width and a touch screen as the main way in. A computer is the Mac app, or a
 * page whose main pointer is a mouse or trackpad (`(hover: hover) and
 * (pointer: fine)`): a narrowed computer window is `medium` instead. A phone,
 * a tablet held in the hand, the native app (no `matchMedia`) and jsdom all
 * answer false and keep the width rule they had. The editor's CSS phone rules
 * ask the same question with `and (pointer: coarse)`.
 */
export function pageOnComputer(): boolean {
  return pageInDesktopShell() || finePointer();
}

const FINE_POINTER = "(hover: hover) and (pointer: fine)";
let pointerMatcher: unknown = undefined;
let pointerQuery: MediaQueryList | null = null;

/** The main pointer is a mouse or trackpad; read live, so plugging one in counts. */
function finePointer(): boolean {
  const match = (globalThis as { matchMedia?: unknown }).matchMedia;
  if (typeof match !== "function") return false;
  if (match !== pointerMatcher) {
    pointerMatcher = match;
    pointerQuery = (match as (query: string) => MediaQueryList).call(globalThis, FINE_POINTER);
  }
  return pointerQuery?.matches === true;
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
