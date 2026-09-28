import { useEffect, useRef } from "react";

/**
 * Close a popover when the person presses somewhere else, or presses Escape.
 *
 * A popover that only its own trigger can close is one you have to hunt for
 * the button of (Dev2, 2026-09-28, about the sidebar foot's lists). `inside`
 * names the elements that do not count as elsewhere, by their `testID` (RN-Web
 * renders it as `data-testid`): the popover itself and the line that opened
 * it, so a press on the line is left to toggle it rather than being closed
 * here and reopened by the press.
 *
 * The press is not swallowed: a click on a note in the tree closes the list
 * and opens the note, in one press. Web only; a phone draws these as sheets
 * with their own scrim.
 */
export function useDismissOnOutside(open: boolean, inside: readonly string[], onDismiss: () => void): void {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const selector = inside.map((id) => `[data-testid="${id}"]`).join(",");
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(selector) !== null) return;
      dismiss.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss.current();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("touchstart", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("touchstart", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, selector]);
}
