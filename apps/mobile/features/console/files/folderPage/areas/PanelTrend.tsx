/**
 * The trend at the panel's width. `Trend` stretches its small box to the size
 * asked for, which is right for the list's 56 but would smear the line, the
 * dashes and the dot across a panel; this lays the same points out in the
 * panel's own pixels instead.
 *
 * Hovering (or tapping) along it shows the nearest point's value and date
 * above it (the owner, 2026-11-26: "when hovering over the timeline we should
 * see the value and the date please"). Every point owns the strip of the
 * chart nearest it, its full height, so anywhere over the chart picks one.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Circle, Line, Polyline, Svg } from "react-native-svg";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { TrendGeometry } from "./Trend";
import type { TrendPoint } from "./trendPoints";

const TIP_WIDTH = 132;

/**
 * Each point's hover strip, `{ left, width }`: from halfway to the point
 * before it to halfway to the one after, the first from the chart's left edge
 * and the last to its right, so the strips tile the whole width.
 */
export function hitStrips(xs: readonly number[], width: number): { left: number; width: number }[] {
  return xs.map((x, i) => {
    const left = i === 0 ? 0 : (xs[i - 1]! + x) / 2;
    const right = i === xs.length - 1 ? width : (x + xs[i + 1]!) / 2;
    return { left, width: Math.max(0, right - left) };
  });
}

export function PanelTrend({ geometry, points, ink, width, height }: { geometry: TrendGeometry; points: readonly TrendPoint[]; ink: string; width: number; height: number }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [picked, setPicked] = useState<number | null>(null);
  // `Trend`'s box: 56×20 seen through a viewBox 3 wider each side.
  const x = (value: number) => ((value + 3) / 62) * width;
  const y = (value: number) => ((value + 3) / 26) * height;
  const at = geometry.points.split(" ").map((pair) => {
    const [px, py] = pair.split(",").map(Number);
    return { x: x(px ?? 0), y: y(py ?? 0) };
  });
  const line = at.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const hoverable = points.length === at.length && at.length > 1;
  const spot = picked === null || !hoverable ? null : at[picked];
  const tip = picked === null || !hoverable ? null : points[picked];
  const strips = hoverable ? hitStrips(at.map((p) => p.x), width) : [];
  return (
    <View style={{ width, height }} testID="area-panel-trend-box">
      <Svg width={width} height={height} aria-hidden testID="area-panel-trend">
        {geometry.targetY === null ? null : (
          <Line x1={0} x2={width} y1={y(geometry.targetY)} y2={y(geometry.targetY)} stroke={colors.muted} strokeWidth={1} strokeDasharray="4 4" />
        )}
        <Polyline points={line} fill="none" stroke={ink} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {spot == null ? null : <Line x1={spot.x} x2={spot.x} y1={0} y2={height} stroke={colors.line} strokeWidth={1} />}
        <Circle cx={x(geometry.lastX)} cy={y(geometry.lastY)} r={3.5} fill={ink} />
        {spot == null ? null : <Circle cx={spot.x} cy={spot.y} r={4} fill={colors.surface} stroke={ink} strokeWidth={2} />}
      </Svg>
      {!hoverable
        ? null
        : strips.map((strip, i) => (
            <Pressable
              key={i}
              onHoverIn={() => setPicked(i)}
              onHoverOut={() => setPicked((now) => (now === i ? null : now))}
              onPress={() => setPicked((now) => (now === i ? null : i))}
              accessibilityLabel={`${points[i]!.value}${points[i]!.date === "" ? "" : `, ${points[i]!.date}`}`}
              style={[styles.hit, { left: strip.left, width: strip.width, height }]}
              testID={`area-panel-trend-point-${i}`}
            />
          ))}
      {spot == null || tip == null ? null : (
        <View
          style={[styles.tip, { left: Math.min(Math.max(0, spot.x - TIP_WIDTH / 2), Math.max(0, width - TIP_WIDTH)), ...(spot.y > 30 ? { bottom: height - spot.y + 8 } : { top: spot.y + 8 }) }]}
          testID="area-panel-trend-tip"
        >
          <Text variant="treeMeta" style={styles.tipValue} numberOfLines={1}>{tip.value}</Text>
          {tip.date === "" ? null : <Text variant="treeMeta" style={styles.tipDate} numberOfLines={1}>{tip.date}</Text>}
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    hit: { position: "absolute", top: 0 },
    tip: {
      position: "absolute",
      pointerEvents: "none",
      width: TIP_WIDTH,
      alignItems: "center",
      paddingVertical: space.x1,
      paddingHorizontal: space.x2,
      borderRadius: radii.sm,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.line,
    },
    tipValue: { color: colors.text, fontWeight: "600" },
    tipDate: { color: colors.muted },
  });
