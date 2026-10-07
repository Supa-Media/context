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
    sort: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 14,
      paddingTop: 14,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    sortText: { flex: 1, minWidth: 160, color: colors.chromeMuted },
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
  });
