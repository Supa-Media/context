import { useLayoutEffect, useRef, type JSX, type ReactNode } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";
import { motion } from "../tokens/motion";
import { useSharedReducedMotion } from "./Reveal";

/**
 * A block whose contents load in pieces, easing to each new height instead of
 * jumping to it.
 *
 * `Reveal` is for something that appears or goes; this is for something that
 * is already there and changes size — a folder page's head, whose chaos line,
 * status line and about words each answer a moment after the page drew. Each
 * of those used to push the list under it down in one frame (the owner,
 * 2026-10-14: "When the about content loads in a folder, everything is
 * jumpy"). Reveal eases a box from nothing to its content's height, and once
 * open its `1fr` row follows the content natively, a jump at a time; this
 * follows it over `motion.layoutMs`, the same ease, so the two read as one.
 *
 * **Web** watches the content with a `ResizeObserver` and sets the box's height
 * to it. The observer answers after layout and before paint, so the frame
 * that draws the new content already draws the box at its old height, and
 * the height then eases to the new one. Nothing re-renders: the height is
 * written to the element. The first height is set without an ease — a page
 * that draws with its head already full does not grow into place. The box
 * clips vertically only (`overflow-y: clip`, which unlike `hidden` leaves the
 * other axis visible), so a hover tint that bleeds past the column's edge is
 * not cut off.
 *
 * **Native** draws the contents as they are.
 *
 * Reduced motion follows at once.
 */
type SettleProps = {
  children?: ReactNode;
  /** Applied to the moving box — use it for margins, never for padding. */
  style?: StyleProp<ViewStyle>;
  /** Applied to what is measured inside it: its padding and the gap between its children. */
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Settle({ children, style, contentStyle, testID }: SettleProps): JSX.Element {
  if (Platform.OS !== "web") {
    return (
      <View style={style} testID={testID}>
        <View style={contentStyle}>{children}</View>
      </View>
    );
  }
  return <WebSettle style={style} contentStyle={contentStyle} testID={testID}>{children}</WebSettle>;
}

function WebSettle({ children, style, contentStyle, testID }: SettleProps): JSX.Element {
  const reduced = useSharedReducedMotion();
  const box = useRef<View>(null);
  const content = useRef<View>(null);

  useLayoutEffect(() => {
    const outer = box.current as unknown as HTMLElement | null;
    const inner = content.current as unknown as HTMLElement | null;
    if (outer === null || inner === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      outer.style.height = `${inner.offsetHeight}px`;
    });
    observer.observe(inner);
    return () => {
      observer.disconnect();
      outer.style.height = "";
    };
  }, []);

  return (
    <View
      ref={box}
      testID={testID}
      style={[
        {
          overflowX: "visible",
          overflowY: "clip",
          transition: reduced ? "none" : `height ${motion.layoutMs}ms ${motion.ease}`,
        } as unknown as ViewStyle,
        style,
      ]}
    >
      <View ref={content} style={contentStyle}>{children}</View>
    </View>
  );
}
