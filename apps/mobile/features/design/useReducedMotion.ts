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

    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (value) => setReduced(value),
    );

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return reduced;
}
