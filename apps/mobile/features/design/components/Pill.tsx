import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { colors, radii } from "../tokens";
import { Text } from "./Text";

export type PillTone = "ok" | "warn" | "neutral";

/** `.pill` — `ok`, `warn`, and `neutral` exactly as the mockup defines them. */
export function Pill({
  tone = "neutral",
  children,
  leading,
  style,
}: {
  tone?: PillTone;
  children: ReactNode;
  /** Optional leading element, e.g. a `<Dot />`. */
  leading?: ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.base, styles[tone], style]}>
      {leading}
      <Text variant="pill" style={styles[`${tone}Text` as const]}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
  neutral: { backgroundColor: colors.surface3, borderColor: colors.line },
  okText: { color: colors.okText },
  warnText: { color: colors.warnText },
  neutralText: { color: colors.text2 },
});
