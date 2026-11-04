import type { ReactNode } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { fonts, pointerType, space } from "../../tokens";
import { useColors, useThemedStyles, type Colors } from "../../theme";
import { Text } from "../Text";
import { SketchBox } from "./SketchBox";

/**
 * One choice in a row of filters or scopes: plain words while off, circled in
 * pencil while on (owner, 2026-11-04, shown the pencil loop on "things you
 * switch on": "this looks good"). No capsule and no fill either way, so the
 * row reads as words on paper with the chosen one ringed.
 */
export function LoopChoice({
  label,
  on,
  onPress,
  after,
  style,
  accessibilityLabel,
  testID,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  /** Anything after the words, like a count. */
  after?: ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
      {...(testID === undefined ? {} : { testID })}
    >
      <SketchBox look={on ? "loop" : null} color={colors.text} seed={`choice:${label}`} style={[styles.choice, style]}>
        <Text style={[styles.label, on ? styles.labelOn : null]} numberOfLines={1}>
          {label}
        </Text>
        {after}
      </SketchBox>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    choice: { minHeight: 30, gap: space.x1 + 2, paddingHorizontal: space.x3, justifyContent: "center" },
    label: { fontFamily: fonts.body, fontSize: pointerType.ui, color: colors.text2 },
    labelOn: { color: colors.text, fontWeight: "600" },
    pressed: { opacity: 0.6 },
  });
