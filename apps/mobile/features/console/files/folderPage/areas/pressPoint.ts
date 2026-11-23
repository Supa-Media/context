import type { GestureResponderEvent } from "react-native";

/**
 * Where a press landed, in window coordinates, for anchoring a `Menu`.
 *
 * `Menu` draws its popover `position: fixed`, so the anchor has to be in the
 * viewport's coordinates. On web the DOM event carries `clientX/clientY`;
 * `pageX/pageY` add the document's scroll, which puts the popover off-screen
 * on a scrolled page. Native has only `pageX/pageY`, already window-relative.
 */
export function pressPoint(event: GestureResponderEvent): { x: number; y: number } {
  const native = event.nativeEvent as unknown as { clientX?: number; clientY?: number; pageX?: number; pageY?: number };
  return {
    x: native.clientX ?? native.pageX ?? 0,
    y: native.clientY ?? native.pageY ?? 0,
  };
}
