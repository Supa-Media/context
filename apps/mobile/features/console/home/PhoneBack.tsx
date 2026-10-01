import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import type { PhoneBackTarget } from "./phoneBack";

/**
 * The phone's top-left on any page below Home: ‹ and where it goes.
 *
 * Apple Notes' back button — a chevron and the name of the page above, in the
 * accent — on the same floating capsule as the trailing group, so the top row
 * is two objects of one kind. `after` is anything that has to stay beside it:
 * a signed-out visitor's Sign in, which is the one call to action the top bar
 * carries and has nowhere else to go.
 */
export function PhoneBack({
  target,
  onBack,
  after,
}: {
  target: PhoneBackTarget;
  onBack: () => void;
  after?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel={`Back to ${target.label}`}
        style={({ pressed }) => [styles.capsule, pressed ? styles.pressed : null]}
        testID="phone-back"
      >
        <Icon name="chevronLeft" size={18} color={colors.accent} />
        <Text variant="rowTitle" style={styles.label} numberOfLines={1}>
          {target.label}
        </Text>
      </Pressable>
      {after}
    </View>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, minWidth: 0, flexShrink: 1 },
    capsule: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
      minHeight: layout.minTouchTarget,
      maxWidth: 180,
      paddingLeft: space.x2,
      paddingRight: space.x3,
      borderRadius: radii.pill,
      backgroundColor: colors.chrome,
      boxShadow: shadows.floating,
    },
    pressed: { opacity: 0.7 },
    label: { flexShrink: 1, color: colors.accent, fontWeight: "600" },
  });
