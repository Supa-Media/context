import { Link, useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { ScreenScroll } from "../../../features/app/Screen";
import { Text } from "../../../features/design/components/Text";
import { fonts, leading, layout, radii, space, tracking } from "../../../features/design/tokens";
import { pointerType as t } from "../../../features/design/tokens";
import { useThemedStyles, type Colors } from "../../../features/design/theme";
import { previewFor } from "../../../features/onboarding/redesign/registry";

// one redesigned onboarding step, rendered with mock props — reachability's
// exemption list carries the same explanation from the routing side.
//
// Same chrome the real onboarding uses (wordmark, title, card), so a reviewer
// sees the screen in its intended context.
export default function PreviewStep() {
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{ step?: string | string[] }>();
  const key = Array.isArray(params.step) ? params.step[0] : params.step;
  const entry = previewFor(key);

  if (entry === undefined) {
    return (
      <ScreenScroll style={styles.ground} contentContainerStyle={styles.scroll}>
        <View style={styles.wrap}>
          <Text variant="mark" style={styles.mark}>
            Context<Text variant="mark" style={styles.markSuffix}>.lc</Text>
          </Text>
          <Text style={styles.title}>Not a known preview</Text>
          <Text variant="rowSub" style={styles.body}>
            No preview matches "{key ?? ""}".
          </Text>
          <Link href="/preview/onboarding" style={styles.link}>
            <Text style={styles.linkText}>Back to previews →</Text>
          </Link>
        </View>
      </ScreenScroll>
    );
  }

  const { Component, props, title } = entry;
  return (
    <ScreenScroll style={styles.ground} contentContainerStyle={styles.scroll}>
      <View style={styles.wrap}>
        <View style={styles.head}>
          <Link href="/preview/onboarding" style={styles.link}>
            <Text style={styles.linkText}>← All previews</Text>
          </Link>
          <Text variant="foot" style={styles.badge}>
            PREVIEW · mock props
          </Text>
        </View>
        <Text variant="mark" style={styles.mark}>
          Context<Text variant="mark" style={styles.markSuffix}>.lc</Text>
        </Text>
        <Text style={styles.title}>{title}</Text>
        <View style={styles.card}>
          <Component {...props} />
        </View>
      </View>
    </ScreenScroll>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    scroll: { minHeight: "100%" },
    wrap: {
      width: "100%",
      maxWidth: 640,
      marginHorizontal: "auto",
      paddingHorizontal: layout.gutter,
      paddingTop: space.x5,
      paddingBottom: space.x8,
    },
    head: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: space.x5,
    },
    mark: { marginBottom: space.x4 },
    markSuffix: { color: colors.muted },
    title: {
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(26, 1.15),
      fontWeight: "600",
      color: colors.text,
      letterSpacing: tracking(26, -0.02),
      marginBottom: space.x5,
    },
    body: { color: colors.text2, marginBottom: space.x4 },
    card: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: space.x5,
      paddingHorizontal: space.x5,
    },
    link: { textDecorationLine: "none" },
    linkText: { color: colors.accent, fontSize: t.meta, fontFamily: fonts.body, fontWeight: "600" },
    badge: {
      color: colors.warn,
      letterSpacing: tracking(11.5, 0.08),
      fontWeight: "700",
    },
  });
