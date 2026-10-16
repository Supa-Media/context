/**
 * A job's "Score over time" (board 9): live's score in every run of the job, as
 * one line on a 50%–100% scale, with the bar drawn dashed and each promotion
 * marked. Every run keeps its place on the x axis even when its score is
 * unknown; that run is simply not drawn.
 *
 * Drawn in one SVG that scales to the box it sits in, measured on layout, so
 * it paints at the right width on a phone and on a pointer.
 */

import { useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Circle, Line, Polyline, Svg, Text as SvgText } from "react-native-svg";
import { Text, useColors, useThemedStyles, type Colors } from "../design";
import { fonts, pointerType } from "../design/tokens";
import type { ScorePoint } from "./aiModel";

const HEIGHT = 160;
const DEFAULT_WIDTH = 600;
/** Room on the left for the y labels, on the right for the bar's label, above for "promoted", below for the run labels. */
const PAD = { left: 44, right: 40, top: 26, bottom: 26 };
const FLOOR = 50;
const CEILING = 100;
/** Enough room for a run label before the next one is dropped. */
const LABEL_WIDTH = 50;

export function AiScoreChart({ points, bar }: { points: readonly ScorePoint[]; bar: number }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  if (points.length === 0) return <Text variant="meta" style={styles.empty}>No runs yet.</Text>;

  const onLayout = (event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.width);
    if (measured > 0 && measured !== width) setWidth(measured);
  };

  const plotLeft = PAD.left;
  const plotRight = width - PAD.right;
  const plotTop = PAD.top;
  const plotBottom = HEIGHT - PAD.bottom;
  const plotWidth = plotRight - plotLeft;
  const clamp = (value: number) => Math.min(CEILING, Math.max(FLOOR, value));
  const xAt = (index: number) => (points.length === 1 ? plotLeft + plotWidth / 2 : plotLeft + (index / (points.length - 1)) * plotWidth);
  const yAt = (score: number) => plotTop + (1 - (clamp(score) - FLOOR) / (CEILING - FLOOR)) * (plotBottom - plotTop);

  const drawn = points.flatMap((point, index) => (point.score === null ? [] : [{ x: xAt(index), y: yAt(point.score), point }]));
  // Thin the run labels when there are more runs than fit, always keeping the last.
  const stride = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotWidth / LABEL_WIDTH))));
  const scored = points.filter((point) => point.score !== null).length;

  return (
    <View style={styles.wrap} onLayout={onLayout} accessibilityLabel={`Score over time: ${scored} of ${points.length} runs scored, bar ${bar}%`} testID="admin-ai-score-chart">
      <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`}>
        {[CEILING, FLOOR].map((value) => (
          <Line key={`grid-${value}`} x1={plotLeft} x2={plotRight} y1={yAt(value)} y2={yAt(value)} stroke={colors.line} strokeWidth={1} />
        ))}
        {[CEILING, FLOOR].map((value) => (
          <SvgText key={`label-${value}`} x={plotLeft - 8} y={yAt(value) + 4} fontSize={pointerType.label} fontFamily={fonts.body} fill={colors.muted} textAnchor="end">
            {`${value}%`}
          </SvgText>
        ))}
        <Line x1={plotLeft} x2={plotRight} y1={yAt(bar)} y2={yAt(bar)} stroke={colors.warnText} strokeWidth={1} strokeDasharray="4 4" />
        <SvgText x={plotRight + 6} y={yAt(bar) + 4} fontSize={pointerType.label} fontFamily={fonts.body} fill={colors.warnText}>
          bar
        </SvgText>
        {drawn.length > 1 ? (
          <Polyline points={drawn.map((item) => `${item.x},${item.y}`).join(" ")} fill="none" stroke={colors.accent} strokeWidth={2} />
        ) : null}
        {drawn.map((item) => (
          <Circle key={item.point.path} cx={item.x} cy={item.y} r={item.point.promoted ? 5 : 3.5} fill={colors.accent} />
        ))}
        {drawn
          .filter((item) => item.point.promoted)
          .map((item) => (
            <SvgText key={`promoted-${item.point.path}`} x={item.x} y={item.y - 10} fontSize={pointerType.label} fontFamily={fonts.body} fill={colors.accent} textAnchor="middle">
              ▲ promoted
            </SvgText>
          ))}
        {points.map((point, index) =>
          index % stride === 0 || index === points.length - 1 ? (
            <SvgText key={`run-${point.path}`} x={xAt(index)} y={HEIGHT - 8} fontSize={pointerType.label} fontFamily={fonts.body} fill={colors.muted} textAnchor="middle">
              {point.label}
            </SvgText>
          ) : null,
        )}
      </Svg>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { width: "100%", minWidth: 0 },
    empty: { color: colors.muted },
  });
