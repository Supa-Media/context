import { Pressable, StyleSheet, View } from "react-native";
import { CAST_PACES, type CastPaceName } from "@context/shared";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";

const LABELS: Record<CastPaceName, string> = { slow: "Slow", lively: "Lively", fast: "Fast" };

/**
 * How fast the scene plays, drawn like the frame switch beside it. The choice
 * is the scene's `pace:` line, so the homepage plays it at the same speed.
 */
export function StudioPace({ pace, onChange }: { pace: CastPaceName; onChange: (pace: CastPaceName) => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.group} accessibilityRole="radiogroup" aria-label="Pace">
      {CAST_PACES.map((one) => {
        const on = one === pace;
        return (
          <Pressable
            key={one}
            onPress={() => onChange(one)}
            accessibilityRole="radio"
            aria-checked={on}
            style={[styles.button, on ? styles.on : null]}
            testID={`studio-pace-${one}`}
          >
            <Text variant="rowSub" style={on ? styles.textOn : styles.muted}>
              {LABELS[one]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    group: { flexDirection: "row", gap: 2, padding: 3, borderRadius: radii.xl, backgroundColor: colors.chipFill },
    button: { justifyContent: "center", height: 38, paddingHorizontal: space.x3, borderRadius: radii.lg },
    on: { backgroundColor: colors.rowSelected },
    muted: { color: colors.muted },
    textOn: { color: colors.text, fontWeight: "600" },
  });
