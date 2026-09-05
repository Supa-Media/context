import { useSyncExternalStore } from "react";
import { layout } from "../design/tokens";
import { floatingGapFor } from "./frame";

/**
 * How much floating chrome is currently lying along the bottom edge.
 *
 * ## Why this exists
 *
 * Two things float in the same 66pt of glass. `AppFrame` puts the console's
 * toolbar there, and the persistent recording bar has to be visible **from
 * anywhere in the app** — a recording with no visible indicator is a bug and not
 * a mode (`docs/decisions/meetings.md`, "Consent is the customer's"). So the
 * recording bar is mounted once, at `app/(app)/_layout.tsx`, above every route
 * in the section; and on a console screen that is exactly where the toolbar
 * already is. `AppFrame` itself says what happens when two of them meet — "two
 * floating bars in the same 66pt of glass is worse than either" — which it
 * answers for the keyboard accessory by hiding the toolbar. Hiding a screen's
 * navigation for the length of a meeting is not an answer here, so the
 * recording bar stacks above it instead.
 *
 * ## Why a module-level store rather than a context
 *
 * The recording bar is mounted **above** `AppFrame` in the tree — that is what
 * makes it app-wide — so it cannot read a provider the frame renders below it.
 * The same argument `features/meetings/controller.ts` makes for the recording
 * itself: an external store needs nothing above anything, so neither file has to
 * know where the other is mounted.
 *
 * It is one number, not a stack of registrations, because only one frame is on
 * screen at a time. A frame publishes on mount and on every change, and
 * publishes zero on the way out — so a screen with no toolbar leaves the bar
 * where it belongs, against the bottom of the glass.
 */

let height = 0;
const listeners = new Set<() => void>();

/**
 * Publish the height of the floating chrome at the bottom edge, or `0`.
 *
 * Idempotent: called from a layout effect on every render of the frame, so a
 * version that notified unconditionally would re-render every subscriber on
 * every keystroke in the editor.
 */
export function setBottomChromeHeight(next: number): void {
  const value = Number.isFinite(next) && next > 0 ? next : 0;
  if (value === height) return;
  height = value;
  for (const listener of listeners) listener();
}

export function bottomChromeHeight(): number {
  return height;
}

/**
 * The store half of the store, exported like `MeetingsController.subscribe` is:
 * `useSyncExternalStore` needs it, and so does anything watching the height
 * without a renderer.
 */
export function subscribeBottomChrome(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current height, for a component that has to sit clear of it. */
export function useBottomChromeHeight(): number {
  return useSyncExternalStore(subscribeBottomChrome, bottomChromeHeight, bottomChromeHeight);
}

/**
 * Where a floating bar's bottom edge goes, given the safe area under it and
 * whatever chrome is already there.
 *
 * `floatingGapFor` is the gap from the glass — `max`, never a sum, because on a
 * notched phone the home indicator's inset is already a gap. On top of that, a
 * bar stacking above existing chrome clears the chrome's own height plus the
 * air between two floating things (`floatingInset`), which is the same spacing
 * `AppFrame` puts above its toolbar.
 *
 * A pure function because the geometry is the part worth testing, and jsdom
 * lays nothing out: `__tests__/safeArea.test.ts` makes the same split.
 */
export function floatingStackBottom(safeAreaBottom: number, chromeHeight: number): number {
  const gap = floatingGapFor(safeAreaBottom);
  return chromeHeight > 0 ? gap + chromeHeight + layout.floatingInset : gap;
}
