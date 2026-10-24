/**
 * Explore: slice the window's scored conversations by anything they carry
 * (the owner, 2026-10-24: "advanced filtering so that I can slice by different
 * metrics and see what tasks people get frustrated with").
 *
 * One compact row of dropdowns: a measure, what goes down the side and across
 * the top, then a filter per field. Below, the table: worst rows first, each
 * cell shaded by how bad it is against the others, with how many
 * conversations it rests on. Tapping a row's name filters to it.
 */

import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { EmptyNote, Panel } from "./AdminKit";
import { TexPicker } from "./TexPicker";
import {
  DIMENSIONS,
  MEASURES,
  applyFilters,
  filterButtonLabel,
  formatMeasure,
  heatOf,
  optionsOf,
  pivot,
  toggleFilter,
  type Dimension,
  type Measure,
  type TexFilters,
  type TexReview,
} from "./tex";

/** A cell resting on fewer conversations than this is drawn faint: too few to read anything into. */
const THIN = 3;

export function TexExplore({ reviews }: { reviews: readonly TexReview[] }) {
  const styles = useThemedStyles(makeStyles);
  const [measure, setMeasure] = useState<Measure>("frustrated");
  const [rowDim, setRowDim] = useState<Dimension>("task");
  const [colDim, setColDim] = useState<Dimension | null>("chat");
  const [filters, setFilters] = useState<TexFilters>({});

  const kept = useMemo(() => applyFilters(reviews, filters), [reviews, filters]);
  const table = useMemo(() => pivot(kept, rowDim, colDim === rowDim ? null : colDim, measure), [kept, rowDim, colDim, measure]);
  const filtering = Object.values(filters).some((values) => values.length > 0);
  const measureLabel = MEASURES.find((m) => m.key === measure)?.label ?? measure;
  const dimLabel = (key: Dimension | null) => (key === null ? "Nothing" : (DIMENSIONS.find((d) => d.key === key)?.label ?? key));
  const allValues = table.cells.flat().filter((cell) => cell.n >= THIN).map((cell) => cell.value);

  return (
    <Panel
      title="Explore"
      meta={`${kept.length} of ${reviews.length} conversations`}
      help="Every scored conversation in the window, sliced by anything it carries. Frustrated means a frustration signal showed or calm scored 4 or under. Cells with fewer than 3 conversations are faint."
      testID="admin-tex-explore"
    >
      <View style={styles.controls}>
        <TexPicker
          label={`Show: ${measureLabel}`}
          title="Show"
          options={MEASURES.map((m) => ({ value: m.key, label: m.label }))}
          picked={[measure]}
          onPick={(value) => value !== null && setMeasure(value as Measure)}
          testID="admin-tex-measure"
        />
        <TexPicker
          label={`Rows: ${dimLabel(rowDim)}`}
          title="Rows"
          options={DIMENSIONS.map((d) => ({ value: d.key, label: d.label }))}
          picked={[rowDim]}
          onPick={(value) => value !== null && setRowDim(value as Dimension)}
          testID="admin-tex-rows"
        />
        <TexPicker
          label={`Columns: ${dimLabel(colDim)}`}
          title="Columns"
          options={[{ value: "", label: "Nothing" }, ...DIMENSIONS.filter((d) => d.key !== rowDim).map((d) => ({ value: d.key, label: d.label }))]}
          picked={[colDim ?? ""]}
          onPick={(value) => setColDim(value === null || value === "" ? null : (value as Dimension))}
          testID="admin-tex-cols"
        />
      </View>
      <View style={styles.controls} testID="admin-tex-filters">
        {DIMENSIONS.map((dimension) => {
          const picked = filters[dimension.key] ?? [];
          return (
            <TexPicker
              key={dimension.key}
              multi
              active={picked.length > 0}
              label={filterButtonLabel(dimension.key, picked)}
              title={dimension.label}
              options={optionsOf(reviews, dimension.key).map((option) => ({ value: option.value, label: option.label, count: option.count }))}
              picked={picked}
              onPick={(value) => setFilters((was) => (value === null ? { ...was, [dimension.key]: [] } : toggleFilter(was, dimension.key, value)))}
              testID={`admin-tex-filter-${dimension.key}`}
            />
          );
        })}
        {filtering ? (
          <Pressable role="button" onPress={() => setFilters({})} style={styles.clear} testID="admin-tex-clear">
            <Text variant="meta" style={styles.clearText}>
              Clear filters
            </Text>
          </Pressable>
        ) : null}
      </View>
      {kept.length === 0 ? (
        <EmptyNote title="No conversations match" body="Loosen a filter, or pick a longer window." />
      ) : (
        <ScrollView horizontal contentContainerStyle={styles.tableWrap}>
          <View style={styles.table} testID="admin-tex-table">
            <View style={styles.row}>
              <Text variant="eyebrow" style={styles.head}>
                {dimLabel(rowDim)}
              </Text>
              {table.cols.map((col) => (
                <Text key={col.value} variant="eyebrow" style={styles.cellHead} numberOfLines={1}>
                  {col.label}
                </Text>
              ))}
              {table.cols.length > 1 ? (
                <Text variant="eyebrow" style={styles.cellHead}>
                  All
                </Text>
              ) : null}
            </View>
            {table.rows.map((row, r) => (
              <View key={row.value} style={styles.row}>
                <Pressable
                  role="button"
                  accessibilityLabel={`Only ${row.label}`}
                  onPress={() => setFilters((was) => ({ ...was, [rowDim]: [row.value] }))}
                  style={styles.head}
                >
                  <Text variant="rowSub" numberOfLines={1} style={styles.rowName}>
                    {row.label}
                  </Text>
                </Pressable>
                {[...table.cells[r], ...(table.cols.length > 1 ? [table.totals[r]] : [])].map((cell, c) => (
                  <Cell key={c} measure={measure} n={cell.n} value={cell.value} heat={cell.n >= THIN ? heatOf(measure, cell.value, allValues) : null} />
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </Panel>
  );
}

function Cell({ measure, n, value, heat }: { measure: Measure; n: number; value: number | null; heat: number | null }) {
  const styles = useThemedStyles(makeStyles);
  const thin = n < THIN;
  return (
    <View style={[styles.cell, heat !== null && { backgroundColor: heatColor(heat) }]} accessibilityLabel={`${formatMeasure(measure, value)}, ${n} conversations`}>
      <Text variant="rowSub" style={[styles.cellValue, thin && styles.thin]}>
        {n === 0 ? "" : formatMeasure(measure, value)}
      </Text>
      {n > 0 && measure !== "count" ? (
        <Text variant="meta" style={styles.thin}>
          {n}
        </Text>
      ) : null}
    </View>
  );
}

/** Clear for the best cell to a warm red for the worst; translucent, so it reads on light and dark. */
function heatColor(heat: number): string {
  return `rgba(220, 70, 50, ${(0.06 + heat * 0.4).toFixed(2)})`;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    controls: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2, marginBottom: space.x3 },
    clear: { paddingHorizontal: space.x2, paddingVertical: 6 },
    clearText: { color: colors.accent },
    tableWrap: { minWidth: "100%" },
    table: { minWidth: "100%" },
    row: { flexDirection: "row", alignItems: "stretch", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    head: { width: 180, paddingVertical: space.x2, paddingRight: space.x2, justifyContent: "center" },
    rowName: { color: colors.text },
    cellHead: { width: 104, paddingVertical: space.x2, textAlign: "center" },
    cell: { width: 104, paddingVertical: space.x2, alignItems: "center", justifyContent: "center", gap: 2 },
    cellValue: { color: colors.text, fontVariant: ["tabular-nums"], fontWeight: "600" },
    thin: { color: colors.muted, opacity: 0.7 },
  });
