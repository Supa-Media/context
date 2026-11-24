/**
 * How a stored value looks in its cell, by the column's type. Colour is never
 * the only signal: a select says its word, a person says the name, a value
 * that does not fit keeps its text and gets a wavy underline and a tooltip.
 */

import { Linking, StyleSheet, View, type TextStyle } from "react-native";
import { cellProblem } from "../../../../../mcp/src/sheets/csv.js";
import { Text } from "../../../design/components/Text";
import { pointerType, radii, space } from "../../../design/tokens";
import { useFieldFont } from "../../../design/fieldFont";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { displayText, type ColumnType } from "./sheetModel";

/** The chip tints a select cell cycles through, by the option's first-seen order. */
export function optionTone(colors: Colors, index: number): { dot: string; wash: string } {
  const tones = [
    { dot: colors.accent, wash: colors.accentDim },
    { dot: colors.ok, wash: colors.okWash },
    { dot: colors.warn, wash: colors.warnWash },
    { dot: colors.crit, wash: colors.critWash },
    { dot: colors.chromeMuted, wash: colors.chipFill },
  ];
  return tones[index % tones.length];
}

export function CellDisplay({
  type,
  text,
  optionIndex,
}: {
  type: ColumnType;
  text: string;
  /** Where a select's value is among the column's options, first seen first. */
  optionIndex: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const problem = cellProblem(type, text);
  // The grid's own size: the interface's on a pointer, the field size on a phone, as the approved design has it.
  const size = useFieldFont(pointerType.ui)?.fontSize ?? pointerType.ui;
  const font = { fontSize: size, lineHeight: Math.round(size * 1.4) };

  if (problem) {
    // A tooltip on the web; the same words as an accessibility hint everywhere.
    const tooltip = { title: problem };
    return (
      <Text variant="body" numberOfLines={1} style={[styles.text, font, styles.misfit]} testID="sheet-misfit" accessibilityHint={problem} {...tooltip}>
        {text}
      </Text>
    );
  }
  if (type === "checkbox") {
    const checked = text.trim() === "true";
    return (
      <View
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        testID="sheet-checkbox"
        style={[styles.box, checked && { backgroundColor: colors.accent, borderColor: colors.accent }]}
      >
        {checked ? <Text variant="meta" style={styles.tick}>✓</Text> : null}
        {/* The tick sits on the accent, so it takes the ground colour, which reads on both palettes. */}
      </View>
    );
  }
  if (text.trim() === "") return <Text variant="meta" style={styles.muted}>—</Text>;
  if (type === "select") {
    const tone = optionTone(colors, optionIndex);
    return (
      <View style={[styles.chip, { backgroundColor: tone.wash }]}>
        <View style={[styles.dot, { backgroundColor: tone.dot }]} />
        <Text variant="body" numberOfLines={1} style={[styles.text, font]}>
          {text}
        </Text>
      </View>
    );
  }
  if (type === "person") {
    // Each person keeps one tint, picked from their name, so the same face reads the same down a column.
    const personTone = optionTone(colors, [...text.trim()].reduce((sum, ch) => sum + ch.charCodeAt(0), 0));
    return (
      <View style={styles.person}>
        <View style={[styles.avatar, { backgroundColor: personTone.wash }]}>
          <Text variant="meta" style={[styles.initial, { color: personTone.dot }]}>
            {text.trim().charAt(0).toUpperCase()}
          </Text>
        </View>
        <Text variant="body" numberOfLines={1} style={[styles.text, font]}>
          {text}
        </Text>
      </View>
    );
  }
  if (type === "link") {
    // The link press is the inner Text's, so it opens the link and the cell beneath does not select.
    return (
      <Text
        variant="body"
        numberOfLines={1}
        style={[styles.link, font]}
        accessibilityRole="link"
        onPress={() => {
          void Linking.openURL(text.trim());
        }}
      >
        {text.trim().replace(/^https?:\/\//i, "")}
      </Text>
    );
  }
  return (
    <Text variant="body" numberOfLines={1} style={[styles.text, font, type === "usd" || type === "number" ? styles.number : null]}>
      {displayText(type, text)}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    text: { color: colors.text, flexShrink: 1 },
    muted: { color: colors.chromeMuted },
    number: { fontVariant: ["tabular-nums"], textAlign: "right" },
    misfit: {
      color: colors.critText,
      textDecorationLine: "underline",
      textDecorationStyle: "wavy",
      textDecorationColor: colors.crit,
    } as unknown as TextStyle,
    link: { color: colors.accentText, flexShrink: 1 },
    box: {
      width: 16,
      height: 16,
      borderRadius: radii.sm,
      borderWidth: 1.5,
      borderColor: colors.lineStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    tick: { color: colors.ground, lineHeight: 14 },
    // Hugs its text, as the approved grid's chips do, rather than filling the cell.
    chip: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      height: 22,
      paddingHorizontal: space.x2,
      borderRadius: radii.sm,
      maxWidth: "100%",
    },
    dot: { width: 7, height: 7, borderRadius: 2 },
    person: { flexDirection: "row", alignItems: "center", gap: space.x2, maxWidth: "100%" },
    avatar: {
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: colors.accentDim,
      alignItems: "center",
      justifyContent: "center",
    },
    initial: { color: colors.accentText, lineHeight: 14, fontWeight: "600" },
  });
