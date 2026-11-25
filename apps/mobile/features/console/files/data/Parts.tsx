/**
 * The pieces every data page shares, drawn as the data sources boards draw
 * them: a section's head, the two button shapes, a formula's chips and a
 * metric's small trend. Sizes are the board's on the app's scale (11.5 and
 * 12.5 are 12; 10.5 is 11) and radii are the app's tokens.
 */

import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { fonts, pointerType, radii, touchType } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { Trend, trendGeometry } from "../folderPage/areas/Trend";
import { SourceMark } from "./Marks";
import type { Part, TargetState } from "./workOut";

/** "METRICS" with its quiet note on the right. */
export function SectionHead({ title, right, compact = false }: { title: string; right?: ReactNode; compact?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.sect, compact && styles.sectCompact]}>
      <Text style={styles.sectTitle} role="heading" aria-level={3}>
        {title}
      </Text>
      {right === undefined || right === null ? null : typeof right === "string" ? <Text style={styles.sectRight}>{right}</Text> : right}
    </View>
  );
}

/** A quiet link on a section's head: "Open about.md". */
export function SectionLink({ label, onPress }: { label: string; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable role="link" onPress={onPress} accessibilityLabel={label} style={styles.linkBox}>
      <Text style={styles.link}>{label}</Text>
    </Pressable>
  );
}

/**
 * The board's `.btn`: 32 high, secondary (a quiet fill and hairline) or
 * primary (the accent), or a square one for ⋯. On a phone, 38 high and
 * stretched, as the board's header buttons are.
 */
export function DataButton({
  label,
  kind = "sec",
  leading,
  onPress,
  compact = false,
  square = false,
  testID,
}: {
  label: string;
  kind?: "sec" | "pri";
  leading?: ReactNode;
  onPress: (anchor: { x: number; y: number }) => void;
  compact?: boolean;
  /** Just its glyph: `label` is then only its accessible name. */
  square?: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      onPress={(event) => onPress({ x: event.nativeEvent.pageX ?? 0, y: event.nativeEvent.pageY ?? 0 })}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      testID={testID}
      style={({ pressed }) => [
        styles.btn,
        kind === "pri" ? styles.pri : styles.sec,
        compact && styles.btnCompact,
        square && (compact ? styles.squareCompact : styles.square),
        hovered && styles.hover,
        pressed && styles.pressed,
      ]}
    >
      {leading}
      {square ? null : <Text style={[styles.btnLabel, kind === "pri" && styles.priLabel, compact && styles.btnLabelCompact]} numberOfLines={1}>{label}</Text>}
    </Pressable>
  );
}

/** A metric's recent periods as the Areas page's trend, at the board's 48 × 16 (18 on a phone). */
export function Spark({ series, target, state, compact = false }: { series: readonly number[]; target: number | null; state: TargetState; compact?: boolean }) {
  const geometry = trendGeometry(series, target);
  if (geometry === null) return <View style={{ width: 48, height: compact ? 18 : 16 }} />;
  return compact ? (
    <Trend geometry={geometry} state={state} width={48} height={18} stroke={1.8} dash="3 3" dashWidth={1.2} dot={2.8} />
  ) : (
    <Trend geometry={geometry} state={state} width={48} height={16} stroke={1.4} dot={2.2} />
  );
}

/** A value coloured by how it stands against its area's target: green on it, amber off it. */
export function ValueText({ text, state, compact = false, hidden = false }: { text: string; state: TargetState; compact?: boolean; hidden?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text
      numberOfLines={1}
      style={[styles.value, compact && styles.valueCompact, state === "met" && styles.met, state === "missed" && styles.missed, hidden && styles.hiddenValue]}
    >
      {text}
    </Text>
  );
}

/**
 * A formula as chips: the function word in mono, then one chip per aggregate
 * — the source's mark, the dataset in muted words and the column in bold —
 * the operators between, and the period after in the quietest grey.
 */
export function FormulaChips({ parts, period, large = false }: { parts: readonly Part[]; period?: string | null; large?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.formula, large && styles.formulaLarge]} testID="formula-chips">
      {parts.map((part, at) => {
        switch (part.t) {
          case "fn":
            return (
              <Text key={at} style={styles.fn}>
                {part.text}
              </Text>
            );
          case "chip":
            return (
              <View key={at} style={styles.chip}>
                {part.dataset === null ? null : <SourceMark kind={part.kind} size={13} />}
                {part.dataset === null ? null : (
                  <Text style={styles.chipDataset} numberOfLines={1}>
                    {part.dataset}
                  </Text>
                )}
                <Text style={styles.chipColumn} numberOfLines={1}>
                  {part.column}
                </Text>
              </View>
            );
          case "filter":
            return (
              <View key={at} style={[styles.chip, styles.filter]}>
                <Text style={styles.chipDataset} numberOfLines={1}>
                  {part.text}
                </Text>
              </View>
            );
          default:
            return (
              <Text key={at} style={styles.op}>
                {part.text}
              </Text>
            );
        }
      })}
      {period === undefined || period === null || period === "" ? null : (
        <Text style={styles.period} numberOfLines={1}>
          {period}
        </Text>
      )}
    </View>
  );
}

/** A dot in the status colour, before "Synced 5 min ago". */
export function StatusDot({ tone }: { tone: "ok" | "quiet" }) {
  const colors = useColors();
  return <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tone === "ok" ? colors.ok : colors.chromeMuted, flexShrink: 0 }} />;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    sect: { flexDirection: "row", alignItems: "baseline", gap: 10, marginTop: 6, marginBottom: 10 },
    sectCompact: { marginTop: 8 },
    sectTitle: {
      fontSize: pointerType.label,
      lineHeight: 15,
      fontWeight: "600",
      letterSpacing: 0.66,
      textTransform: "uppercase",
      color: colors.muted,
    },
    sectRight: { marginLeft: "auto", fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    linkBox: { marginLeft: "auto" },
    link: { fontSize: pointerType.meta, lineHeight: 16, color: colors.accentText, fontWeight: "500" },
    btn: {
      height: 32,
      paddingHorizontal: 14,
      borderRadius: radii.md,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      flexShrink: 0,
    },
    btnCompact: { height: 38, borderRadius: radii.card, flexGrow: 1, flexBasis: 0, paddingHorizontal: 8 },
    square: { width: 32, paddingHorizontal: 0 },
    squareCompact: { flexGrow: 0, flexBasis: 44, width: 44, paddingHorizontal: 0 },
    sec: { backgroundColor: colors.chipFill, borderWidth: 1, borderColor: colors.line },
    pri: { backgroundColor: colors.accent },
    hover: { opacity: 0.9 },
    pressed: { opacity: 0.82 },
    btnLabel: { fontSize: pointerType.ui, lineHeight: 18, fontWeight: "600", color: colors.text },
    btnLabelCompact: { fontSize: touchType.ui, lineHeight: 20 },
    priLabel: { color: colors.ink },
    value: { fontSize: pointerType.ui, lineHeight: 18, fontWeight: "600", color: colors.text, flexShrink: 0 },
    valueCompact: { fontSize: touchType.ui, lineHeight: 20 },
    met: { color: colors.okText },
    missed: { color: colors.warnText },
    hiddenValue: { color: colors.muted, fontWeight: "500" },
    formula: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0, overflow: "hidden" },
    formulaLarge: { gap: 5, flexWrap: "wrap" },
    fn: { fontFamily: fonts.mono, fontSize: pointerType.meta, lineHeight: 16, color: colors.text2 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      height: 20,
      paddingLeft: 4,
      paddingRight: 6,
      borderRadius: radii.xs,
      backgroundColor: colors.chipFill,
      borderWidth: 1,
      borderColor: colors.line,
      // The chip gives way before the period does: its dataset name ends in "…", the period stays whole.
      flexShrink: 1,
      minWidth: 0,
    },
    filter: { backgroundColor: colors.hintWash, borderColor: colors.hintBorder, paddingLeft: 6 },
    chipDataset: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, flexShrink: 1 },
    chipColumn: { fontSize: pointerType.meta, lineHeight: 16, color: colors.text, fontWeight: "600", flexShrink: 0 },
    op: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, paddingHorizontal: 2 },
    period: { fontSize: pointerType.meta, lineHeight: 16, color: colors.chromeMuted, paddingLeft: 4, flexShrink: 0 },
  });
