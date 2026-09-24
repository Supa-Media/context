import { Link } from "expo-router";
import { StyleSheet, View } from "react-native";
import { ScreenScroll } from "../../../features/app/Screen";
import { Text } from "../../../features/design/components/Text";
import { fonts, leading, layout, radii, space, tracking } from "../../../features/design/tokens";
import { pointerType as t } from "../../../features/design/tokens";
import { useThemedStyles, type Colors } from "../../../features/design/theme";
import { PREVIEWS } from "../../../features/onboarding/redesign/registry";

/**
 * `/preview/onboarding` — the design review index for the redesigned
 * onboarding screens.
 *
 * A dev-only surface. Every new step lives here first, with mock props, so
 * reviewers can look at each screen without an account and CI can smoke-test
 * that every one renders. Outside the `(app)` group on purpose: the point is
 * to view the screens without an auth gate. Reachability's exemption list
 * carries the same explanation from the routing side.
 */
export default function PreviewIndex() {
  const styles = useThemedStyles(makeStyles);
  return (
    <ScreenScroll style={styles.ground} contentContainerStyle={styles.scroll}>
      <View style={styles.wrap}>
        <Text variant="mark" style={styles.mark}>
          Context
          <Text variant="mark" style={styles.markSuffix}>
            .lc · onboarding preview
          </Text>
        </Text>
        <Text style={styles.title}>Redesigned onboarding screens</Text>
        <Text variant="rowSub" style={styles.lede}>
          Every new screen from the design canvas, wired to mock props so you
          can see the layout without signing in. The state machine that
          decides which of these you actually see lives elsewhere — this is
          the visual half.
        </Text>

        <View style={styles.list}>
          {PREVIEWS.map((preview) => (
            <Link key={preview.key} href={`/preview/onboarding/${preview.key}`} style={styles.linkWrap}>
              <View style={styles.row}>
                <Text style={styles.rowKey}>{preview.title}</Text>
                <Text style={styles.rowArrow}>→</Text>
              </View>
            </Link>
          ))}
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
      paddingVertical: space.x8,
    },
    mark: { marginBottom: space.x5 },
    markSuffix: { color: colors.muted },
    title: {
      fontFamily: fonts.display,
      fontSize: t.title,
      lineHeight: leading(28, 1.15),
      fontWeight: "600",
      color: colors.text,
      letterSpacing: tracking(28, -0.02),
      marginBottom: space.x3,
    },
    lede: {
      color: colors.text2,
      lineHeight: leading(12.5, 1.7),
      marginBottom: space.x6,
    },
    list: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.md,
      backgroundColor: colors.surface2,
      overflow: "hidden",
    },
    linkWrap: { textDecorationLine: "none" },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: space.x4,
      paddingHorizontal: space.x5,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    rowKey: {
      fontFamily: fonts.body,
      fontSize: t.ui,
      color: colors.text,
      fontWeight: "500",
    },
    rowArrow: { color: colors.accent, fontSize: t.body, fontFamily: fonts.body },
  });
