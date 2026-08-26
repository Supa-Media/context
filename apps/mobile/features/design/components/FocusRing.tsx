import { StyleSheet, View } from "react-native";
import { colors } from "../tokens";

/**
 * The mockup's `:focus-visible{outline:2px solid var(--accent);outline-offset:3px}`.
 *
 * RN's style API has no `outline`, and RN-Web does not surface `:focus-visible`
 * to JS — so this is an absolutely positioned ring, drawn outside the control's
 * bounds, that the pressables toggle from `onFocus`/`onBlur`. The one visible
 * difference from CSS is that a mouse press also focuses, so the ring can
 * appear on click where the browser would have suppressed it.
 */
export function FocusRing({ visible, radius }: { visible: boolean; radius: number }) {
  if (!visible) return null;
  return (
    <View
      aria-hidden
      style={[styles.ring, { borderRadius: radius + 3 }]}
    />
  );
}

const styles = StyleSheet.create({
  ring: {
    position: "absolute",
    // `outline-offset: 3px`
    top: -3,
    left: -3,
    right: -3,
    bottom: -3,
    borderWidth: 2,
    borderColor: colors.accent,
    pointerEvents: "none",
  },
});
