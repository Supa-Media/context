/**
 * Metrics as rows (the data sources boards 01, 07, 09 and 11): on a pointer
 * layout a table of name, latest value with its trend, formula as chips and
 * who uses it; on a phone, name and value over one quiet line. A row opens
 * its metric note.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType, touchType } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { FileGlyph } from "./Marks";
import { FormulaChips, Spark, ValueText } from "./Parts";
import type { MetricView } from "./views";

export function MetricRows({
  metrics,
  compact,
  onOpen,
  header = false,
  asFiles = false,
  phoneLine = "used",
}: {
  metrics: readonly MetricView[];
  compact: boolean;
  onOpen: (path: string) => void;
  /** The Data page's column names over the rows. */
  header?: boolean;
  /** The metrics folder's page: each row named by its note's file name, with the note's glyph. */
  asFiles?: boolean;
  /** A phone's quiet line: who uses it, or who uses it and what it reads (the Data page). */
  phoneLine?: "used" | "usedAndInputs";
}) {
  const styles = useThemedStyles(makeStyles);
  if (compact) {
    return (
      <View style={styles.phoneList}>
        {metrics.map((metric) => (
          <PhoneRow key={metric.path} metric={metric} onOpen={onOpen} line={phoneLine} asFiles={asFiles} />
        ))}
      </View>
    );
  }
  return (
    <View style={styles.table} role="table">
      {header ? (
        <View style={[styles.row, styles.headRow]} role="row">
          <Text style={[styles.headCell, styles.name]}>Name</Text>
          <Text style={[styles.headCell, styles.valueCell]}>Latest</Text>
          <Text style={[styles.headCell, styles.formulaCell]}>Formula</Text>
          <Text style={[styles.headCell, styles.used]}>Used by</Text>
        </View>
      ) : null}
      {metrics.map((metric) => (
        <DesktopRow key={metric.path} metric={metric} onOpen={onOpen} asFiles={asFiles} />
      ))}
    </View>
  );
}

function DesktopRow({ metric, onOpen, asFiles }: { metric: MetricView; onOpen: (path: string) => void; asFiles: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      role="row"
      accessibilityLabel={`${metric.name}, ${metric.shown}`}
      onPress={() => onOpen(metric.path)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.row, hovered && styles.rowHover]}
      testID="metric-row"
    >
      {asFiles ? (
        <View style={[styles.fileName]}>
          <FileGlyph size={14} color={colors.chromeMuted} />
          <Text style={styles.nameText} numberOfLines={1}>
            {metric.slug}
          </Text>
        </View>
      ) : (
        <Text style={[styles.name, styles.nameText]} numberOfLines={1}>
          {metric.name}
        </Text>
      )}
      <View style={styles.valueCell}>
        <Spark series={metric.series} target={metric.target} state={metric.state} />
        <ValueText text={metric.shown} state={metric.state} hidden={metric.status === "hidden"} />
      </View>
      <View style={styles.formulaCell}>
        {metric.problem !== null && metric.parts.length === 0 ? (
          <Text style={styles.problem} numberOfLines={1}>
            {metric.problem}
          </Text>
        ) : (
          <FormulaChips parts={metric.parts} period={metric.period} />
        )}
      </View>
      <Text style={[styles.used, metric.usedBy === null && styles.unused]} numberOfLines={1}>
        {metric.usedBy ?? "Not used yet"}
      </Text>
    </Pressable>
  );
}

function PhoneRow({ metric, onOpen, line, asFiles }: { metric: MetricView; onOpen: (path: string) => void; line: "used" | "usedAndInputs"; asFiles: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const used = metric.usedBy === null ? null : `Used by ${metric.usedBy}`;
  const words =
    metric.problem !== null && metric.parts.length === 0
      ? metric.problem
      : line === "used"
        ? (used ?? "Not used yet")
        : [used, metric.inputs].filter((part) => part !== null && part !== "").join(" · ");
  return (
    <Pressable role="button" accessibilityLabel={`${metric.name}, ${metric.shown}`} onPress={() => onOpen(metric.path)} style={styles.phoneRow} testID="metric-row">
      <View style={styles.phoneTop}>
        <Text style={styles.phoneName} numberOfLines={1}>
          {asFiles ? metric.slug : metric.name}
        </Text>
        <Spark series={metric.series} target={metric.target} state={metric.state} compact />
        <ValueText text={metric.shown} state={metric.state} compact hidden={metric.status === "hidden"} />
      </View>
      {words === "" ? null : (
        <Text style={[styles.phoneLine, metric.problem !== null && metric.parts.length === 0 && styles.problem]} numberOfLines={1}>
          {words}
        </Text>
      )}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    table: { borderTopWidth: 1, borderTopColor: colors.line, marginBottom: 26 },
    row: { flexDirection: "row", alignItems: "center", gap: 16, height: 44, borderBottomWidth: 1, borderBottomColor: colors.line, paddingHorizontal: 4 },
    rowHover: { backgroundColor: colors.chipFill },
    headRow: { height: 30 },
    headCell: { fontSize: pointerType.meta, lineHeight: 16, color: colors.chromeMuted, fontWeight: "400" },
    name: { width: 160, flexShrink: 0 },
    fileName: { width: 190, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 8 },
    nameText: { fontSize: pointerType.ui, lineHeight: 18, fontWeight: "600", color: colors.text, flexShrink: 1 },
    valueCell: { width: 120, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 8 },
    formulaCell: { flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: "row", alignItems: "center" },
    used: { width: 136, flexShrink: 0, textAlign: "right", fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    unused: { color: colors.chromeMuted, fontStyle: "italic" },
    problem: { fontSize: pointerType.meta, lineHeight: 16, color: colors.critText },
    phoneList: { marginBottom: 20 },
    phoneRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line, gap: 4 },
    phoneTop: { flexDirection: "row", alignItems: "center", gap: 8 },
    phoneName: { flexGrow: 1, flexShrink: 1, fontSize: touchType.ui, lineHeight: 22, fontWeight: "600", color: colors.text },
    phoneLine: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
  });
