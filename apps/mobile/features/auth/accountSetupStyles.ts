import { StyleSheet } from "react-native";
import { fonts, layout, leading, pointerType as t, space, tracking } from "../design/tokens";
import type { Colors } from "../design/theme";

/** The styles of `AccountSetupScreen`, kept apart so the screen reads as its flow. */
export const makeAccountSetupStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { backgroundColor: colors.ground },
    form: {
      width: "100%",
      maxWidth: 400,
      alignSelf: "center",
      paddingHorizontal: layout.gutter,
      paddingVertical: 48,
    },
    pitch: {
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(26, 1.25),
      letterSpacing: tracking(26, -0.015),
      fontWeight: "600",
      color: colors.text,
    },
    body: { marginTop: space.x3, color: colors.text2, lineHeight: leading(12.5, 1.5) },
    strong: { fontWeight: "600", color: colors.text },
    hint: { marginTop: space.x2, color: colors.muted, lineHeight: leading(12.5, 1.5) },
    field: { marginTop: space.x5 },
    codes: { marginTop: space.x3 },
    error: { marginTop: space.x3 },
    primaryRow: { marginTop: space.x4, alignSelf: "stretch" },
    row: { marginTop: space.x4, flexDirection: "row", flexWrap: "wrap", gap: space.x3 },
    signOut: { marginTop: space.x6, color: colors.muted, textDecorationLine: "underline" },
  });
