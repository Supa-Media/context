import { AppState } from "react-native";

/** The browser events that mean somebody may be back and the network may be too. */
export type ReturnEvent = "online" | "focus" | "visibilitychange";

const EVERY_RETURN: readonly ReturnEvent[] = ["online", "focus", "visibilitychange"];

/**
 * Call `callback` whenever somebody comes back to the app, and return the
 * function that stops listening.
 *
 * **`typeof window !== "undefined"` is not the test for a browser.** React
 * Native defines `window` as the global object, so the check passes on a phone
 * — and `window.addEventListener` is `undefined` there. Calling it threw
 * "undefined is not a function" from inside the effects that open a note's
 * room, which took the whole note screen down to the error boundary the first
 * time a phone opened a note. The test is whether `addEventListener` is a
 * function, and this is the one place that asks it.
 *
 * On a phone, the app becoming `active` again is what `focus` and
 * `visibilitychange` mean in a tab, so that is what it listens for instead.
 * There is no `online` counterpart: a dropped socket already reconnects on its
 * own backoff, and returning to the app retries it at once.
 */
export function onReturnToApp(
  callback: () => void,
  events: readonly ReturnEvent[] = EVERY_RETURN,
): () => void {
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const target = window;
    for (const event of events) target.addEventListener(event, callback);
    return () => {
      for (const event of events) target.removeEventListener(event, callback);
    };
  }
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") callback();
  });
  return () => subscription.remove();
}
