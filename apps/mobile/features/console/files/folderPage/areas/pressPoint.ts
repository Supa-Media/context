import type { GestureResponderEvent } from "react-native";

/**
 * Where a menu opened by a press should sit, in window coordinates.
 *
 * Under the control that was pressed, flush with its left edge, as the
 * approved prototype places the seat menu: a ⋯ or a row is a trigger, and a
 * menu that starts at the trigger reads as its own. `Menu` and `SeatMenu` draw
 * `position: fixed`, so the anchor is in the viewport's coordinates
 * (`getBoundingClientRect`, `clientX/clientY`); `pageX/pageY` add the
 * document's scroll and put the popover off-screen on a scrolled page. Native
 * has only `pageX/pageY`, already window-relative, and draws a sheet anyway.
 */
export function pressPoint(event: GestureResponderEvent): { x: number; y: number } {
  const target = event.currentTarget as unknown as { getBoundingClientRect?: () => { left: number; bottom: number } } | null;
  if (target !== null && typeof target.getBoundingClientRect === "function") {
    const rect = target.getBoundingClientRect();
    if (rect.left !== 0 || rect.bottom !== 0) return { x: rect.left, y: rect.bottom + 4 };
  }
  const native = event.nativeEvent as unknown as { clientX?: number; clientY?: number; pageX?: number; pageY?: number };
  return {
    x: native.clientX ?? native.pageX ?? 0,
    y: native.clientY ?? native.pageY ?? 0,
  };
}
