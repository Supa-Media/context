/**
 * An area's headline metric as a small trend: its recent readings as a line,
 * the target as a dashed line across it, and a dot on the latest reading,
 * green on target and amber off it. The owner chose this look on 2026-11-24
 * (the "E Trend" board of the Areas redesign); the list and the chart draw
 * the same mark at their own sizes.
 *
 * The geometry is the board's: readings and the target share one scale,
 * padded 12% so neither touches an edge, drawn into a 56×20 box seen through
 * a viewBox 3 wider each side, then stretched to the size asked for.
 */

import { Circle, Line, Polyline, Svg } from "react-native-svg";
import { useColors } from "../../../../design/theme";
import type { TargetState } from "./readings";

export interface TrendGeometry {
  readonly points: string;
  /** The target line's y, or null when the target has no number. */
  readonly targetY: number | null;
  readonly lastX: number;
  readonly lastY: number;
}

const W = 56;
const H = 20;

/** Null when there are fewer than two readings: one point is not a line. */
export function trendGeometry(series: readonly number[], target: number | null): TrendGeometry | null {
  if (series.length < 2) return null;
  const values = target === null ? [...series] : [...series, target];
  let low = Math.min(...values);
  let high = Math.max(...values);
  const pad = (high - low) * 0.12 || 1;
  low -= pad;
  high += pad;
  const y = (v: number) => Number((H - ((v - low) / (high - low)) * H).toFixed(1));
  const n = series.length;
  return {
    points: series.map((v, i) => `${((i * W) / (n - 1)).toFixed(1)},${y(v)}`).join(" "),
    targetY: target === null ? null : y(target),
    lastX: W,
    lastY: y(series[n - 1]!),
  };
}

export interface TrendProps {
  geometry: TrendGeometry;
  state: TargetState;
  width: number;
  height: number;
  /** The line's weight, the dash and the dot, before the stretch. */
  stroke?: number;
  dash?: string;
  dashWidth?: number;
  dot?: number;
}

export function Trend({ geometry, state, width, height, stroke = 1.6, dash = "2 2", dashWidth = 1, dot = 2.6 }: TrendProps) {
  const colors = useColors();
  const ink = state === "met" ? colors.ok : state === "missed" ? colors.warn : colors.muted;
  return (
    <Svg width={width} height={height} viewBox="-3 -3 62 26" preserveAspectRatio="none" aria-hidden testID="area-trend">
      {geometry.targetY === null ? null : (
        <Line x1={-3} x2={59} y1={geometry.targetY} y2={geometry.targetY} stroke={colors.muted} strokeWidth={dashWidth} strokeDasharray={dash} testID="area-trend-target" />
      )}
      <Polyline points={geometry.points} fill="none" stroke={ink} strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={geometry.lastX} cy={geometry.lastY} r={dot} fill={ink} />
    </Svg>
  );
}
