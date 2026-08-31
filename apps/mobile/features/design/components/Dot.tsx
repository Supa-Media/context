import { StyleSheet, View, type ViewStyle } from "react-native";
import { useColors, type Colors } from "../theme";

export type DotTone = "ok" | "warn" | "crit" | "neutral";

/**
 * Tone → token, as a function of the palette.
 *
 * A frozen `Record` here would hold the colours of whichever world was
 * imported first and keep handing them out after the appearance changed —
 * the same trap as a module-scope `StyleSheet.create`, in four lines instead
 * of forty.
 */
const tonesFor = (colors: Colors): Record<DotTone, string> => ({
  ok: colors.ok,
  warn: colors.warn,
  crit: colors.crit,
  neutral: colors.muted,
});

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
  const tones = tonesFor(useColors());
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
