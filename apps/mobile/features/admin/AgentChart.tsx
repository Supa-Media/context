/**
 * The Agent tab's "Answer time by day": the typical and the slowest answer as
 * two lines, with how many questions were asked drawn faintly behind them.
 *
 * Drawn the way `./GrowthArea` is — one fixed 1000×100 box stretched to the
 * view, `curveGeometry` for the lines — so it paints without measuring. The
 * volume bars are views in percentages, on their own scale, because the
 * question count is a different unit from the seconds the gridlines label.
 */

import { StyleSheet, View } from "react-native";
import { Path, Svg } from "react-native-svg";
import { Text, leading, space, useColors, useTheme, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { bucketLabel, formatSeconds, type AgentReport } from "./agent";
import { CURVE_BOX, curveGeometry, niceTop } from "./growth";

const CHART_HEIGHT = 148;

export function AgentChart({ buckets }: { buckets: AgentReport["buckets"] }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { graphColors } = useTheme();
  const top = niceTop(buckets.reduce((best, bucket) => Math.max(best, bucket.p95), 0) / 1000) * 1000;
  const mostTurns = buckets.reduce((best, bucket) => Math.max(best, bucket.turns), 0);
  const typical = curveGeometry(buckets.map((bucket) => bucket.p50), top);
  const slowest = curveGeometry(buckets.map((bucket) => bucket.p95), top);
  const first = buckets[0];
  const last = buckets[buckets.length - 1];

  return (
    <View testID="admin-agent-chart">
      <View style={styles.legend}>
        <Key color={colors.accent} label="Typical" />
        <Key color={graphColors.shared} label="Slowest 1 in 20" />
        <Key color={colors.line} label="Questions" block />
      </View>
      <View style={styles.chart} accessibilityLabel={describe(buckets)}>
        <View style={styles.bars} aria-hidden>
          {buckets.map((bucket) => (
            <View key={bucket.label} style={styles.barSlot}>
              <View
                style={[styles.bar, { height: `${mostTurns > 0 ? (bucket.turns / mostTurns) * 100 : 0}%` }]}
              />
            </View>
          ))}
        </View>
        {[1, 0.5].map((share) => (
          <View key={share} style={[styles.grid, { top: `${(1 - share) * 100}%` }]}>
            <Text style={styles.gridLabel}>{formatSeconds(top * share)}</Text>
          </View>
        ))}
        <Svg
          width="100%"
          height="100%"
          style={StyleSheet.absoluteFill}
          viewBox={`0 0 ${CURVE_BOX.width} ${CURVE_BOX.height}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          {[
            { geometry: slowest, color: graphColors.shared },
            { geometry: typical, color: colors.accent },
          ].map(({ geometry, color }) => (
            <Path
              key={color}
              d={geometry.line}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </Svg>
      </View>
      <View style={styles.axis}>
        <Text variant="meta">{first ? bucketLabel(first.label) : ""}</Text>
        <Text variant="meta">{last ? bucketLabel(last.label) : ""}</Text>
      </View>
    </View>
  );
}

function Key({ color, label, block = false }: { color: string; label: string; block?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.key}>
      <View style={[block ? styles.keyBlock : styles.keyLine, { backgroundColor: color }]} />
      <Text variant="meta">{label}</Text>
    </View>
  );
}

/** What a screen reader hears in place of the lines. */
export function describe(buckets: AgentReport["buckets"]): string {
  const asked = buckets.reduce((sum, bucket) => sum + bucket.turns, 0);
  const busiest = buckets.reduce<AgentReport["buckets"][number] | null>(
    (best, bucket) => (best === null || bucket.turns > best.turns ? bucket : best),
    null,
  );
  if (asked === 0 || busiest === null) return "No questions in this window.";
  return `${asked} questions. Busiest ${bucketLabel(busiest.label)}, typical ${formatSeconds(busiest.p50)}, slowest ${formatSeconds(busiest.p95)}.`;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    legend: { flexDirection: "row", flexWrap: "wrap", gap: space.x4, marginBottom: space.x3 },
    key: { flexDirection: "row", alignItems: "center", gap: 6 },
    keyLine: { width: 14, height: 2, borderRadius: 1 },
    keyBlock: { width: 10, height: 10, borderRadius: 2 },
    chart: { height: CHART_HEIGHT, marginTop: space.x4, position: "relative" },
    bars: { ...StyleSheet.absoluteFillObject, flexDirection: "row", alignItems: "flex-end", gap: 2 },
    barSlot: { flex: 1, height: "100%", justifyContent: "flex-end" },
    bar: { backgroundColor: colors.line, opacity: 0.45, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
    grid: {
      position: "absolute",
      left: 0,
      right: 0,
      borderTopWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.line,
    },
    gridLabel: {
      position: "absolute",
      left: 0,
      top: -17,
      paddingRight: 4,
      backgroundColor: colors.surface,
      fontSize: pointerType.label,
      lineHeight: leading(pointerType.label, 1.3),
      color: colors.heroDim,
      fontVariant: ["tabular-nums"],
    },
    axis: { flexDirection: "row", justifyContent: "space-between", marginTop: space.x2 },
  });
