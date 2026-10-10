import { StyleSheet } from "react-native";
import { radii, space } from "../design/tokens";
import type { Colors, Shadows } from "../design/theme";

/** The chaos surfaces' own styles; the foot line borrows the explorer's (`explorer/styles.ts`). */
export const makeChaosStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    /* The panel's body, the same in the foot's popover and in the sheet. */
    body: { paddingHorizontal: space.x3, paddingVertical: space.x3, gap: space.x3 },
    head: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    headText: { flexShrink: 1, minWidth: 0, gap: 2 },
    score: { color: colors.text, fontWeight: "700" },
    word: { color: colors.text, fontWeight: "600" },
    muted: { color: colors.muted },
    section: { gap: 2 },
    sectionHead: { color: colors.muted, paddingHorizontal: space.x2, paddingBottom: 2 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingVertical: 5,
      paddingHorizontal: space.x2,
      borderRadius: radii.sm,
    },
    rowHover: { backgroundColor: colors.surface2 },
    rowText: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 1 },
    rowCount: { color: colors.muted, flexShrink: 0 },
    how: { color: colors.muted, paddingHorizontal: space.x2 },
    rule: { height: 1, backgroundColor: colors.line },

    /* The foot line's figure, nudged so it sits on the text's line. */
    footFigure: { marginVertical: -3 },
    footWord: { color: colors.muted },
    footArrow: { color: colors.muted },

    /* The folder page's chip. */
    chip: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 6,
      paddingVertical: 2,
      paddingLeft: 4,
      paddingRight: space.x2,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.line,
    },
    chipHover: { borderColor: colors.lineStrong, backgroundColor: colors.surface2 },
    chipText: { color: colors.text2 },

    /* The phone Home's line, at the foot of the page. */
    homeLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: 44,
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
      borderRadius: radii.lg,
      backgroundColor: colors.pageSurface,
    },
    pressed: { opacity: 0.6 },

    /* The sheet: `RecentSheet`'s, so a phone has one kind of sheet. */
    scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
    scrimWide: { justifyContent: "center", alignItems: "center" },
    sheet: {
      paddingTop: 8,
      borderTopLeftRadius: radii.floating,
      borderTopRightRadius: radii.floating,
      borderTopWidth: 1,
      borderTopColor: colors.lineStrong,
      backgroundColor: colors.surface,
      maxHeight: "80%",
      boxShadow: shadows.rising,
    },
    sheetWide: {
      width: 380,
      maxHeight: "80%",
      borderRadius: radii.panel,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface3,
      overflow: "hidden",
      boxShadow: shadows.floating,
    },
    grabber: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.lineStrong,
    },
    scroll: { flexGrow: 0, flexShrink: 1 },
  });
