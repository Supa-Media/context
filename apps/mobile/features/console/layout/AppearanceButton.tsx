import { Platform, Pressable, StyleSheet } from "react-native";
import { Icon } from "../../design/components/Icon";
import { setAppearance } from "../../design/appearance";
import { useColors, useScheme } from "../../design/theme";
import { radii } from "../../design/tokens";

/**
 * Light or dark in one press, on the bottom bar beside the save cloud (Dev2,
 * 2026-11-19, on the top-right corner: "find another place for this"). It
 * was the top bar's since 2026-10-18, when the account card's "Light mode"
 * row moved out to be one press rather than two. Visitors get it too. It
 * names the mode it switches to; Settings › Profile still has "follow the
 * device".
 */
export function AppearanceButton() {
  const scheme = useScheme();
  const colors = useColors();
  const next = scheme === "dark" ? "light" : "dark";
  const label = next === "light" ? "Switch to light mode" : "Switch to dark mode";
  const tip = Platform.OS === "web" ? ({ title: label } as object) : null;
  return (
    <Pressable
      onPress={() => void setAppearance(next)}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID="frame-appearance"
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
        styles.button,
        hovered && { backgroundColor: colors.chrome },
      ]}
      {...tip}
    >
      <Icon name="sun" size={16} color={colors.chromeMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /** The save cloud's 28pt square, so the two sit on one line. */
  button: { width: 28, height: 28, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
});
