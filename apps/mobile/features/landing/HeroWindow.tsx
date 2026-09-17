import { StyleSheet, View } from "react-native";

import { Text } from "../design/components/Text";
import { useThemedStyles, type Colors } from "../design/theme";
import { fonts, leading, pointerType as t, radii, space, tracking } from "../design/tokens";

/**
 * THE PRODUCT, BESIDE THE SENTENCE ABOUT IT.
 *
 * `Landing-Hero.dc.html` is two columns: the pitch on the left and an
 * application window on the right, bleeding off the page's right edge. The page
 * had the left column and empty space, so the hero asserted things about a
 * product a visitor could not see — the live console was four screens down,
 * past a transcript and a file tree.
 *
 * ## Why this is a still and not the live console
 *
 * The page already runs the real `ConsoleShell` on demo data further down, and
 * that remains the honest article: it navigates, it selects, it switches
 * contexts. A hero is not the place for it. A window somebody can click is a
 * window competing with the two buttons beside it, and the canvas draws a
 * still for that reason.
 *
 * What a still costs is drift — this can go stale while the console moves. Two
 * things bound it: every colour here is a token, so a palette change reaches it
 * the way it reaches everything else, and the **live** console is still on the
 * page for anybody who scrolls. This is a picture of the product; the product
 * is right there underneath it.
 *
 * ## Why it is dark on a light page
 *
 * It is a depiction of the application, not a panel of the website — see
 * `tokens.ts`'s `appSurface` and the decision it cites. On paper the canvas
 * draws it graphite too, and re-tinting it produces a cream rectangle with
 * cream chrome that reads as a section rather than a window.
 *
 * ## Geometry
 *
 * The canvas's, at its own numbers: a 40pt title bar, a 210pt tree, a 24pt
 * status bar, and `borderRadius: 16` on the **top-left corner only**, because
 * the window runs off the right-hand edge of the page. That one asymmetric
 * radius is most of the effect: a fully rounded card floats in the layout, and
 * a window with two square right corners is continuing past the frame.
 *
 * **The type is not the canvas's numbers, and that was `typeScale.test.ts`'s
 * call rather than mine.** It draws this window at 10 / 14 / 26 — a shrunken
 * copy of the application's own 11 / 16 / 30, which is what a designer does to
 * fit a picture into a column. Written that way, three literals went into a
 * stylesheet, and the whole reason that test exists is that sixteen sizes once
 * accumulated exactly like this: each one individually defensible, none of them
 * chosen. So the window is drawn from the scale — `label`, `ui`, `h2` — which
 * lands within three points of every number the canvas drew, and keeps this
 * file from being the place a seventeenth size gets in.
 */
export function HeroWindow() {
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={styles.window} testID="hero-window" aria-hidden>
      <View style={styles.titleBar}>
        <View style={styles.lights}>
          <View style={[styles.light, styles.lightRed]} />
          <View style={[styles.light, styles.lightAmber]} />
          <View style={[styles.light, styles.lightGreen]} />
        </View>
        <View style={styles.switcher}>
          <View style={styles.mark}>
            <Text style={styles.markLetter}>S</Text>
          </View>
          <Text style={styles.switcherLabel}>@seyi</Text>
        </View>
        <View style={styles.tab}>
          <Text style={styles.tabLabel}>2-kings-5</Text>
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.tree}>
          <Row label="0-inbox" meta="3" metaTone="accent" />
          <Row label="1-projects" meta="team" metaTone="team" />
          <Row label="2-areas" lit />
          <Row label="spirit" depth={1} lit />
          <Row label="bible-study" depth={2} lit />
          <Row label="kings" depth={3} lit />
          <Row label="2-kings-4" depth={4} />
          <Row label="2-kings-5" depth={4} lit selected />
          <Row label="luke" depth={3} />
          <Row label="memory-verses" depth={3} />
          <Row label="3-resources" />
        </View>

        <View style={styles.note}>
          <Text style={styles.crumb}>spirit / bible-study / kings · private</Text>
          <Text style={styles.noteTitle}>2-kings-5</Text>
          <Text style={styles.noteHeading}>Summary</Text>
          <Text style={styles.noteBody}>
            Naaman was a warrior in Aram, widely respected, but he had leprosy. An
            Israelite woman who served his wife mentioned that there was a prophet in
            Israel who could heal him.
          </Text>
        </View>
      </View>

      <View style={styles.statusBar}>
        <Text style={styles.statusPath}>2-areas/spirit/bible-study/kings/2-kings-5.md</Text>
        <View style={styles.statusSpacer} />
        <Text style={styles.statusPath}>saved</Text>
        <View style={styles.statusPip} />
      </View>
    </View>
  );
}

/**
 * One tree row.
 *
 * `depth` steps by 10 rather than the console's 12: this window is drawn at
 * roughly four fifths of the application's own scale — 12pt rows against 13,
 * 26pt heights against 28 — and an indent that did not shrink with them would
 * push a four-deep file past the middle of a 210pt column.
 */
function Row({
  label,
  depth = 0,
  meta,
  metaTone,
  lit = false,
  selected = false,
}: {
  label: string;
  depth?: number;
  meta?: string;
  metaTone?: "accent" | "team";
  lit?: boolean;
  selected?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.row, selected && styles.rowSelected, { paddingLeft: 9 + depth * 10 }]}>
      {selected ? <View style={styles.rowBar} /> : null}
      <Text style={[styles.rowLabel, lit && styles.rowLabelLit]} numberOfLines={1}>
        {label}
      </Text>
      {meta === undefined ? null : (
        <Text style={[styles.rowMeta, metaTone === "team" ? styles.metaTeam : styles.metaAccent]}>
          {meta}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    /*
      `borderTopLeftRadius` alone — see the header. The window runs off the
      right-hand edge of the page, so its right corners are square because they
      are not there.
    */
    window: {
      height: 560,
      borderTopLeftRadius: 16,
      overflow: "hidden",
      backgroundColor: colors.appSurface,
    },

    titleBar: {
      height: 40,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 14,
      gap: 12,
      backgroundColor: colors.appChrome,
    },
    lights: { flexDirection: "row", gap: 7 },
    light: { width: 10, height: 10, borderRadius: radii.pill },
    /*
      A window's own controls, which belong to the operating system rather than
      to this palette — the same three colours macOS draws, in a picture of a
      macOS window. They are `app*` tokens for the reason every colour here is:
      a component may not name one.
    */
    lightRed: { backgroundColor: colors.appLightRed },
    lightAmber: { backgroundColor: colors.appLightAmber },
    lightGreen: { backgroundColor: colors.appLightGreen },

    switcher: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      height: 26,
      paddingLeft: 6,
      paddingRight: 9,
      borderRadius: radii.sm,
      backgroundColor: colors.appChip,
    },
    mark: {
      width: 16,
      height: 16,
      borderRadius: 5,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.appAccent,
    },
    markLetter: {
      fontFamily: fonts.body,
      fontSize: t.label,
      lineHeight: leading(t.label, 1.2),
      fontWeight: "600",
      color: colors.appSurface,
    },
    switcherLabel: {
      fontFamily: fonts.body,
      fontSize: t.meta,
      lineHeight: leading(t.meta, 1.4),
      fontWeight: "500",
      color: colors.appInk,
    },
    /** The active tab, filled in the page's surface — `TabStrip`'s own rule. */
    tab: {
      height: 30,
      alignSelf: "flex-end",
      justifyContent: "center",
      paddingHorizontal: 11,
      borderTopLeftRadius: 7,
      borderTopRightRadius: 7,
      backgroundColor: colors.appSurface,
    },
    tabLabel: {
      fontFamily: fonts.body,
      fontSize: t.meta,
      lineHeight: leading(t.meta, 1.4),
      fontWeight: "500",
      color: colors.appInk,
    },

    body: { flex: 1, flexDirection: "row", minHeight: 0 },
    tree: {
      width: 210,
      paddingVertical: 10,
      paddingHorizontal: 8,
      gap: 1,
      backgroundColor: colors.appChrome,
    },
    row: { height: 26, flexDirection: "row", alignItems: "center", borderRadius: radii.sm },
    rowSelected: { backgroundColor: colors.appRowSelected },
    rowBar: {
      position: "absolute",
      left: 7,
      width: 2,
      height: 13,
      borderRadius: radii.pill,
      backgroundColor: colors.appAccent,
    },
    rowLabel: {
      flexShrink: 1,
      fontFamily: fonts.body,
      fontSize: t.meta,
      lineHeight: leading(t.meta, 1.4),
      color: colors.appMuted,
    },
    rowLabelLit: { color: colors.appInk, fontWeight: "500" },
    rowMeta: {
      marginLeft: "auto",
      paddingRight: 9,
      fontFamily: fonts.body,
      fontSize: t.label,
      lineHeight: leading(t.label, 1.4),
      fontWeight: "500",
    },
    metaAccent: { color: colors.appAccent },
    metaTeam: { color: colors.appTeam },

    note: { flex: 1, minWidth: 0, paddingTop: 40, paddingHorizontal: 48 },
    crumb: {
      fontFamily: fonts.mono,
      fontSize: t.label,
      lineHeight: leading(t.label, 1.4),
      color: colors.appDim,
      marginBottom: 9,
    },
    noteTitle: {
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(t.h2, 1.2),
      fontWeight: "600",
      letterSpacing: tracking(t.h2, -0.02),
      color: colors.appInk,
      marginBottom: 22,
    },
    noteHeading: {
      fontFamily: fonts.display,
      fontSize: t.h3,
      lineHeight: leading(t.h3, 1.3),
      fontWeight: "600",
      letterSpacing: tracking(t.h3, -0.015),
      color: colors.appInk,
      marginBottom: space.x2 + 2,
    },
    noteBody: {
      fontFamily: fonts.body,
      fontSize: t.ui,
      lineHeight: leading(t.ui, 1.75),
      color: colors.appBody,
    },

    statusBar: {
      height: 24,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      backgroundColor: colors.appChrome,
    },
    statusPath: {
      fontFamily: fonts.mono,
      fontSize: t.label,
      lineHeight: leading(t.label, 1.4),
      color: colors.appDim,
    },
    statusSpacer: { flex: 1 },
    statusPip: {
      width: 5,
      height: 5,
      marginLeft: 10,
      borderRadius: radii.pill,
      backgroundColor: colors.appOk,
    },
  });
