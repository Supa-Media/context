/**
 * A cumulative total over the window, drawn as a soft area under a smooth
 * curve, with the days somebody arrived marked on it.
 *
 * It replaced a row of thirty columns whose only encoding of "a day somebody
 * arrived" was a darker column — a chart that read as a block of bars, with
 * nothing to say how high any of them were. The curve says the total; the
 * dots say which days moved it; the two gridlines say what the height means.
 *
 * SVG through `react-native-svg`, which the app already carries for its icons
 * (`design/components/icons/primitives.tsx`) and drawings. The path is drawn
 * in a fixed 1000×100 box and stretched to the view (`preserveAspectRatio`
 * `none`), with `vectorEffect` holding the stroke at two points whatever the
 * stretch — so the chart needs no measurement before it can paint. Dots and
 * labels are ordinary views over the top, positioned in percentages, so they
 * never stretch with the box.
 *
 * The geometry is `curveGeometry` and `niceTop` in `./growth`, tested there.
 */

import { useId } from "react";
import { StyleSheet, View } from "react-native";
import { Defs, LinearGradient, Line, Path, Stop, Svg } from "react-native-svg";
import { Text, leading, radii, space, useColors, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { formatCount, shortDay, type Point } from "./report";
import { CURVE_BOX, curveGeometry, niceTop } from "./growth";

const CHART_HEIGHT = 132;

export function GrowthArea({
  cumulative,
  added,
  testID,
}: {
  cumulative: readonly Point[];
  added: readonly Point[];
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  // A gradient id per chart: two on one page must not share one, and an id
  // from `useId` carries colons that a `url(#…)` reference will not parse.
  const gradient = `growth-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const max = cumulative.reduce((best, point) => Math.max(best, point.count), 0);
  const top = niceTop(max);
  const geometry = curveGeometry(
    cumulative.map((point) => point.count),
    top,
  );
  const arrivedOn = new Map(added.map((point) => [point.day, point.count]));
  const first = cumulative[0];
  const last = cumulative[cumulative.length - 1];

  return (
    <View testID={testID}>
      <View style={styles.chart} accessibilityLabel={describeCurve(cumulative, added)}>
        {[1, 0.5].map((share) => (
          <View key={share} style={[styles.grid, { top: `${(1 - share) * 100}%` }]}>
            <Text style={styles.gridLabel}>{formatCount(top * share)}</Text>
          </View>
        ))}
        <Svg
          // Both sizes, not only the absolute fill: an `<svg>` with a viewBox
          // and no height takes its height from the box's aspect ratio, which
          // at 10:1 drew the curve in the top tenth of the chart.
          width="100%"
          height="100%"
          style={StyleSheet.absoluteFill}
          viewBox={`0 0 ${CURVE_BOX.width} ${CURVE_BOX.height}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          <Defs>
            <LinearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.accent} stopOpacity={0.2} />
              <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Path d={geometry.area} fill={`url(#${gradient})`} />
          <Line
            x1={0}
            y1={CURVE_BOX.height}
            x2={CURVE_BOX.width}
            y2={CURVE_BOX.height}
            stroke={colors.lineStrong}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <Path
            d={geometry.line}
            fill="none"
            stroke={colors.accent}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </Svg>
        {cumulative.map((point, index) => {
          const at = geometry.points[index];
          const isLast = index === cumulative.length - 1;
          const arrivals = arrivedOn.get(point.day) ?? 0;
          if (!isLast && arrivals === 0) return null;
          return (
            <View
              key={point.day}
              aria-hidden
              style={[
                isLast ? styles.today : styles.dot,
                { left: `${at.left}%`, top: `${at.top}%` },
              ]}
            >
              {!isLast && arrivals > 1 ? (
                <Text style={styles.dotCount}>{formatCount(arrivals)}</Text>
              ) : null}
            </View>
          );
        })}
      </View>
      <View style={styles.axis}>
        <Text variant="meta">{first ? shortDay(first.day) : ""}</Text>
        <Text variant="meta">{last ? shortDay(last.day) : ""}</Text>
      </View>
    </View>
  );
}

/** The flat, empty version: a baseline, the gridlines, and what to say. */
export function EmptyGrowthArea({ message }: { message: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.chart}>
      <View style={[styles.grid, { top: 0 }]} />
      <View style={[styles.grid, { top: "50%" }]} />
      <View style={styles.baseline} />
      <View style={styles.emptyWrap}>
        <Text variant="paneSub">{message}</Text>
      </View>
    </View>
  );
}

/**
 * What stands where the curve would be while the census is truncated — the
 * rule `TruncatedNotice` states: a cumulative line missing an arbitrary slice
 * of its rows is a different shape, not a rough one, so none is drawn.
 */
export function WithheldGrowthArea() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.withheld}>
      <Text variant="meta">Curve hidden while the census is truncated</Text>
    </View>
  );
}

export function describeCurve(cumulative: readonly Point[], added: readonly Point[]): string {
  if (cumulative.length === 0) return "No days.";
  const first = cumulative[0];
  const last = cumulative[cumulative.length - 1];
  const arrivals = added.reduce((sum, point) => sum + point.count, 0);
  const movedOn = added.filter((point) => point.count > 0).length;
  return `${formatCount(first.count)} on ${shortDay(first.day)}, rising to ${formatCount(
    last.count,
  )} on ${shortDay(last.day)}. ${formatCount(arrivals)} arrived across ${movedOn} of ${
    cumulative.length
  } days.`;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    chart: { height: CHART_HEIGHT, marginTop: 6, position: "relative" },
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
      fontSize: pointerType.label,
      lineHeight: leading(pointerType.label, 1.3),
      color: colors.heroDim,
      fontVariant: ["tabular-nums"],
    },
    baseline: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: 1,
      backgroundColor: colors.lineStrong,
    },
    dot: {
      position: "absolute",
      width: 7,
      height: 7,
      marginLeft: -3.5,
      marginTop: -3.5,
      borderRadius: radii.pill,
      borderWidth: 1.5,
      borderColor: colors.accent,
      backgroundColor: colors.surface2,
    },
    dotCount: {
      position: "absolute",
      bottom: 7,
      left: -8,
      width: 20,
      textAlign: "center",
      fontSize: pointerType.label,
      lineHeight: leading(pointerType.label, 1.1),
      fontWeight: "600",
      color: colors.accentText,
    },
    today: {
      position: "absolute",
      width: 11,
      height: 11,
      marginLeft: -5.5,
      marginTop: -5.5,
      borderRadius: radii.pill,
      backgroundColor: colors.accent,
      boxShadow: `0 0 0 4px ${colors.accentDim}`,
    },
    axis: { flexDirection: "row", justifyContent: "space-between", marginTop: space.x2 },
    emptyWrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
    withheld: {
      height: 96,
      marginTop: 6,
      borderRadius: radii.xs,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.lineStrong,
      alignItems: "center",
      justifyContent: "center",
    },
  });
