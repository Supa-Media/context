/**
 * "Each day, by feature": one bar per day, stacked by feature in each
 * feature's colour, scaled to the tallest day, with a legend underneath.
 *
 * Drawn the way `./Charts`' `TrendBars` is, as plain `View`s in percentages,
 * so it paints without measuring. A day with nothing spent keeps a hairline,
 * so a quiet day reads as a quiet day rather than as a gap in the chart.
 */

import { StyleSheet, View } from "react-native";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { useCompact } from "./AdminKit";
import { useToneColor } from "./Charts";
import { formatDollars, stackedDays, featureName, type FeatureRow } from "./aiCosts";
import { shortDay } from "./report";
import type { AiCostsReport } from "@context/convex/functions/lib/adminFns/aiCostsShape";
import { Swatch } from "./AiCostsParts";

export function AiCostsDays({ daily, rows }: { daily: AiCostsReport["daily"]; rows: readonly FeatureRow[] }) {
  const styles = useThemedStyles(makeStyles);
  const toneColor = useToneColor();
  const compact = useCompact();
  const days = stackedDays(daily);
  const first = days[0];
  const last = days[days.length - 1];

  return (
    <View testID="ai-costs-days">
      <View style={[styles.bars, compact && styles.barsCompact]} accessibilityLabel={describeDays(days)}>
        {days.map((day) => (
          <View key={day.day} style={styles.slot}>
            {day.total > 0 ? (
              <View style={[styles.column, { height: `${Math.max(day.height * 100, 2)}%` }]}>
                {day.segments.map((segment) => (
                  <View
                    key={segment.feature}
                    style={{ flexGrow: segment.costUsd, flexBasis: 0, backgroundColor: toneColor(segment.tone) }}
                  />
                ))}
              </View>
            ) : (
              <View style={styles.quiet} />
            )}
          </View>
        ))}
      </View>
      <View style={styles.axis}>
        <Text variant="meta">{first ? shortDay(first.day) : ""}</Text>
        <Text variant="meta">{last ? shortDay(last.day) : ""}</Text>
      </View>
      <View style={styles.legend}>
        {rows.map((row) => (
          <View key={row.feature} style={styles.key}>
            <Swatch tone={row.tone} />
            <Text variant="meta">{featureName(row.feature, row.label)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** What a screen reader hears in place of the bars. */
export function describeDays(days: ReturnType<typeof stackedDays>): string {
  if (days.length === 0) return "No days in this window.";
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const busiest = days.reduce((best, day) => (day.total > best.total ? day : best), days[0]);
  return `${days.length} days, ${formatDollars(total)} in all. Busiest ${shortDay(busiest.day)} at ${formatDollars(busiest.total)}.`;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    bars: { flexDirection: "row", alignItems: "flex-end", gap: 3, height: 112, marginTop: space.x2 },
    barsCompact: { height: 88, gap: 2 },
    slot: { flex: 1, height: "100%", justifyContent: "flex-end" },
    column: { width: "100%", flexDirection: "column", minHeight: 2, borderTopLeftRadius: 2, borderTopRightRadius: 2, overflow: "hidden" },
    quiet: { height: 2, backgroundColor: colors.line },
    axis: { flexDirection: "row", justifyContent: "space-between", marginTop: space.x2 },
    legend: { flexDirection: "row", flexWrap: "wrap", gap: space.x3, marginTop: space.x3 },
    key: { flexDirection: "row", alignItems: "center", gap: 6 },
  });
