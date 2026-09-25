import { useEffect, useState, type ReactNode } from "react";
import { Linking, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import type { WebsiteNavigationItem } from "@context/shared";
import { Text } from "../../design/components/Text";
import { ScreenScroll } from "../../app/Screen";
import { siteType } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/** Below this the menu folds under one "Menu" button. */
const PHONE = 640;

/**
 * The chrome of a published website: the site's name and menu at the top, the
 * page column, and one quiet footer line.
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
  const phone = useWindowDimensions().width < PHONE;
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
        style={[styles.navItem, phone && styles.sheetItem, item.routePath === current && styles.navCurrent]}
      >
        {item.title}
      </Text>
    </Pressable>
  ));
  return (
    // The ground sits outside the scroller so the status-bar band a phone
    // holds back is the page's colour, not a gap.
    <View style={styles.page}>
      <ScreenScroll contentContainerStyle={styles.scroll}>
        <View style={styles.header} role="banner">
          <Pressable accessibilityRole="link" onPress={() => go("/")} testID="site-name">
            <Text variant="body" style={styles.name}>
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
            <View style={styles.nav} role="navigation">
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
          style={[styles.column, phone && styles.columnPhone, phone && open && styles.columnUnderSheet]}
          role="main"
        >
          {children}
        </View>
        <View style={styles.footer}>
          <Text variant="body" style={styles.foot}>
            {`© ${name}`}
          </Text>
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
    header: {
      width: "100%",
      maxWidth: 640,
      height: 72,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 16,
    },
    name: {
      fontSize: siteType.name,
      fontWeight: "600",
      color: colors.text,
      letterSpacing: -0.2,
    },
    nav: {
      flexDirection: "row",
      gap: 26,
      flexShrink: 1,
      flexWrap: "wrap",
      justifyContent: "flex-end",
    },
    navItem: { fontSize: siteType.nav, color: colors.muted },
    navCurrent: { color: colors.text },
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
      flexGrow: 1,
      paddingTop: 80,
      paddingBottom: 72,
    },
    columnPhone: { paddingTop: 56 },
    columnUnderSheet: { paddingTop: 32 },
    footer: {
      width: "100%",
      maxWidth: 640,
      flexDirection: "row",
      justifyContent: "space-between",
      gap: 16,
      paddingVertical: 24,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    foot: { fontSize: siteType.foot, color: colors.muted },
  });
