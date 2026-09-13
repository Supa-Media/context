import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { radii } from "../tokens";
import { useThemedStyles, type Colors } from "../theme";
import { Text } from "./Text";

/**
 * The pill's tones, which are `Dot`'s minus the one a pill has no use for.
 *
 * `crit` is here because a refusal drawn in the neutral tone is a refusal that
 * reads as a category: the Plugins list puts "Won't run here" beside "Works
 * through your files", and those are different answers that must not share a
 * chip. `Dot` has carried `crit` since it was written; this is the same
 * vocabulary, not a new one.
 */
export type PillTone = "ok" | "warn" | "crit" | "neutral";

/** `.pill` — `ok`, `warn`, and `neutral` exactly as the mockup defines them. */
export function Pill({
  tone = "neutral",
  children,
  leading,
  dashed = false,
  style,
}: {
  tone?: PillTone;
  children: ReactNode;
  /** Optional leading element, e.g. a `<Dot />`. */
  leading?: ReactNode;
  /**
   * Draw the border dashed rather than solid.
   *
   * For the one state that is neither good news nor bad: something that was
   * **not measured**. A solid chip — in any tone — says a check ran and
   * returned this; a dashed one says the check could not answer, which is a
   * different claim and the one most easily mistaken for a refusal. Shape
   * rather than a fourth colour, so it survives the reader who cannot separate
   * amber from grey.
   */
  dashed?: boolean;
  style?: ViewStyle;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.base, styles[tone], dashed && styles.dashed, style]}>
      {leading}
      <Text variant="pill" style={styles[`${tone}Text` as const]}>
        {children}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: "transparent",
    alignSelf: "flex-start",
  },
  ok: { backgroundColor: colors.okWash, borderColor: colors.okBorder },
  warn: { backgroundColor: colors.warnWash, borderColor: colors.warnBorder },
  crit: { backgroundColor: colors.critWash, borderColor: colors.critBorder },
  neutral: { backgroundColor: colors.surface3, borderColor: colors.line },
  /*
    Transparent rather than `surface3`: a dashed border over a filled chip
    reads as a filled chip with a decorated edge, and the point is that this
    one is not filled in.
  */
  dashed: { borderStyle: "dashed", borderColor: colors.lineStrong, backgroundColor: "transparent" },
  okText: { color: colors.okText },
  critText: { color: colors.critText },
  warnText: { color: colors.warnText },
  neutralText: { color: colors.text2 },
});
