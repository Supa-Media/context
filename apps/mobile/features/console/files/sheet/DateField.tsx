/**
 * A date cell's editor on a phone or desktop build: a plain field that takes
 * YYYY-MM-DD. The web build has a real date input (`DateField.web.tsx`).
 */

import { StyleSheet, TextInput } from "react-native";
import { pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { useFieldFont } from "../../../design/fieldFont";

export function DateField({
  value,
  label,
  onChange,
  onBlur,
  onSubmit,
}: {
  value: string;
  label: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  onSubmit: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(pointerType.ui);
  const colors = useColors();
  return (
    <TextInput
      autoFocus
      accessibilityLabel={label}
      placeholder="YYYY-MM-DD"
      placeholderTextColor={colors.chromeMuted}
      value={value}
      onChangeText={onChange}
      onBlur={onBlur}
      onSubmitEditing={onSubmit}
      autoCapitalize="none"
      autoCorrect={false}
      style={[styles.input, fieldFont]}
      testID="sheet-cell-editor"
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    input: {
      height: 26,
      width: "100%",
      paddingHorizontal: space.x1,
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: radii.sm,
      color: colors.text,
      backgroundColor: colors.ground,
      fontSize: pointerType.ui,
    },
  });
