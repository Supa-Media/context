import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import type { PhoneBackTarget } from "./phoneBack";

/**
 * The phone's top-left on any page below Home: a round ‹ that goes up one
 * level.
 *
 * The owner's second word on it (2026-10-15): *"Back button should just go
 * back, no need to click into specific folder i want to go back to. If needed
 * il click back three times to get to root folder"*. So one press is one level
 * — a note to its folder, a folder to the one it is in, the top to Home — and
 * there is no menu of levels to choose from (that was 2026-10-13's board C).
 *
 * `after` is anything that has to stay beside it: a signed-out visitor's Sign
 * in, which is the one call to action the top bar carries and has nowhere else
 * to go.
 */
export function PhoneBack({
  levels,
  onGo,
  after,
}: {
  /** From `phoneBackLevels`: Home first, the page's own folder last. Never empty. */
  levels: PhoneBackTarget[];
  onGo: (target: PhoneBackTarget) => void;
  after?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const nearest = levels[levels.length - 1]!;
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => onGo(nearest)}
        accessibilityRole="button"
        accessibilityLabel={`Back to ${nearest.label}`}
        style={({ pressed }) => [styles.key, pressed ? styles.pressed : null]}
        testID="phone-back"
      >
        <Icon name="chevronLeft" size={20} color={colors.accent} />
      </Pressable>
      {after}
    </View>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, minWidth: 0, flexShrink: 1 },
    key: {
      alignItems: "center",
      justifyContent: "center",
      width: layout.minTouchTarget,
      height: layout.minTouchTarget,
      minHeight: layout.minTouchTarget,
      borderRadius: radii.pill,
      backgroundColor: colors.chrome,
      boxShadow: shadows.floating,
    },
    pressed: { opacity: 0.7 },
  });
