/**
 * A project page's List or Board with the side panel at its right — Notion's
 * side peek (the owner, 2026-09-28).
 *
 * Always the same two views, open or not, so opening the panel never
 * redraws the list under it (a folded band stays as it was). Open, the
 * page's contents widen past the note's measure the way a Board does
 * (`peekLayout`): **beside** the list where both fit, into the room at the
 * right first so the list stays where it was under the title; **over** the
 * list where they do not, the list keeping its width and the panel lying
 * over its right side with a shadow, rather than squeezing both or not
 * opening at all.
 *
 * The panel is about half the page and, on the web, stays in view while the
 * list scrolls under it (`position: sticky`), scrolling its own contents.
 */

import type { ReactNode } from "react";
import { Platform, ScrollView, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import { noteColumnWidth } from "../../../../app/frame";
import { layout as frame, radii, space, type Shadows } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import { PANEL_GAP, peekLayout } from "./panelModel";

/** What the chrome above the page takes from the window's height: the top bar and the status line. */
const CHROME = frame.topBarHeight + frame.statusBarHeight;

export function PanelBeside({
  panel,
  pageWidth,
  wide,
  style,
  children,
}: {
  /** The panel, drawn at the width it is given; null while it is closed. */
  panel: ((width: number) => ReactNode) | null;
  /** The page's own width; 0 before it is measured, and the window's stands in. */
  pageWidth: number;
  /** A Board, which takes the whole page beside the panel rather than keeping the note's measure. */
  wide: boolean;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const screen = useWindowDimensions();
  const peek = panel === null ? null : peekLayout(pageWidth > 0 ? pageWidth : screen.width, noteColumnWidth, wide);
  if (panel === null || peek === null) {
    return (
      <View style={style}>
        <View>{children}</View>
      </View>
    );
  }
  const over = peek.mode === "over";
  return (
    <View style={[style, styles.row, { width: peek.width, marginLeft: peek.marginLeft }]}>
      <View style={over ? { width: peek.main ?? undefined, flexShrink: 0 } : styles.main}>{children}</View>
      <View
        style={[
          styles.peek,
          Platform.OS === "web" && styles.sticky,
          over && styles.over,
          { width: peek.panel, maxHeight: Math.max(space.x6 * 10, screen.height - CHROME - 2 * space.x4) },
          // Back over the list by the overlap and the gap the row puts between them.
          over && { marginLeft: -(peek.overlap + PANEL_GAP) },
        ]}
        {...peekData(peek.mode)}
        testID="task-panel-peek"
      >
        <ScrollView contentContainerStyle={styles.content}>{panel(peek.panel - 2 * space.x6)}</ScrollView>
      </View>
    </View>
  );
}

/**
 * `data-mode="beside" | "over"`, which react-native-web draws as an
 * attribute and React Native drops; widened here as `Icon` widens its own.
 */
function peekData(mode: "beside" | "over"): Record<string, unknown> {
  return { dataSet: { mode } };
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "flex-start", gap: PANEL_GAP },
    main: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    peek: {
      flexShrink: 0,
      alignSelf: "flex-start",
      overflow: "hidden",
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    // Stays in view while the list scrolls under it.
    sticky: { position: "sticky", top: space.x4 } as never,
    // Lying over the list: lifted off it, and drawn above it.
    over: { zIndex: 2, boxShadow: shadows.floating } as never,
    content: { paddingVertical: space.x6, paddingHorizontal: space.x6 },
  });
