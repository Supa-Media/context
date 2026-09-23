import { useEffect, useSyncExternalStore } from "react";

/**
 * Whether a surface on screen is already showing the running meeting.
 *
 * ## Why this exists
 *
 * `RecordingBar` is mounted once, above every route, and floats over whatever
 * you are reading — "a recording with no visible indicator is a bug and not a
 * mode". That was the only answer available while a meeting had nowhere of its
 * own to be.
 *
 * The console's right panel is now that place: a meeting opens in it, with its
 * clock, its name, its notes and the controls that stop it, and the note you
 * were reading stays open beside it. On that screen the floating bar is the
 * second copy of the same controls this feature has already fought twice — the
 * bar yields on the meeting's own screen, and the microphone yields to the
 * bar — and the rule is the same one: **one indicator per surface, and it is
 * the one that can actually be worked in.**
 *
 * When the panel is folded away the console does not stop carrying the meeting;
 * it moves the clock into the title bar, which is `ConsoleLiveMeeting`. So the
 * claim here is "this console is showing it, wherever in this console it is",
 * and it is the console that publishes it rather than each of the two places.
 *
 * ## Why a module-level store rather than a context
 *
 * `RecordingBar` is mounted **above** the console in the tree, so it cannot
 * read a provider the console renders below it. That is `bottomChrome.ts`'s
 * argument verbatim, and this is that file's shape with a boolean in it.
 *
 * One claim rather than a set of registrations, because one console is on
 * screen at a time; `useCarriesMeeting` publishes `false` on the way out, so a
 * route that is not the console leaves the bar where it belongs.
 */

let carried = false;
const listeners = new Set<() => void>();

/**
 * How the surface carrying meetings brings one into view, while it is.
 *
 * A meeting started from somewhere other than that surface's own button —
 * resuming one from the floating bar, or from its note — has to land where the
 * meetings are shown: the console's panel when there is one, the meeting's own
 * page when there is not. The console registers the first through
 * `useCarriesMeeting`; nothing registered means the page.
 */
let shower: (() => void) | null = null;

export function setMeetingCarried(next: boolean): void {
  if (next === carried) return;
  carried = next;
  for (const listener of listeners) listener();
}

export function meetingCarried(): boolean {
  return carried;
}

export function subscribeMeetingCarried(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For the bar, which stands down while something better is on screen. */
export function useMeetingCarried(): boolean {
  return useSyncExternalStore(subscribeMeetingCarried, meetingCarried, meetingCarried);
}

/**
 * Claim the running meeting for this surface, for as long as it is mounted.
 *
 * `carries` is a condition rather than a bare mount, because the console only
 * carries it at the densities that have a panel: `regionsFor` gives compact no
 * right panel at all, so a phone-width console shows the meeting nowhere and
 * the floating bar is still the whole indicator there.
 */
export function useCarriesMeeting(carries: boolean, show?: () => void): void {
  useEffect(() => {
    setMeetingCarried(carries);
    return () => setMeetingCarried(false);
  }, [carries]);
  useEffect(() => {
    if (!carries || show === undefined) return;
    shower = show;
    return () => {
      if (shower === show) shower = null;
    };
  }, [carries, show]);
}

/** Bring the running meeting into view on the carrying surface. `false` when nothing carries it. */
export function showCarriedMeeting(): boolean {
  if (!carried || shower === null) return false;
  shower();
  return true;
}
