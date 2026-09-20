import { useSyncExternalStore } from "react";

/**
 * Whether the route's own chrome is holding the shell's traffic lights.
 *
 * ## Why this exists
 *
 * `ShellTitleBand` is mounted once, in `app/_layout.tsx`, above every route —
 * the sign-in group and the console alike — because the buttons are over the
 * top-left corner of the window whether or not there is a session yet
 * (`docs/decisions/desktop.md`, "The console reserves the space"). Drawn
 * unconditionally, that band is an empty 45pt strip sitting on top of the
 * console's own 45pt top bar: 90pt of chrome before any content, half of it
 * blank, where the Mac apps this one is compared to put the buttons *in* the
 * bar and spend nothing extra.
 *
 * The console's top bar can hold them — it is exactly the band's height, and
 * its leading edge is a chip it can push right. The sign-in screen cannot: it
 * has no bar. Nor can the phone layout, whose bar is absolute, transparent and
 * lying over the document. So this is not a constant that can be applied
 * everywhere; it is a **handshake**: a route that has taken the job says so,
 * and the root band stands down for exactly as long as that is true.
 *
 * ## Why a module-level store rather than a context
 *
 * The same argument `bottomChrome.ts` makes for the other edge, in reverse.
 * The band is mounted *above* every route — that is what makes it appear on
 * the sign-in screen too — so it cannot read a provider that a route renders
 * below it. An external store needs nothing above anything, so neither file
 * has to know where the other is mounted.
 *
 * It is one flag, not a stack of registrations, because only one frame is on
 * screen at a time. A frame publishes on mount and on every change, and
 * publishes `false` on the way out — so a screen with no bar of its own leaves
 * the band standing, which is the behaviour every non-console route needs.
 *
 * ## The one caller that must ignore it
 *
 * `Overlay` draws settings in a `Modal`, which is its own root view on every
 * platform: nothing in the route tree is above it, and the console frame
 * *behind* it goes on publishing `true` the whole time it is open. An overlay
 * that read this flag would stand its own band down and put the buttons back
 * over its own first control — which is the defect #697 fixed. It therefore
 * renders `ShellTitleBand` directly and unconditionally; only
 * `RootShellTitleBand`, the root layout's one, reads this store. See
 * `ShellTitleBandView.tsx` for the two components that split on exactly this.
 */

/**
 * ## Why a set of claims rather than one boolean
 *
 * `bottomChrome.ts` publishes one number and says why it may: only one frame
 * is on screen at a time, and if that ever stopped being true its own failure
 * would be a wrong *height* that the next toolbar change corrects.
 *
 * This one's would not correct itself. Two frames mounted at once, the second
 * claiming and the first unmounting a commit later, leaves a bare `false`
 * behind — the band comes back up over a bar that is still holding the
 * buttons and still paying the lead, which is the original defect, and the
 * frame that still holds them never re-renders to say so again. It would sit
 * there until something unrelated moved.
 *
 * One `Set` keyed by the caller removes the ordering question rather than
 * arguing it is unreachable today (one route mounts a frame; the two e2e
 * fixtures are alternatives of one screen). A release takes out only the
 * claim it was given, so whoever is left keeps the job.
 */
const claims = new Set<string>();
const listeners = new Set<() => void>();

let holdsLights = false;

function recompute(): void {
  const next = claims.size > 0;
  if (next === holdsLights) return;
  holdsLights = next;
  for (const listener of listeners) listener();
}

/**
 * Publish whether the chrome this caller draws is holding the lights itself.
 *
 * `claim` identifies the caller across its own renders — `AppFrame` uses
 * `useId`, which is stable for the life of a component instance and distinct
 * between two of them.
 *
 * Idempotent in the way that matters: called from a layout effect on every
 * render of the frame, and a `Set` re-adding a member it already has changes
 * nothing, so `recompute` notifies only on a real transition. A version that
 * notified unconditionally would re-render the root band on every keystroke in
 * the editor.
 */
export function setTopChromeHoldsLights(claim: string, holds: boolean): void {
  // Not a claim anybody can be released by later — silently ignored rather
  // than stored under a key its owner could never reproduce.
  if (typeof claim !== "string" || claim === "") return;
  if (holds === true) claims.add(claim);
  else claims.delete(claim);
  recompute();
}

export function topChromeHoldsLights(): boolean {
  return holdsLights;
}

/**
 * The store half of the store, exported the way `subscribeBottomChrome` is:
 * `useSyncExternalStore` needs it, and so does a test watching the flag
 * without a renderer.
 */
export function subscribeTopChrome(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current answer, for the band that has to stand down for it. */
export function useTopChromeHoldsLights(): boolean {
  return useSyncExternalStore(subscribeTopChrome, topChromeHoldsLights, topChromeHoldsLights);
}
