import { AppState, Platform } from "react-native";
import { ACTIVE_INTERVAL_SECONDS } from "@context/shared";

/**
 * How long after the last touch, key, scroll or pointer move somebody still
 * counts as using the app. Long enough to read a screen without touching it,
 * short enough that a tab left open over lunch stops counting.
 */
export const IDLE_AFTER_MS = 2 * 60_000;

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "touchstart"] as const;

/** Whether this tick is time in the app: the page in front, and a person at it. */
export function isActive({ visible, lastInputAt, now }: { visible: boolean; lastInputAt: number; now: number }): boolean {
  return visible && now - lastInputAt <= IDLE_AFTER_MS;
}

/**
 * Calls `report` every thirty seconds the app is in use, and answers how to stop.
 *
 * Time in app is counted from these ticks rather than from the gap between a
 * session's first and last screen, which loses the last screen entirely and
 * counts a tab left open as hours of use. On the web a tick needs the tab in
 * front and an input inside `IDLE_AFTER_MS`; a native app in the foreground
 * counts, since React Native has no app-wide input event to listen for and a
 * phone locks its screen when nobody is at it.
 */
export function startActiveTime(report: () => void, intervalMs = ACTIVE_INTERVAL_SECONDS * 1000): () => void {
  // A phone has a `window` with no listener methods (`nativeWindowEvents.test.ts`).
  const web =
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function" &&
    typeof document !== "undefined";
  let lastInputAt = Date.now();
  const touched = () => {
    lastInputAt = Date.now();
  };
  if (web) {
    for (const name of INPUT_EVENTS) window.addEventListener(name, touched, { capture: true, passive: true });
  }
  const timer = setInterval(() => {
    const active = web
      ? isActive({ visible: document.visibilityState === "visible", lastInputAt, now: Date.now() })
      : AppState.currentState === "active";
    if (active) report();
  }, intervalMs);
  return () => {
    clearInterval(timer);
    if (web) {
      for (const name of INPUT_EVENTS) window.removeEventListener(name, touched, { capture: true });
    }
  };
}
