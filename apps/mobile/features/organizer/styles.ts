import { StyleSheet } from "react-native";
import { radii, space } from "../design/tokens";
import type { Colors, Shadows } from "../design/theme";

/**
 * Auto-organize's own styles. Every value is an existing token, and every
 * shape is borrowed from a surface the app already draws: the Premium cards'
 * divided sections, the explorer's foot popover rows, RecentSheet's frame.
 */
export const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { marginTop: 12 },
    // Above the plan card, which carries no top margin of its own.
    above: { marginTop: 12, marginBottom: 12 },
    head: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
    headText: { flex: 1, minWidth: 0 },
    mark: { paddingTop: 2 },
    blurb: { marginTop: 4 },
    muted: { color: colors.chromeMuted },
    reading: { flexDirection: "row", alignItems: "center", gap: 8 },
    readingBelow: { marginTop: 10 },
    actions: { marginTop: 14, gap: 8, alignItems: "center" },
    preview: {
      marginTop: 12,
      marginLeft: 28,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    previewRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: 12,
      paddingVertical: 7,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    previewTitle: { color: colors.text, flexShrink: 1, minWidth: 0 },
    previewWhy: { color: colors.chromeMuted, flexShrink: 2, minWidth: 0, marginLeft: "auto" },
    previewStack: { flexDirection: "column", alignItems: "stretch", gap: 2 },
    previewWhyStack: { marginLeft: 0 },
    hint: { marginTop: 12 },
    indent: { marginLeft: 28 },
    included: {
      marginTop: 14,
      paddingTop: 14,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    includedHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    section: {
      marginTop: 14,
      paddingTop: 14,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    kind: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingVertical: 8,
    },
    kindLabel: { color: colors.text2, flexShrink: 1 },
    reviewList: { paddingVertical: space.x1 },
    divider: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: space.x3 + space.x1,
      paddingTop: space.x3,
      paddingBottom: space.x1,
    },
    dayLabel: { color: colors.chromeMuted },
    rule: { flexGrow: 1, height: 1, backgroundColor: colors.line },
    reviewRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      paddingVertical: space.x1 + 2,
      paddingLeft: space.x3,
      paddingRight: space.x2,
      marginHorizontal: space.x1,
      minHeight: 44,
      borderRadius: radii.sm,
    },
    reviewRowHover: { backgroundColor: colors.chipFill },
    reviewRowTouch: { paddingVertical: space.x2, gap: space.x3, paddingLeft: space.x1, paddingRight: 0 },
    reviewBody: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    reviewTitle: { color: colors.text2 },
    reviewMeta: { color: colors.chromeMuted },
    reviewNote: { paddingHorizontal: space.x3 + space.x1, paddingVertical: space.x3 },
    reviewLoading: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    act: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
    actTouch: { width: 40, height: 40 },
    actHover: { backgroundColor: colors.chipFill },
    acts: { flexDirection: "row", gap: space.x1 },
    actsTouch: { gap: space.x3 },
    // Mounted and focusable, unlit and out of the flow until the row is under the pointer.
    actsResting: { position: "absolute", right: space.x2, opacity: 0 },
    actsShown: { opacity: 1 },
  });

export const makeSheetStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    scrim: { flexGrow: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
    sheet: {
      paddingTop: 8,
      paddingHorizontal: 12,
      borderTopLeftRadius: radii.floating,
      borderTopRightRadius: radii.floating,
      borderTopWidth: 1,
      borderTopColor: colors.lineStrong,
      backgroundColor: colors.surface,
      maxHeight: "78%",
      boxShadow: shadows.rising,
    },
    grabber: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.lineStrong,
      marginBottom: 10,
    },
    sheetHead: { paddingHorizontal: 4, marginBottom: 4 },
    list: { flexGrow: 0 },
  });
