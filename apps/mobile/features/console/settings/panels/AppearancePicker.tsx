import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { leading, pointerType, radii } from "../../../design/tokens";
import { useAppearance, useThemedStyles, type Colors } from "../../../design/theme";
import { setAppearance, type Appearance } from "../../../design/appearance";

const OPTIONS: readonly { key: Appearance; label: string }[] = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "system", label: "Device" },
];

/**
 * Light, Dark, or whatever the device says — the Look row on Profile (Dev2,
 * 2026-10-14). Three chips in one track, the admin console's `Segments`
 * shape, because three short words need no sentence each. The pick applies
 * at once and is saved on the account (`design/appearance.ts`).
 */
export function AppearancePicker() {
  const styles = useThemedStyles(makeStyles);
  const value = useAppearance();
  return (
    <View style={styles.track} role="radiogroup" aria-label="Look" testID="appearance-picker">
      {OPTIONS.map((option) => {
        const on = option.key === value;
        return (
          <Pressable
            key={option.key}
            role="radio"
            aria-checked={on}
            onPress={() => void setAppearance(option.key)}
            style={[styles.chip, on && styles.chipOn]}
            testID={`appearance-${option.key}`}
          >
            <Text style={[styles.label, on && styles.labelOn]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    track: {
      flexDirection: "row",
      gap: 2,
      padding: 2,
      borderRadius: radii.lg,
      backgroundColor: colors.chipFill,
    },
    chip: { paddingVertical: 4, paddingHorizontal: 12, borderRadius: 5 },
    chipOn: {
      backgroundColor: colors.surface,
      boxShadow: `0 0 0 1px ${colors.line}, 0 1px 2px rgba(0,0,0,.06)`,
    },
    label: {
      fontSize: pointerType.meta,
      lineHeight: leading(pointerType.meta, 1.55),
      fontWeight: "500",
      color: colors.muted,
    },
    labelOn: { color: colors.text },
  });
