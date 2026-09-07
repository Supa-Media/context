import { useEffect } from "react";
import { autosaves, needsDecision, type EditorState } from "./editor";

/**
 * The exit the app does not own — web.
 *
 * ## What this used to be, and why it changed
 *
 * A `beforeunload` prompt, on for every unsaved draft. It existed because
 * nothing autosaved: the only route from the editor to the customer's bucket
 * was the Save button, so closing the tab left the draft on the device and
 * never in the bucket — and the resting line says "Saved in your bucket", a
 * claim the dirty state had no counterpart for.
 *
 * Autosave changes the answer, not the question. The right thing to do when
 * somebody leaves is **to write the draft**, and only to interrupt them about
 * the one it cannot write. So this hook now does two different jobs, attached
 * on two different conditions:
 *
 *  - **Flush.** `visibilitychange` (to hidden) and `pagehide` are the last
 *    reliable moments a page gets, and they fire for switching tabs and
 *    switching apps as well as for closing — so the pending write goes out
 *    when somebody looks away, long before the tab is really closed. Both,
 *    because neither is universal: Safari on iOS has historically not fired
 *    `beforeunload` at all and reaches `pagehide` on its way into the back/
 *    forward cache, while a desktop tab that is closed fires `pagehide` after
 *    the last `visibilitychange`.
 *  - **Prompt.** Only while `needsDecision` — a conflict, or a save that
 *    failed. Those are the states autosave refuses (`autosaves`), so leaving
 *    really does leave something nobody will do, and it is the last moment
 *    anybody can say so.
 *
 * **The flush is best-effort and is not the guarantee.** A `writeNote` issued
 * from a page that is being torn down may or may not leave the machine; the
 * thing that makes a draft safe is `features/offline`, which has it on the
 * device already. This is the difference between a tab closed at a coffee shop
 * costing nothing and costing a trip back to the same browser.
 *
 * ## Why the prompt's shape is this and not something nicer
 *
 * `beforeunload` is the only hook a browser gives for it, and it is
 * deliberately unfriendly: the message is the browser's, not ours — every
 * engine has ignored a custom string since 2016 — and the listener must be
 * attached *only* while there is something to lose, or Chrome and Safari
 * increasingly decline to show the prompt at all for pages that always ask.
 * That rule is why autosave makes the prompt **better** rather than merely
 * rarer: a page that asked on every draft was spending the browser's patience
 * on the case that was never in danger.
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
export function useUnsavedGuard(options: {
  /** The open note. Both conditions below are read off it, in one place. */
  editor: EditorState;
  /** Write whatever autosave is holding, now. */
  flush: () => void;
}): void {
  const { editor, flush } = options;
  // Exactly the predicate the timer uses, so "is there something to flush"
  // cannot come to mean something different here than it does there.
  const pending = autosaves(editor);
  const undone = needsDecision(editor);

  useEffect(() => {
    if (!pending || typeof window === "undefined") return;

    const onHidden = () => {
      // `visibilitychange` fires in both directions; only one of them is an
      // exit. Flushing on becoming *visible* would be a write per tab switch.
      if (document.visibilityState === "hidden") flush();
    };
    const onPageHide = () => flush();

    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [flush, pending]);

  useEffect(() => {
    if (!undone || typeof window === "undefined") return;

    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Legacy Chrome/Edge (< 119) only. See the file comment.
      event.returnValue = true;
    };

    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [undone]);
}
