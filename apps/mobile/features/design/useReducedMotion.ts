import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Whether the viewer has asked for reduced motion.
 *
 * The mockup honours this with `@media (prefers-reduced-motion:reduce)`.
 * RN-Web routes `AccessibilityInfo.isReduceMotionEnabled` through exactly that
 * media query, and native routes it through the OS setting, so one hook covers
 * both. Callers must not start an animation until this has resolved to `false`;
 * it starts `true` so nothing drifts before we know.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true);

  useEffect(() => {
    let cancelled = false;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (!cancelled) setReduced(value);
      })
      .catch(() => {
        // Unsupported platform: assume no preference rather than freezing the
        // page forever.
        if (!cancelled) setReduced(false);
      });

    /*
      `addEventListener` is typed as always returning a subscription and does
      not always return one: a host that stubs `AccessibilityInfo` — jsdom
      under jest, and anything else providing only the promise half — hands
      back `undefined`, and an unguarded `.remove()` then throws during
      *unmount*, where it surfaces as an unrelated component failing to tear
      down. Optional rather than a cast, because the honest shape is "there may
      be nothing to unsubscribe from".
    */
    const subscription: { remove: () => void } | undefined =
      AccessibilityInfo.addEventListener("reduceMotionChanged", (value) =>
        setReduced(value),
      );

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  return reduced;
}
