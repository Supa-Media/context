import { StyleSheet, View, type ViewStyle } from "react-native";
import { colors } from "../tokens";

export type DotTone = "ok" | "warn" | "crit" | "neutral";

const tones: Record<DotTone, string> = {
  ok: colors.ok,
  warn: colors.warn,
  crit: colors.crit,
  neutral: colors.muted,
};

/** `.dot` — the 7px status pip used in the rail, pills, and client rows. */
export function Dot({
  tone = "ok",
  size = 7,
  style,
}: {
  tone?: DotTone;
  size?: number;
  style?: ViewStyle;
}) {
  return (
    <View
      aria-hidden
      style={[
        styles.dot,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: tones[tone] },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    flexGrow: 0,
    flexShrink: 0,
  },
});
