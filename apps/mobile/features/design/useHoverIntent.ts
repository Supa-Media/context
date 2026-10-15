import { useCallback, useEffect, useRef } from "react";

/** How long a pointer rests on a row before it counts as about to press it. */
export const HOVER_INTENT_MS = 65;

/**
 * Turn "the pointer is over this" into "this is probably about to be pressed".
 *
 * A pointer crossing a list on its way somewhere else passes over every row in
 * it, and a row that started work for each one would start it for rows nobody
 * chose. So a hover counts only once the pointer has rested for
 * `HOVER_INTENT_MS` — about the gap between arriving on a link and pressing
 * it — and a press-in counts at once. The handlers go on a `Pressable`; with no
 * `onIntent` they do nothing and schedule nothing.
 */
export function useHoverIntent(onIntent: (() => void) | undefined) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(onIntent);
  latest.current = onIntent;

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const hoverIn = useCallback(() => {
    if (latest.current === undefined) return;
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current?.();
    }, HOVER_INTENT_MS);
  }, [cancel]);

  const pressIn = useCallback(() => {
    cancel();
    latest.current?.();
  }, [cancel]);

  return { hoverIn, hoverOut: cancel, pressIn };
}
