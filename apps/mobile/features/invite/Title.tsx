import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { Text } from "../design/components/Text";
import { fonts, leading, tracking } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";

/**
 * The big heading on the link pages (invites, texts, vault). Apart from
 * `InviteScreen` so a page drawn inside the console, such as a vault link
 * opened in Settings, does not load the router with it.
 */
export function Title({ size, children }: { size: number; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text
      role="heading"
      aria-level={1}
      style={[styles.title, { fontSize: size, lineHeight: leading(size, 1.08), letterSpacing: tracking(size, -0.03) }]}
    >
      {children}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    title: { fontFamily: fonts.display, fontWeight: "600", color: colors.text },
  });
