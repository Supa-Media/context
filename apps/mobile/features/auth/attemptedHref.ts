import { useUnstableGlobalHref } from "expo-router";
import { attemptedHrefFrom } from "./redirect";

/**
 * The URL to bring somebody back to after signing in.
 *
 * The rule itself is `attemptedHrefFrom`, which lives beside `safeNextRoute`
 * in `redirect.ts` — pure, free of React and of expo-router, and therefore
 * testable without a transform. Read its comment for the measured failure this
 * exists to prevent.
 *
 * `useUnstableGlobalHref` is still called, for two reasons: it is the native
 * answer, and it is what makes this **reactive**. `window.location` is not
 * state React knows about, so reading it alone would return a stale URL to any
 * render the router did not already cause. Subscribing to the router's own
 * route info means every navigation re-renders this, and the value is then
 * read fresh from the document.
 */
export function useAttemptedHref(): string {
  const routerHref = useUnstableGlobalHref();
  return attemptedHrefFrom(
    typeof window === "undefined" ? null : window.location,
    routerHref,
  );
}
