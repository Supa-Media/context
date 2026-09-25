import { createContext, useContext } from "react";
import { StyleSheet } from "react-native";
import { fonts, pointerType, radii, space, touchType, type TypeScale } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * The guide's one stylesheet, at two densities.
 *
 * The same roles as the rest of the console (`typography.ts`): a phone reads
 * its prose at 16–17 and its headings smaller, a pointer at 15 and 30. Built
 * once per density rather than per render, which is what `useThemedStyles`
 * caches on.
 */
const build = (colors: Colors, t: TypeScale) =>
  StyleSheet.create({
    h1: {
      fontFamily: fonts.display,
      fontSize: t.title,
      lineHeight: Math.round(t.title * 1.2),
      letterSpacing: -0.4,
      fontWeight: "600",
      color: colors.text,
      marginTop: space.x2,
      marginBottom: space.x3,
    },
    p: { fontSize: t.lede, lineHeight: Math.round(t.lede * 1.6), color: colors.text2, marginBottom: space.x4 },
    b: { color: colors.text, fontWeight: "600" },
    sep: { color: colors.muted },
    small: { fontSize: t.meta, lineHeight: Math.round(t.meta * 1.55), color: colors.muted },
    link: { color: colors.accent, fontWeight: "600" },
    mono: { fontFamily: fonts.mono },

    field: { marginBottom: space.x3 },
    fieldLabel: { fontSize: t.meta, color: colors.muted, marginBottom: space.x1 },
    copy: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingVertical: 6,
      paddingLeft: space.x3,
      paddingRight: 6,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.well,
    },
    copyValue: { flex: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: t.meta, color: colors.text },
    chip: {
      paddingVertical: 5,
      paddingHorizontal: space.x3,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface3,
    },
    chipDone: { borderColor: colors.okBorder, backgroundColor: colors.okWash },
    chipLabel: { fontSize: t.meta, fontWeight: "600", color: colors.text },
    chipLabelDone: { color: colors.okText },

    prompt: {
      padding: space.x4,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.well,
    },
    promptText: { fontSize: t.ui, lineHeight: Math.round((t.ui) * 1.65), color: colors.text },
    promptFoot: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.x3,
      marginTop: space.x3,
    },

    checks: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      overflow: "hidden",
    },
    ck: { flexDirection: "row", gap: space.x3, alignItems: "flex-start", paddingVertical: 13, paddingHorizontal: space.x4 },
    ckRule: { borderTopWidth: 1, borderTopColor: colors.line },
    dot: {
      width: 20,
      height: 20,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 1,
    },
    dotOk: { backgroundColor: colors.okWash, borderWidth: 1, borderColor: colors.okBorder },
    dotWait: { borderWidth: 1.5, borderColor: colors.accent },
    dotWaitInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent, opacity: 0.6 },
    dotTodo: { borderWidth: 1.5, borderColor: colors.lineStrong },
    dotWarn: { backgroundColor: colors.warnWash, borderWidth: 1, borderColor: colors.warnBorder },
    dotBad: { backgroundColor: colors.critWash, borderWidth: 1, borderColor: colors.critBorder },
    dotGlyph: { fontSize: t.label, fontWeight: "700" },
    glyphOk: { color: colors.okText },
    glyphWarn: { color: colors.warnText },
    glyphBad: { color: colors.critText },
    ckText: { flex: 1, minWidth: 0 },
    ckTitle: { fontSize: t.ui, fontWeight: "500", color: colors.text },
    ckSub: { fontSize: t.meta, color: colors.text2, marginTop: 1 },

    written: { borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, overflow: "hidden" },
    wr: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.x3,
      paddingVertical: 11,
      paddingHorizontal: 14,
    },
    wrTitle: { fontSize: t.ui, color: colors.text, flexShrink: 1 },
    wrPath: { fontFamily: fonts.mono, fontSize: t.meta, color: colors.muted, flexShrink: 1, textAlign: "right" },

    opt: { flexDirection: "row", gap: space.x3, alignItems: "flex-start", paddingVertical: 11 },
    box: {
      width: 18,
      height: 18,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: colors.lineStrong,
      marginTop: 2,
      alignItems: "center",
      justifyContent: "center",
    },
    boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    boxMark: { fontSize: t.label, fontWeight: "700", color: colors.ink },
    optTitle: { fontSize: t.ui, fontWeight: "500", color: colors.text },
    optSub: { fontSize: t.meta, color: colors.muted },

    tipsHead: { fontSize: t.meta, fontWeight: "600", color: colors.muted, marginBottom: 6, marginTop: space.x5 },
    tip: { flexDirection: "row", gap: space.x2, marginBottom: space.x1 },
    tipText: { flex: 1, fontSize: t.ui, lineHeight: Math.round((t.ui) * 1.7), color: colors.text2 },

    toggle: { marginTop: space.x3, alignSelf: "flex-start" },
    toggleLabel: { fontSize: t.ui, fontWeight: "600", color: colors.accent },
    gap: { height: space.x4 },
  });

const deskStyles = (colors: Colors) => build(colors, pointerType);
const phoneStyles = (colors: Colors) => build(colors, touchType);

/** Whether the guide is drawn for a thumb. Provided once, by the frame. */
export const GuidePhone = createContext(false);

export function useGuideStyles() {
  const phone = useContext(GuidePhone);
  const desk = useThemedStyles(deskStyles);
  const touch = useThemedStyles(phoneStyles);
  return phone ? touch : desk;
}
