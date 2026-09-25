import { useEffect, useState, type ReactNode } from "react";
import { Linking, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import type { WebsiteNavigationItem } from "@context/shared";
import { Text } from "../../design/components/Text";
import { ScreenScroll } from "../../app/Screen";
import { siteType } from "../../design/tokens";
import { UNDERLINE_CURRENT } from "../../share/siteLook";
import { useThemedStyles, type Colors } from "../../design/theme";

/** Below this the menu folds under one "Menu" button. */
export const PHONE = 640;
/** From here the site is laid out for a desktop screen, not a column. */
export const DESKTOP = 1024;

export type SiteSize = "phone" | "tablet" | "desktop";

/** Which of the site's three layouts the window calls for. */
export function useSiteSize(): SiteSize {
  const width = useWindowDimensions().width;
  return width < PHONE ? "phone" : width < DESKTOP ? "tablet" : "desktop";
}

/**
 * The chrome of a published website: the site's name and menu at the top, the
 * page column, and one quiet footer line.
 *
 * On a phone it is one column. Wider, the name and menu span a wide frame,
 * the prose keeps a reading measure aligned under the name, and a short page
 * still fills the window with the footer at its foot.
 *
 * None of the console is here — no card, no stage, no app header. A visitor is
 * reading somebody's site, and it should look like theirs. The menu is what
 * the server resolved from `nav:` frontmatter, in its order; this draws it and
 * decides nothing about which pages exist.
 */
export function SiteFrame({
  name,
  navigation,
  current,
  navigate,
  madeWith,
  children,
}: {
  name: string;
  navigation: readonly WebsiteNavigationItem[];
  current: string | null;
  navigate: (routePath: string) => void;
  /** Where "Made with Context" goes. */
  madeWith: string;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const size = useSiteSize();
  const phone = size === "phone";
  const desktop = size === "desktop";
  const [open, setOpen] = useState(false);
  // A new page (back, forward, a link in the body) closes the menu too.
  useEffect(() => setOpen(false), [current]);
  const go = (routePath: string) => {
    setOpen(false);
    navigate(routePath);
  };
  const links = navigation.map((item) => (
    <Pressable
      key={item.routePath}
      accessibilityRole="link"
      aria-current={item.routePath === current ? "page" : undefined}
      onPress={() => go(item.routePath)}
      style={phone ? styles.sheetRow : undefined}
      testID="site-nav-item"
    >
      <Text
        variant="body"
        style={[
          styles.navItem,
          phone && styles.sheetItem,
          desktop && styles.navItemDesktop,
          item.routePath === current && styles.navCurrent,
        ]}
      >
        {item.title}
      </Text>
    </Pressable>
  ));
  return (
    // The ground sits outside the scroller so the status-bar band a phone
    // holds back is the page's colour, not a gap.
    <View style={styles.page}>
      <ScreenScroll contentContainerStyle={[styles.scroll, !phone && styles.scrollWide, desktop && styles.scrollDesktop]}>
        <View style={[styles.header, !phone && styles.frameWide, desktop && styles.headerDesktop]} role="banner">
          <Pressable accessibilityRole="link" onPress={() => go("/")} testID="site-name">
            <Text variant="body" style={[styles.name, desktop && styles.nameDesktop]}>
              {name}
            </Text>
          </Pressable>
          {navigation.length === 0 ? null : phone ? (
            <Pressable
              accessibilityRole="button"
              aria-expanded={open}
              onPress={() => setOpen(!open)}
              hitSlop={8}
              style={styles.trigger}
              testID="site-menu"
            >
              <Text variant="body" style={styles.navItem}>
                {open ? "Close" : "Menu"}
              </Text>
            </Pressable>
          ) : (
            <View style={[styles.nav, desktop && styles.navDesktop]} role="navigation">
              {links}
            </View>
          )}
        </View>
        {phone && open ? (
          <View style={styles.sheet} role="navigation">
            {links}
          </View>
        ) : null}
        <View
          style={[
            styles.column,
            phone ? styles.columnPhone : styles.frameWide,
            desktop && styles.columnDesktop,
            phone && open && styles.columnUnderSheet,
          ]}
          role="main"
        >
          <View style={[styles.measure, desktop && styles.measureDesktop]}>{children}</View>
        </View>
        <View style={[styles.footer, !phone && styles.footerWide, desktop && styles.footerDesktop]}>
          {phone ? null : (
            <Text variant="body" style={styles.foot}>
              {`© ${name}`}
            </Text>
          )}
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(madeWith).catch(() => undefined)}>
            <Text variant="body" style={styles.foot}>
              Made with Context
            </Text>
          </Pressable>
        </View>
      </ScreenScroll>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.ground },
    scroll: { flexGrow: 1, alignItems: "center", paddingHorizontal: 22 },
    scrollWide: { paddingHorizontal: 40 },
    scrollDesktop: { paddingHorizontal: 56 },
    // Tablet and desktop: header, page and footer share one wide frame.
    frameWide: { maxWidth: 1200 },
    header: {
      width: "100%",
      maxWidth: 640,
      height: 72,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 16,
    },
    headerDesktop: { height: 96 },
    name: {
      fontSize: siteType.name,
      fontWeight: "600",
      color: colors.text,
      lineHeight: 22,
      letterSpacing: -0.2,
    },
    nameDesktop: { fontSize: siteType.nameDesktop, lineHeight: 24, letterSpacing: -0.3 },
    nav: {
      flexDirection: "row",
      gap: 26,
      flexShrink: 1,
      flexWrap: "wrap",
      justifyContent: "flex-end",
    },
    navDesktop: { gap: 32 },
    navItem: { fontSize: siteType.nav, color: colors.muted },
    navItemDesktop: { fontSize: siteType.navDesktop },
    navCurrent: {
      color: colors.text,
      textDecorationLine: "underline",
      textDecorationColor: colors.muted,
      ...UNDERLINE_CURRENT,
    },
    trigger: { paddingVertical: 10, paddingLeft: 16, marginRight: -4 },
    sheet: {
      width: "100%",
      maxWidth: 640,
      paddingTop: 4,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    sheetRow: { minHeight: 44, paddingVertical: 10, justifyContent: "center" },
    sheetItem: { fontSize: siteType.name },
    column: {
      width: "100%",
      maxWidth: 640,
      // Wider than a phone, the page grows to fill the window so a short
      // page's footer rests at its foot rather than floating mid-screen.
      flexGrow: 1,
      paddingTop: 80,
      paddingBottom: 96,
    },
    columnPhone: { flexGrow: 0, paddingTop: 48, paddingBottom: 72 },
    columnDesktop: { paddingTop: 112, paddingBottom: 128 },
    // Prose keeps a reading measure, aligned under the site's name.
    measure: { width: "100%", maxWidth: 640 },
    measureDesktop: { maxWidth: 680 },
    columnUnderSheet: { paddingTop: 32 },
    footer: {
      width: "100%",
      maxWidth: 640,
      flexDirection: "row",
      paddingTop: 16,
      paddingBottom: 32,
    },
    footerWide: { justifyContent: "space-between", alignItems: "baseline", paddingTop: 24, maxWidth: 1200 },
    footerDesktop: { paddingBottom: 40 },
    foot: { fontSize: siteType.foot, lineHeight: 18, color: colors.muted },
  });
