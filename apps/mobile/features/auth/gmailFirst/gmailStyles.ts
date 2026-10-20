import { StyleSheet } from "react-native";
import { fonts, layout, leading, pointerType as t, space, tracking } from "../../design/tokens";
import type { Colors } from "../../design/theme";

/** The one-time gate's look (`EmailCheckScreen`), shared by the Gmail-first pages. */
export const makeGmailStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    form: {
      width: "100%",
      maxWidth: 440,
      alignSelf: "center",
      paddingHorizontal: layout.gutter,
      paddingVertical: 48,
    },
    mark: { marginBottom: 32 },
    markSuffix: { color: colors.accent },
    pitch: {
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(26, 1.25),
      letterSpacing: tracking(26, -0.015),
      fontWeight: "600",
      color: colors.text,
    },
    body: { marginTop: space.x3, fontSize: t.body, color: colors.text2, lineHeight: leading(t.body, 1.5) },
    strong: { fontWeight: "600", color: colors.text },
    primaryRow: { marginTop: space.x6, alignSelf: "stretch", gap: space.x3 },
    foot: { marginTop: space.x3, color: colors.muted, lineHeight: leading(12, 1.5) },
    link: {
      marginTop: space.x4,
      alignSelf: "flex-start",
      minHeight: 44,
      paddingVertical: 12,
      color: colors.accent,
      fontWeight: "600",
      textDecorationLine: "underline",
    },
    error: { marginTop: space.x3 },
    tick: {
      width: 44,
      height: 44,
      borderRadius: 22,
      marginBottom: space.x5,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.well,
    },
    waiting: { marginTop: space.x4, flexDirection: "row", alignItems: "center", gap: space.x2 },
  });
