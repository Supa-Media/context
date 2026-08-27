import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { colors, radii } from "../tokens";
import { FocusRing } from "./FocusRing";
import { Text, type TextVariant } from "./Text";

/**
 * `decision` is the only shape not in the mockup, and it exists for one screen.
 *
 * The consent screen's Approve and Deny must carry **identical** visual weight —
 * a screen where refusing is a quieter, smaller, greyer control than accepting
 * is a dark pattern, whatever the copy says. Neither `.btn-white` (the hero
 * CTA, which shouts) nor `.mini` (a chip, which mumbles) can be used for both
 * halves of that pair without one of them winning. So: one shape, used twice,
 * with the words carrying the whole difference.
 */
export type ButtonVariant = "white" | "ghost" | "mini" | "danger" | "decision";

const radiusFor: Record<ButtonVariant, number> = {
  white: radii.cta,
  ghost: radii.xs,
  mini: radii.md,
  danger: radii.md,
  decision: radii.cta,
};

const labelVariant: Record<ButtonVariant, TextVariant> = {
  white: "cta",
  ghost: "ghost",
  mini: "mini",
  danger: "mini",
  decision: "cta",
};

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Rendered after the label — e.g. the ghost link's `↗`. */
  trailing?: ReactNode;
  /** Rendered before the label. */
  leading?: ReactNode;
  style?: ViewStyle;
  /** Defaults to `label`; set it when the label alone is not self-describing. */
  accessibilityLabel?: string;
  testID?: string;
}

/**
 * The four button shapes in the mockup: the white hero CTA, the ghost link
 * beside it, the `.mini` chip used throughout the console, and its `.danger`
 * variant for Revoke / Disconnect.
 *
 * Hover and focus are both real: RN-Web fires `onHoverIn`/`onHoverOut` and
 * `onFocus`/`onBlur` on `Pressable`, so the mockup's `:hover` transitions and
 * focus outline both have somewhere to live.
 */
export function Button({
  label,
  onPress,
  variant = "mini",
  disabled = false,
  trailing,
  leading,
  style,
  accessibilityLabel,
  testID,
}: ButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      role="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        hovered && hoverStyles[variant],
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      {leading}
      <Text
        variant={labelVariant[variant]}
        style={[
          variant === "danger" && styles.dangerLabel,
          variant === "decision" && styles.decisionLabel,
          variant === "ghost" && hovered && styles.ghostLabelHover,
        ]}
      >
        {label}
      </Text>
      {trailing}
      <FocusRing visible={focused && !disabled} radius={radiusFor[variant]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
  },

  /** `.btn-white` */
  white: {
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 27,
    borderRadius: radii.cta,
    backgroundColor: colors.white,
    boxShadow:
      "0 2px 0 rgba(0,0,0,.4), 0 18px 44px -18px rgba(255,255,255,.28)",
  },

  /** `.ghost` */
  ghost: {
    gap: 9,
  },

  /** `.mini` */
  mini: {
    gap: 7,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface3,
  },

  /** `.mini.danger` */
  danger: {
    gap: 7,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.critBorder,
    backgroundColor: colors.surface3,
  },

  /**
   * `decision` — `.mini`'s materials at the hero CTA's scale. Same border,
   * same fill, same radius for both halves of the pair; nothing here is
   * conditional on which of the two it is.
   */
  decision: {
    gap: 9,
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: radii.cta,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface3,
  },

  dangerLabel: { color: colors.critText },
  decisionLabel: { color: colors.text },
  ghostLabelHover: { color: colors.text },

  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.45 },
});

const hoverStyles = StyleSheet.create({
  white: {
    // `.btn-white:hover{transform:translateY(-1px)}` plus the deeper glow.
    transform: [{ translateY: -1 }],
    boxShadow:
      "0 2px 0 rgba(0,0,0,.4), 0 24px 54px -18px rgba(255,255,255,.38)",
  },
  ghost: {},
  mini: { borderColor: "rgba(255,255,255,.26)" },
  danger: { backgroundColor: colors.critWash },
  // Identical hover for both halves of the consent pair, for the same reason
  // their resting state is identical.
  decision: { borderColor: "rgba(255,255,255,.26)" },
});

/**
 * A pressable that is not a button shape — the rail entries, tree nodes, and
 * the workspace switcher. Handles hover/focus the same way so every
 * interactive surface in the console behaves alike.
 */
export function PressRow({
  children,
  onPress,
  selected = false,
  accessibilityLabel,
  role = "button",
  style,
  hoverStyle,
  selectedStyle,
  radius = radii.md,
  testID,
}: {
  children: ReactNode;
  onPress?: () => void;
  selected?: boolean;
  accessibilityLabel: string;
  role?: "button" | "tab" | "link";
  style?: ViewStyle;
  hoverStyle?: ViewStyle;
  selectedStyle?: ViewStyle;
  radius?: number;
  testID?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      role={role}
      accessibilityLabel={accessibilityLabel}
      // `aria-selected` is set directly rather than through
      // `accessibilityState`. react-native-web 0.21 no longer maps
      // `accessibilityState.selected` to an ARIA attribute, so the previous
      // spelling emitted **nothing** — every `role="tab"` in this app was
      // unlabelled for assistive tech, silently, and a render test asserting
      // the prop was passed would still have gone green.
      aria-selected={role === "tab" ? selected : undefined}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      testID={testID}
      style={[style, hovered && !selected && hoverStyle, selected && selectedStyle]}
    >
      {children}
      <FocusRing visible={focused} radius={radius} />
    </Pressable>
  );
}

/** `.dots` — the three window pips in the console title bar. */
export function WindowDots() {
  return (
    <View style={dotStyles.row} aria-hidden>
      <View style={[dotStyles.dot, { backgroundColor: "#FF5F57" }]} />
      <View style={[dotStyles.dot, { backgroundColor: "#FEBC2E" }]} />
      <View style={[dotStyles.dot, { backgroundColor: "#28C840" }]} />
    </View>
  );
}

const dotStyles = StyleSheet.create({
  row: { flexDirection: "row", gap: 6.5 },
  dot: { width: 11, height: 11, borderRadius: 5.5 },
});
