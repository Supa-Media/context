import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { focusFromKeyboard } from "../focusModality";
import { useThemedStyles, type Colors } from "../theme";

/**
 * The mockup's `:focus-visible{outline:2px solid var(--accent);outline-offset:3px}`.
 *
 * RN's style API has no `outline`, and RN-Web does not surface `:focus-visible`
 * to JS — so this is an absolutely positioned ring, drawn outside the control's
 * bounds, that the pressables toggle from `onFocus`/`onBlur`.
 *
 * A mouse press also focuses, and a ring on click is the thing `:focus-visible`
 * exists to prevent, so the ring asks `focusFromKeyboard` once, when the focus
 * begins, and draws only for the keyboard. Every pressable that draws this ring
 * gets that without passing anything.
 */
export function FocusRing({ visible, radius }: { visible: boolean; radius: number }) {
  if (!visible) return null;
  return <Ring radius={radius} />;
}

/** Mounted when focus begins, so the modality it reads is the one that caused it. */
function Ring({ radius }: { radius: number }) {
  const styles = useThemedStyles(makeStyles);
  const [fromKeyboard] = useState(focusFromKeyboard);
  if (!fromKeyboard) return null;
  return (
    <View
      aria-hidden
      style={[styles.ring, { borderRadius: radius + 3 }]}
    />
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
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
