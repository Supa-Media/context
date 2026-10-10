import { useState } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { FocusRing } from "../design/components/FocusRing";
import { Text } from "../design/components/Text";
import { radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";

/**
 * Pick one of two or three, drawn as a track with the choice raised in it:
 * the What changed page's tabs (`organizer/WhatChangedPage.tsx`), at full
 * width so each segment is a thumb's width on a phone. A radio group to a
 * screen reader, because that is what it is: one answer, chosen in place.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  style,
  testID,
}: {
  /** What is being chosen, e.g. "What you're saving". */
  label: string;
  options: ReadonlyArray<{ value: T; label: string; accessibilityLabel?: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  style?: ViewStyle;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.track, style]} role="radiogroup" aria-label={label} testID={testID}>
      {options.map((option) => (
        <Segment
          key={option.value}
          label={option.label}
          accessibilityLabel={option.accessibilityLabel}
          on={option.value === value}
          disabled={disabled}
          onPress={() => onChange(option.value)}
          testID={testID === undefined ? undefined : `${testID}-${option.value}`}
        />
      ))}
    </View>
  );
}

function Segment({
  label,
  accessibilityLabel,
  on,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  accessibilityLabel?: string;
  on: boolean;
  disabled: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      role="radio"
      aria-checked={on}
      accessibilityState={{ checked: on, selected: on, disabled }}
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.segment, on ? styles.segmentOn : hovered && !disabled ? styles.segmentHover : null]}
      testID={testID}
    >
      <Text variant="rowTitle" numberOfLines={1} style={on ? styles.textOn : styles.text}>
        {label}
      </Text>
      <FocusRing visible={focused && !disabled} radius={9} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    track: {
      flexDirection: "row",
      gap: 4,
      padding: 4,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
    },
    segment: {
      flex: 1,
      minHeight: 38,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: 9,
    },
    segmentHover: { backgroundColor: colors.rowSelected },
    segmentOn: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, paddingVertical: 7 },
    text: { color: colors.text2, fontWeight: "500" },
    textOn: { color: colors.text },
  });
