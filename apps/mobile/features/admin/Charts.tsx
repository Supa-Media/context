/**
 * The shapes the staff console draws, and nothing about what it draws them
 * from.
 *
 * A dashboard for a two-to-ten-customer product is mostly not tiles. A tile
 * answers "how many", and at this size the questions that matter are "out of
 * what" (a composition), "in which direction" (bars per day) and "who fell
 * out" (a funnel) — three shapes, none of which is a big number in a box. The
 * growth curve is the fourth, and lives in `./GrowthArea` because it is SVG.
 *
 * Everything here is `View`s. Thirty flex children with a height is a bar
 * chart, and a charting library would arrive with its own theming, its own
 * accessibility story and its own opinion about dark mode.
 *
 * The arithmetic behind every shape lives in `./report` and is unit-tested
 * there. These render what it returns.
 */

import { StyleSheet, View } from "react-native";
import {
  Text,
  radii,
  space,
  useColors,
  useTheme,
  useThemedStyles,
  type Colors,
} from "../design";
import { pointerType } from "../design/tokens";
import { useCompact } from "./AdminKit";
import {
  barHeights,
  formatCount,
  formatSigned,
  shortDay,
  type CompositionSegment,
  type FunnelRow,
  type Point,
  type SegmentTone,
} from "./report";

/**
 * A tone to a colour, in one place.
 *
 * `shared` comes from the graph palette rather than the surface palette
 * because it is the one hue the console already reserves for "a context with
 * other people in it", and a shared context on this page is the same idea.
 */
export function useToneColor(): (tone: SegmentTone) => string {
  const colors = useColors();
  const { graphColors } = useTheme();
  return (tone) => {
    switch (tone) {
      case "accent":
        return colors.accent;
      case "ok":
        return colors.ok;
      case "warn":
        return colors.warn;
      case "crit":
        return colors.crit;
      case "shared":
        return graphColors.shared;
      case "muted":
      default:
        return colors.heroDim;
    }
  };
}

// -- trends ---------------------------------------------------------------

/**
 * A bar per day, scaled to this series' own maximum.
 *
 * Two sizes. `bars` is the one chart on the Activity tab, with its first and
 * last day under it. `spark` is a row of the events table: no axis, because
 * the table's header says the range once rather than eight times, and each
 * line on its own scale because one metric is routinely two orders of
 * magnitude bigger than another — see `barHeights`.
 *
 * A zero day still draws a hairline in `line`, so the row reads as days with
 * nothing in some of them rather than as a chart that stops.
 */
export function TrendBars({
  points,
  size = "bars",
}: {
  points: readonly Point[];
  size?: "bars" | "spark";
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const compact = useCompact();
  const heights = barHeights(points);
  const first = points[0];
  const last = points[points.length - 1];
  const spark = size === "spark";

  return (
    <View>
      <View
        style={[
          spark ? styles.spark : styles.bars,
          !spark && compact && styles.barsCompact,
        ]}
        // The whole trend, not only its last day — a screen reader got
        // "ending 4 on the last day" and no idea what came before it.
        accessibilityLabel={describeTrend(points)}
      >
        {heights.map((height, index) => (
          <View
            key={points[index].day}
            style={[
              spark ? styles.sparkBar : styles.bar,
              {
                height: `${Math.max(height * 100, spark ? 4 : 2)}%`,
                backgroundColor: points[index].count > 0 ? colors.accent : colors.line,
              },
            ]}
          />
        ))}
      </View>
      {spark ? null : (
        <View style={styles.axis}>
          <Text variant="meta">{first ? shortDay(first.day) : ""}</Text>
          <Text variant="meta">{last ? shortDay(last.day) : ""}</Text>
        </View>
      )}
    </View>
  );
}

/** What a screen reader is told about a trend, rather than a single day. */
export function describeTrend(points: readonly Point[]): string {
  if (points.length === 0) return "No days.";
  const first = points[0];
  const last = points[points.length - 1];
  const max = points.reduce((best, point) => Math.max(best, point.count), 0);
  const total = points.reduce((sum, point) => sum + point.count, 0);
  return `${points.length} days, ${shortDay(first.day)} to ${shortDay(
    last.day,
  )}. ${formatCount(total)} in total, peaking at ${formatCount(
    max,
  )}, ending at ${formatCount(last.count)}.`;
}

// -- composition ----------------------------------------------------------

/**
 * One bar showing what a whole is made of, with a legend that carries the
 * counts.
 *
 * The legend is not decoration and is not optional. Slice widths are lifted
 * off zero for small parts (`MIN_SEGMENT_PERCENT`), so the bar is a
 * composition at a glance and the numbers beside it are the truth — and colour
 * alone never carries a meaning, which matters here because three of the tones
 * are red, amber and green. Inline rather than one row per part: at four
 * parts a stacked legend was taller than the card's actual content.
 */
export function CompositionBar({
  segments,
  empty,
  testID,
}: {
  segments: readonly CompositionSegment[];
  /** What to say when every part is zero. */
  empty: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const toneColor = useToneColor();
  const compact = useCompact();
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);

  if (segments.length === 0) {
    return (
      <Text variant="meta" testID={testID}>
        {empty}
      </Text>
    );
  }

  return (
    <View testID={testID}>
      <View
        style={styles.composition}
        accessibilityLabel={segments
          .map(
            (segment) =>
              `${segment.label}: ${formatCount(segment.count)} of ${formatCount(total)}`,
          )
          .join(", ")}
      >
        {segments.map((segment) => (
          <View
            key={segment.key}
            style={{
              width: `${segment.percent}%`,
              flexShrink: 1,
              backgroundColor: toneColor(segment.tone),
            }}
          />
        ))}
      </View>
      <View style={styles.legend}>
        {segments.map((segment) => (
          <View key={segment.key} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: toneColor(segment.tone) }]} />
            <Text variant="meta" style={compact ? styles.legendCompact : null}>
              {segment.label}
            </Text>
            <Text style={[styles.legendCount, compact && styles.legendCompact]}>
              {formatCount(segment.count)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// -- the funnel -----------------------------------------------------------

/**
 * Thresholds, each as a bar against everybody who signed up.
 *
 * Bars rather than a tapering funnel graphic, because **the steps are not
 * nested** (`lib/census.ts`) and a taper draws a claim the data does not make.
 * A step that is larger than the one above it renders honestly here: a longer
 * bar, and a `+1` beside it in the accent.
 *
 * On a phone the label, count and change share a line and the track runs the
 * full width under them. The old fixed label column left a phone about forty
 * points of bar, which is not a chart.
 */
export function FunnelChart({ rows }: { rows: readonly FunnelRow[] }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const compact = useCompact();

  return (
    <View style={[styles.funnel, compact && styles.funnelCompact]}>
      {rows.map((row) => {
        const change =
          row.change === null || row.change === 0 ? "" : formatSigned(row.change);
        const track = (
          <View style={[styles.track, !compact && styles.trackWide]}>
            <View
              style={[
                styles.fill,
                {
                  width: `${Math.max(row.share * 100, row.count > 0 ? 3 : 0)}%`,
                  backgroundColor: row.step === "paying" ? colors.ok : colors.accent,
                },
              ]}
            />
          </View>
        );
        const count = (
          <Text style={[styles.count, compact && styles.countCompact]}>
            {formatCount(row.count)}
          </Text>
        );
        const drop = (
          <Text
            variant="meta"
            style={[styles.drop, (row.change ?? 0) > 0 && styles.dropUp]}
          >
            {change}
          </Text>
        );
        return compact ? (
          <View key={row.step} style={styles.rowCompact}>
            <View style={styles.rowLine}>
              <Text style={[styles.label, styles.labelCompact]}>{row.label}</Text>
              {count}
              {drop}
            </View>
            {track}
          </View>
        ) : (
          <View key={row.step} style={styles.row}>
            <Text style={[styles.label, styles.labelWide]} numberOfLines={1}>
              {row.label}
            </Text>
            {track}
            {count}
            {drop}
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    bars: { flexDirection: "row", alignItems: "flex-end", gap: 3, height: 112 },
    barsCompact: { height: 88, gap: 2 },
    bar: { flex: 1, borderTopLeftRadius: 2, borderTopRightRadius: 2, minHeight: 2 },
    spark: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 28 },
    sparkBar: { flex: 1, borderRadius: 1, minHeight: 1 },
    axis: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },

    composition: {
      flexDirection: "row",
      gap: 2,
      height: 8,
      borderRadius: radii.pill,
      overflow: "hidden",
      backgroundColor: colors.line,
    },
    legend: {
      flexDirection: "row",
      flexWrap: "wrap",
      rowGap: 6,
      columnGap: 18,
      marginTop: 10,
    },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
    swatch: { width: 8, height: 8, borderRadius: 2 },
    legendCount: {
      fontSize: pointerType.meta,
      fontWeight: "600",
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    legendCompact: { fontSize: pointerType.ui },

    funnel: { gap: space.x3 },
    funnelCompact: { gap: 14 },
    row: { flexDirection: "row", alignItems: "center", gap: 14 },
    rowCompact: { gap: 6 },
    rowLine: { flexDirection: "row", alignItems: "center", gap: 10 },
    label: { fontSize: pointerType.ui, color: colors.text2 },
    labelWide: { width: 150 },
    labelCompact: { flex: 1, fontSize: pointerType.lede },
    track: {
      height: 8,
      borderRadius: radii.pill,
      backgroundColor: colors.line,
      overflow: "hidden",
    },
    // Only in a row: in the phone's column a `flex: 1` is a zero basis on the
    // *height*, and the track vanished.
    trackWide: { flex: 1 },
    fill: { height: "100%", borderRadius: radii.pill },
    count: {
      width: 36,
      textAlign: "right",
      fontSize: pointerType.ui,
      fontWeight: "600",
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    countCompact: { width: undefined, fontSize: pointerType.lede },
    drop: { width: 32, textAlign: "right", fontVariant: ["tabular-nums"] },
    dropUp: { color: colors.accentText, fontWeight: "600" },
  });
