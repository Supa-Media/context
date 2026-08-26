import { useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Line } from "../../design/components/Line";
import { Text } from "../../design/components/Text";
import { colors, fonts, graphColors, layout, radii, tracking } from "../../design/tokens";
import { describeGraph } from "./describe";
import { Glow } from "./Glow";
import {
  LABEL_OFFSET,
  SUBLABEL_OFFSET,
  layoutGraph,
  type MapGraph,
} from "./layout";

/**
 * The constellation: you at the centre, contexts orbiting, and each AI client
 * hanging off whichever context granted it.
 *
 * The mockup draws this on a `<canvas>`. `react-native-svg` is not a dependency
 * of this app, so every stroke is a rotated `View` (`design/components/Line`)
 * and every node is a bordered circle. The maths lives in `layout.ts` and is
 * tested there; this file only places what it is told to place.
 *
 * The picture carries meaning, so it is described for anyone who cannot see it:
 * the container is a labelled image with a text summary rather than a silent
 * decorative box.
 */
export function ConstellationMap({ graph }: { graph: MapGraph }) {
  const [width, setWidth] = useState(0);
  const height = layout.mapHeight;

  const onLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    if (next !== width) setWidth(next);
  };

  const placed = width > 0 ? layoutGraph(graph, { width, height }) : null;

  return (
    <View style={styles.wrap}>
      <View
        style={[styles.field, { height }]}
        onLayout={onLayout}
        role="img"
        aria-label={describeGraph(graph)}
      >
        {placed?.edges.map((edge, index) => (
          <Line
            key={`edge-${index}`}
            from={edge.from}
            to={edge.to}
            color={graphColors[edge.kind]}
            thickness={edge.thickness}
            opacity={edge.opacity}
            dashed={edge.dashed}
          />
        ))}

        {placed?.nodes.map((node) => {
          const color = graphColors[node.kind];
          const isYou = node.kind === "you";
          return (
            <View key={node.id} aria-hidden>
              <Glow cx={node.cx} cy={node.cy} radius={node.glowRadius} color={color} />
              <View
                style={[
                  styles.node,
                  {
                    left: node.cx - node.r,
                    top: node.cy - node.r,
                    width: node.r * 2,
                    height: node.r * 2,
                    borderRadius: node.r,
                    borderWidth: node.strokeWidth,
                    borderColor: color,
                    backgroundColor: isYou ? colors.white : colors.surface,
                  },
                ]}
              >
                {isYou ? <Text style={styles.youLabel}>{node.label}</Text> : null}
              </View>

              {isYou ? null : (
                <View
                  style={[
                    styles.labelBlock,
                    { left: node.cx - 110, top: node.cy + node.r + LABEL_OFFSET - 12 },
                  ]}
                >
                  <Text style={styles.nodeLabel}>{node.label}</Text>
                  {node.sub ? <Text style={styles.nodeSub}>{node.sub}</Text> : null}
                </View>
              )}
            </View>
          );
        })}
      </View>

      <View style={styles.legend} aria-hidden>
        <LegendItem color={graphColors.own} label="owner" />
        <LegendItem color={graphColors.team} label="team access" dashed />
        <LegendItem color={graphColors.client} label="client grant" />
      </View>
    </View>
  );
}

function LegendItem({
  color,
  label,
  dashed = false,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <View style={styles.legendItem}>
      <View
        style={[
          styles.legendSwatch,
          { borderTopColor: color, borderStyle: dashed ? "dashed" : "solid" },
        ]}
      />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  /** `.mapwrap` */
  wrap: {
    position: "relative",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.panel,
    backgroundColor: colors.well,
    overflow: "hidden",
  },
  /** `#map` */
  field: {
    position: "relative",
    width: "100%",
  },
  node: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  youLabel: {
    fontFamily: fonts.display,
    fontSize: 12,
    fontWeight: "600",
    color: colors.ink,
  },
  labelBlock: {
    position: "absolute",
    width: 220,
    alignItems: "center",
  },
  nodeLabel: {
    fontFamily: fonts.display,
    fontSize: 12.5,
    // The two baselines are 15px apart on the canvas
    // (`SUBLABEL_OFFSET - LABEL_OFFSET`); with no margin between them, that is
    // exactly the label's line box.
    lineHeight: SUBLABEL_OFFSET - LABEL_OFFSET,
    fontWeight: "600",
    color: colors.text,
    textAlign: "center",
  },
  nodeSub: {
    fontFamily: fonts.body,
    fontSize: 11,
    lineHeight: 14,
    color: colors.muted,
    textAlign: "center",
  },
  /** `.legend` */
  legend: {
    position: "absolute",
    left: 15,
    bottom: 13,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 17,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  legendSwatch: {
    width: 17,
    height: 0,
    borderTopWidth: 1.5,
  },
  legendLabel: {
    fontFamily: fonts.body,
    fontSize: 11.5,
    color: colors.muted,
    letterSpacing: tracking(11.5, 0),
  },
});
