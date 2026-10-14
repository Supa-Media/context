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

    /* A folder page's line, beside its title. */
    folderLine: { flexDirection: "row", alignItems: "center", flexShrink: 2, minWidth: 0 },
    folderLineOwnLine: { marginTop: space.x1 },
    folderLinePress: { flexShrink: 1, minWidth: 0 },
    /* The folder's advice, when its line is pressed. */
    adviceLead: { paddingHorizontal: space.x2 },
    tip: { flexDirection: "row", gap: space.x2, paddingHorizontal: space.x2, paddingVertical: 3 },
    tipText: { flexShrink: 1, color: colors.text },
    link: { color: colors.accent, fontWeight: "600" },

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
