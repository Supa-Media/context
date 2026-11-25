/**
 * A metric's readings over its last periods (board 12): a line with a dot on
 * each period, three quiet gridlines labelled on the left, the area's target
 * as a dashed line named on the right, and the periods along the bottom.
 * Coloured as the Areas page colours a trend: green on target, amber off it.
 */

import { useState } from "react";
import { View } from "react-native";
import { Circle, Line, Polyline, Svg, Text as SvgText } from "react-native-svg";
import { formatValue } from "../../../../../mcp/src/data/formula/index.js";
import { useColors } from "../../../design/theme";
import type { TargetState } from "./workOut";

const H = 150;
const LEFT = 30;
const BOTTOM = 20;
const TOP = 8;

/** A gridline label: whole units in the metric's own format. */
function tickText(value: number, format: string): string {
  if (format.startsWith("$")) return formatValue(value, "$0") as string;
  if (format.endsWith("%")) return formatValue(value, "0%") as string;
  if (format === "duration") return formatValue(value, "duration") as string;
  return formatValue(value, "0") as string;
}

/** A round top for the scale: 9.4 → 10, 1436 → 1500, 0.022 → 0.025. */
export function niceTop(max: number): number {
  if (!(max > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * step >= max) return m * step;
  return 10 * step;
}

export function ReadingsChart({
  values,
  labels,
  target,
  targetLabel,
  state,
  format,
}: {
  /** One per period, oldest first; null where a period has no value. */
  values: readonly (number | null)[];
  labels: readonly string[];
  target: number | null;
  targetLabel: string | null;
  state: TargetState;
  format: string;
}) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const known = values.filter((v): v is number => v !== null);
  const low = Math.min(0, ...known, ...(target === null ? [] : [target]));
  const top = niceTop(Math.max(...known, ...(target === null ? [] : [target]), 0));
  const ink = state === "met" ? colors.ok : state === "missed" ? colors.warn : colors.muted;
  const n = Math.max(values.length, 2);
  const x = (i: number) => LEFT + (i * (width - LEFT - 10)) / (n - 1);
  const y = (v: number) => TOP + (H - BOTTOM - TOP) * (1 - (v - low) / (top - low || 1));
  const points = values
    .map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
    .filter((p): p is string => p !== null)
    .join(" ");
  const ticks = [low, (low + top) / 2, top];
  return (
    <View style={{ height: H }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)} testID="metric-readings-chart">
      {width === 0 ? null : (
        <Svg width={width} height={H} viewBox={`0 0 ${width} ${H}`}>
          {ticks.map((tick) => (
            <Line key={`g${tick}`} x1={LEFT} x2={width - 4} y1={y(tick)} y2={y(tick)} stroke={colors.line} strokeWidth={1} />
          ))}
          {ticks.map((tick) => (
            <SvgText key={`t${tick}`} x={LEFT - 6} y={y(tick) + 4} textAnchor="end" fontSize={10} fill={colors.chromeMuted}>
              {tickText(tick, format)}
            </SvgText>
          ))}
          {target === null ? null : (
            <>
              <Line x1={LEFT} x2={width - 4} y1={y(target)} y2={y(target)} stroke={colors.muted} strokeWidth={1} strokeDasharray="3 3" />
              {targetLabel === null ? null : (
                <SvgText x={width - 6} y={y(target) - 5} textAnchor="end" fontSize={10} fill={colors.muted}>
                  {targetLabel}
                </SvgText>
              )}
            </>
          )}
          {points === "" ? null : <Polyline points={points} fill="none" stroke={ink} strokeWidth={2} strokeLinejoin="round" />}
          {values.map((v, i) => (v === null ? null : <Circle key={`p${i}`} cx={x(i)} cy={y(v)} r={3} fill={ink} />))}
          {labels.map((label, i) => (
            <SvgText key={`l${i}`} x={x(i)} y={H - 4} textAnchor="middle" fontSize={10} fill={colors.chromeMuted}>
              {label}
            </SvgText>
          ))}
        </Svg>
      )}
    </View>
  );
}
