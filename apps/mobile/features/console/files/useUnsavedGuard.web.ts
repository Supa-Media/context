import { useEffect } from "react";

/**
 * The browser's own "leave site?" prompt, while a draft is unsaved — web.
 *
 * ## Why this exists at all
 *
 * Nothing in this app autosaves. `editor.ts` holds the draft in a reducer, the
 * only thing that writes it to the bucket is the Save button, and the editor's
 * resting state says "Saved in your bucket" — a claim about durability that
 * the dirty state has no counterpart for. Closing the tab, reloading, or
 * following a link therefore lost the draft in silence.
 *
 * The in-app guards cover the in-app exits: `guardLeaving` refuses to open
 * another note, and the console asks before closing a dirty tab. This is the
 * exit the app does not own.
 *
 * ## Why the shape is this and not something nicer
 *
 * `beforeunload` is the only hook a browser gives for this, and it is
 * deliberately unfriendly: the message is the browser's, not ours — every
 * engine has ignored a custom string since 2016 — and the listener must be
 * attached *only* while there is something to lose, or Chrome and Safari
 * increasingly decline to show the prompt at all for pages that always ask.
 * So the effect's dependency is the boolean, and the listener comes off the
 * moment a save lands.
 *
 * `preventDefault()` is what cancels the unload in every current engine.
 * `returnValue = true` is beside it only for Chrome and Edge before 119, which
 * required the legacy attribute to be touched as well — it is MDN's documented
 * form, and `true` rather than `""` because on the *legacy* `Event.returnValue`
 * alias a falsy assignment is itself a cancel and a truthy one is a no-op, so
 * `true` cannot fight the `preventDefault()` above it on any engine or in jsdom.
 * Nothing returns a string: a custom message has been ignored since 2016 and
 * the browser shows its own.
 *
 * Guarded on `window` existing so a server render or a test environment
 * without a DOM is a no-op rather than a throw.
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty || typeof window === "undefined") return;

    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Legacy Chrome/Edge (< 119) only. See the file comment.
      event.returnValue = true;
    };

    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}
