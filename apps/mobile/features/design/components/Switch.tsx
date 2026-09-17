import { useState } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { radii } from "../tokens";
import { useThemedStyles, type Colors } from "../theme";
import { FocusRing } from "./FocusRing";

/**
 * A switch: one thing, on or off, changed in place.
 *
 * ## Why this is not `ToggleRow`
 *
 * `Input.tsx` already has a toggle, and it is a different part doing a
 * different job: a full-width option card with a tick, a label and a detail
 * line, drawn as a `checkbox` because it is one of a set somebody is choosing
 * from. This is the trailing control on a row that has already said what it
 * is — the plugin's name is the label, and the switch is the answer. Drawing
 * that as a checkbox card would put the question twice on one row.
 *
 * ## The colours, and the one rule about them
 *
 * On is `accent` — the single hue the palette spends on "here, active, yours" —
 * and never a status tone. A switch that turned `ok` green when the thing was
 * healthy would be a status light somebody can press, and the two really do
 * come apart: a plugin that crash-looped is off without anybody having turned
 * it off. The control says what you set; a pill beside it says what happened.
 *
 * Off is `surface3`, the same raised fill a selected row uses, so an off switch
 * is a shape on the card rather than an outline — this palette carries
 * separation in surface value and keeps its one hairline for dividing rows.
 *
 * ## Geometry
 *
 * 40×24 with a 20px knob and a 2px inset: the knob's travel is the padding, so
 * there is no offset constant to keep in step with the width. `hitSlop` takes
 * the press target past the 44px minimum without the drawn control having to
 * grow into a phone-sized part — the same trick the icon buttons use.
 */
export function Switch({
  value,
  onValueChange,
  label,
  disabled = false,
  style,
  testID,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  /**
   * What this switch is for, in words — normally the name of the thing it
   * turns on. **Not** "on" or "off": the state is carried by `checked`, which
   * is what a screen reader reads out with it, and a label that repeats the
   * state goes stale the moment somebody presses it.
   */
  label: string;
  disabled?: boolean;
  style?: ViewStyle;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      role="switch"
      accessibilityState={{ checked: value, disabled }}
      /*
        Both, deliberately. react-native-web 0.21 no longer maps every
        `accessibilityState` key to an ARIA attribute — the same reason
        `Button` spells out `aria-checked` for its menu items — and
        `accessibilityState` is what native reads. Dropping either one loses a
        platform.
      */
      aria-checked={value}
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={10}
      onPress={() => onValueChange(!value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      testID={testID}
      style={[styles.hit, style]}
    >
      <View
        aria-hidden
        testID={testID === undefined ? undefined : `${testID}-track`}
        style={[styles.track, value && styles.trackOn, disabled && styles.disabled]}
      >
        <View style={[styles.knob, value && styles.knobOn]} />
      </View>
      <FocusRing visible={focused && !disabled} radius={radii.pill} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  hit: {
    alignSelf: "flex-start",
    flexGrow: 0,
    flexShrink: 0,
  },
  track: {
    width: 40,
    height: 24,
    borderRadius: radii.pill,
    padding: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    backgroundColor: colors.surface3,
  },
  trackOn: {
    backgroundColor: colors.accent,
    justifyContent: "flex-end",
  },
  knob: {
    width: 20,
    height: 20,
    borderRadius: radii.pill,
    backgroundColor: colors.muted,
  },
  /*
    `ink` is the ground colour in either palette — near-black on Graphite,
    near-white on Paper — which is exactly what a knob sitting on an accent
    fill needs, since the accent is light on the dark ground and dark on the
    light one. Naming the ground rather than a literal is what keeps this
    correct in both.
  */
  knobOn: {
    backgroundColor: colors.ink,
  },
  disabled: {
    opacity: 0.5,
  },
});
