import { useEffect } from "react";
import { useFrame } from "../../app/AppFrame";

/**
 * Open the right panel when somebody above the frame asks.
 *
 * A component with no output, because `useFrame` only answers inside
 * `AppFrame`, and the console layout is above it. The counter is the event —
 * see where it is held — and `toggleAside` is a no-op at a density with no
 * panel.
 */
export function OpenAsideOn({ at }: { at: number | null }) {
  const frame = useFrame();
  const open = frame.state.asideOpen;
  const toggle = frame.toggleAside;
  useEffect(() => {
    if (at === null || open) return;
    toggle();
    // `open` is deliberately absent: it changes as a *result* of this, and
    // listing it would make the effect re-run on its own outcome.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, toggle]);
  return null;
}
