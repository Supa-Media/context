/**
 * The shapes the staff console draws, and nothing about what it draws them
 * from.
 *
 * Split out of `AdminPane` when the page stopped being a row of identical
 * tiles. The reason is the one the redesign rests on: **a dashboard for a
 * two-to-ten-customer product is mostly not tiles.** A tile answers "how
 * many", and at this size the questions that matter are "out of what" (a
 * composition), "in which direction" (a curve) and "who fell out" (a funnel) —
 * three different shapes, none of which is a big number in a box.
 *
 * Everything here is `View`s. The app has no charting dependency and this is
 * not a reason to acquire one: thirty flex children with a height is a bar
 * chart, and a library would arrive with its own theming, its own
 * accessibility story and its own opinion about dark mode.
 *
 * The arithmetic behind every shape lives in `./report` and is unit-tested
 * there. These render what it returns.
 */

import { StyleSheet, View } from "react-native";
import {
  Card,
  Pill,
  Text,
  radii,
  space,
  useColors,
  useTheme,
  useThemedStyles,
  withAlpha,
  type Colors,
} from "../design";
import {
  barHeights,
  formatCount,
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
function useToneColor(): (tone: SegmentTone) => string {
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
        return colors.muted;
    }
  };
}

// -- tiles ----------------------------------------------------------------

/**
 * One figure, its caption, and optionally the shape behind it.
 *
 * `emphasis` is what the old page had no way to express: eleven tiles of
 * identical weight, so "active contexts" and "site visits" read as equally
 * important. A headline tile is larger and gets the full width of a wider
 * column; the rest are ordinary.
 */
export function StatTile({
  label,
  value,
  caption,
  tone,
  emphasis = false,
  testID,
  children,
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: SegmentTone;
  emphasis?: boolean;
  testID?: string;
  children?: React.ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const toneColor = useToneColor();
  return (
    <Card
      // `Card` takes one style, not a list, so this composes before it goes in.
      style={StyleSheet.flatten([styles.tile, emphasis && styles.tileWide])}
      testID={testID}
    >
      <Text variant="statLabel">{label}</Text>
      <Text
        variant="statValue"
        style={tone ? { color: toneColor(tone) } : undefined}
      >
        {value}
      </Text>
      {children}
      {caption ? <Text variant="meta">{caption}</Text> : null}
    </Card>
  );
}

// -- trends ---------------------------------------------------------------

/**
 * A bar per day, scaled to this series' own maximum.
 *
 * Per-series scaling because these sit next to each other and one metric is
 * routinely two orders of magnitude bigger than another — see `barHeights`.
 * What is new against the original sparkline is the **peak label**: a chart
 * with no y-axis is a shape you can read a direction off and not a value, and
 * printing the maximum is the cheapest way to make the shape mean something.
 *
 * A zero day still draws a hairline, so the axis reads as a row of days with
 * nothing in some of them rather than as a chart that stops.
 */
export function TrendBars({
  points,
  tone = "accent",
  peak = true,
}: {
  points: readonly Point[];
  tone?: SegmentTone;
  /**
   * Print the series' maximum on the axis. Off inside a narrow tile, where
   * three labels on one line wrap and the shape is all there is room for.
   */
  peak?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const toneColor = useToneColor();
  const heights = barHeights(points);
  const first = points[0];
  const last = points[points.length - 1];
  const max = points.reduce((best, point) => Math.max(best, point.count), 0);

  return (
    <View>
      <View
        style={styles.spark}
        // The whole trend, not only its last day — a screen reader got
        // "ending 4 on the last day" and no idea what came before it.
        accessibilityLabel={describeTrend(points)}
      >
        {heights.map((height, index) => (
          <View
            key={points[index].day}
            style={[
              styles.sparkBar,
              {
                height: `${Math.max(height * 100, 2)}%`,
                backgroundColor:
                  points[index].count > 0 ? toneColor(tone) : colors.line,
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.sparkAxis}>
        <Text variant="meta">{first ? shortDay(first.day) : ""}</Text>
        {peak && max > 0 ? (
          <Text variant="meta">peak {formatCount(max)}</Text>
        ) : null}
        <Text variant="meta">{last ? shortDay(last.day) : ""}</Text>
      </View>
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

/**
 * The growth curve: a running total, with the days something arrived marked.
 *
 * Columns rather than a line, for the same no-dependency reason, and it reads
 * as an area chart at thirty of them. The marking is what makes it useful at
 * this size — a cumulative curve for a product with seven customers is very
 * nearly a flat line, and the information in it is *which days moved*.
 */
export function GrowthCurve({
  cumulative,
  added,
  tone = "accent",
}: {
  cumulative: readonly Point[];
  added: readonly Point[];
  tone?: SegmentTone;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const toneColor = useToneColor();
  const max = cumulative.reduce((best, point) => Math.max(best, point.count), 0);
  const addedByDay = new Map(added.map((point) => [point.day, point.count]));
  const first = cumulative[0];
  const last = cumulative[cumulative.length - 1];
  const strong = toneColor(tone);

  return (
    <View>
      <View
        style={styles.curve}
        accessibilityLabel={describeCurve(cumulative, added)}
      >
        {cumulative.map((point) => {
          const arrived = (addedByDay.get(point.day) ?? 0) > 0;
          return (
            <View
              key={point.day}
              style={[
                styles.curveBar,
                {
                  height: `${max > 0 ? Math.max((point.count / max) * 100, 2) : 2}%`,
                  backgroundColor: arrived ? strong : withAlpha(strong, 0.28),
                },
              ]}
            />
          );
        })}
      </View>
      <View style={styles.sparkAxis}>
        <Text variant="meta">
          {first ? `${shortDay(first.day)} · ${formatCount(first.count)}` : ""}
        </Text>
        <Text variant="meta" style={{ color: colors.text }}>
          {last ? `${shortDay(last.day)} · ${formatCount(last.count)}` : ""}
        </Text>
      </View>
    </View>
  );
}

export function describeCurve(
  cumulative: readonly Point[],
  added: readonly Point[],
): string {
  if (cumulative.length === 0) return "No days.";
  const first = cumulative[0];
  const last = cumulative[cumulative.length - 1];
  const arrivals = added.reduce((sum, point) => sum + point.count, 0);
  const movedOn = added.filter((point) => point.count > 0).length;
  return `${formatCount(first.count)} on ${shortDay(
    first.day,
  )}, rising to ${formatCount(last.count)} on ${shortDay(
    last.day,
  )}. ${formatCount(arrivals)} arrived across ${movedOn} of ${
    cumulative.length
  } days.`;
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
 * are red, amber and green.
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
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);

  if (segments.length === 0) {
    return (
      <Text variant="paneSub" testID={testID}>
        {empty}
      </Text>
    );
  }

  return (
    <View style={styles.composition} testID={testID}>
      <View
        style={styles.bar}
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
              backgroundColor: toneColor(segment.tone),
            }}
          />
        ))}
      </View>
      <View style={styles.legend}>
        {segments.map((segment) => (
          <View key={segment.key} style={styles.legendRow}>
            <View
              style={[
                styles.swatch,
                { backgroundColor: toneColor(segment.tone) },
              ]}
            />
            <Text variant="rowSub">{segment.label}</Text>
            <Text variant="rowTitle">{formatCount(segment.count)}</Text>
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
 * bar, and a `+1` beside it.
 */
export function FunnelChart({ rows }: { rows: readonly FunnelRow[] }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  return (
    <View style={styles.funnel}>
      {rows.map((row) => (
        <View key={row.step} style={styles.funnelRow}>
          <Text variant="rowSub" style={styles.funnelLabel}>
            {row.label}
          </Text>
          <View style={styles.funnelTrack}>
            <View
              style={[
                styles.funnelFill,
                {
                  width: `${Math.max(row.share * 100, row.count > 0 ? 3 : 0)}%`,
                  backgroundColor:
                    row.step === "paying" ? colors.ok : colors.accent,
                },
              ]}
            />
          </View>
          <Text variant="rowTitle" style={styles.funnelCount}>
            {formatCount(row.count)}
          </Text>
          <Text variant="meta" style={styles.funnelDrop}>
            {row.change === null || row.change === 0
              ? ""
              : row.change > 0
                ? `+${formatCount(row.change)}`
                : `−${formatCount(Math.abs(row.change))}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

// -- rows -----------------------------------------------------------------

/** A labelled figure in a list, where a tile would be too much furniture. */
export function FactRow({
  label,
  value,
  sub,
  chip,
  chipTone = "neutral",
  testID,
}: {
  label: string;
  value: string;
  sub?: string;
  chip?: string;
  chipTone?: "ok" | "warn" | "crit" | "neutral";
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.factRow} testID={testID}>
      <View style={styles.factName}>
        <Text variant="rowTitle">{label}</Text>
        {sub ? <Text variant="meta">{sub}</Text> : null}
      </View>
      {chip ? <Pill tone={chipTone}>{chip}</Pill> : null}
      <Text variant="rowValueTouch">{value}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    tile: { flexGrow: 1, flexBasis: 200, gap: space.x2, padding: space.x5 },
    tileWide: { flexBasis: 260 },

    spark: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 2,
      height: 48,
      marginTop: space.x2,
    },
    sparkBar: { flex: 1, borderRadius: radii.xs, minHeight: 1 },
    sparkAxis: {
      flexDirection: "row",
      justifyContent: "space-between",
      gap: space.x2,
      marginTop: space.x1,
    },

    // No gap between columns: a running total reads as an area, and gaps make
    // a monotonic series look like separate events.
    curve: {
      flexDirection: "row",
      alignItems: "flex-end",
      height: 72,
      marginTop: space.x2,
      gap: 1,
    },
    curveBar: { flex: 1, borderTopLeftRadius: 1, borderTopRightRadius: 1, minHeight: 1 },

    composition: { gap: space.x3 },
    bar: {
      flexDirection: "row",
      height: 12,
      borderRadius: radii.xs,
      overflow: "hidden",
      backgroundColor: colors.line,
    },
    legend: { gap: space.x2 },
    legendRow: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    swatch: { width: 10, height: 10, borderRadius: 3 },

    funnel: { gap: space.x3 },
    funnelRow: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    funnelLabel: { flexBasis: 132, flexShrink: 1, minWidth: 84 },
    funnelTrack: {
      flex: 1,
      minWidth: 40,
      height: 10,
      borderRadius: radii.xs,
      backgroundColor: colors.line,
      overflow: "hidden",
    },
    funnelFill: { height: "100%", borderRadius: radii.xs },
    funnelCount: { minWidth: 40, textAlign: "right" },
    funnelDrop: { minWidth: 34, textAlign: "right" },

    factRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    factName: { flex: 1, gap: 2, minWidth: 120 },
  });
