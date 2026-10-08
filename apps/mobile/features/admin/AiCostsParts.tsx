/**
 * The small pieces the AI costs tab is built from: a headline tile, a bar
 * split by feature, a feature's colour swatch and a heading inside a panel.
 *
 * Every colour is a token from `useToneColor` (the console's series palette);
 * nothing here names a hex value.
 */

import { StyleSheet, View } from "react-native";
import { Card, Text, leading, radii, space, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { useCompact } from "./AdminKit";
import { useToneColor } from "./Charts";
import type { SegmentTone } from "./report";
import type { SplitPart } from "./aiCosts";

export type ChangeTone = "warn" | "ok" | "neutral" | "crit";

/** A headline figure: a label, the figure, and a line under it. */
export function CostTile({
  label,
  value,
  sub,
  tone = "neutral",
  small = false,
  testID,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: ChangeTone;
  /** For a figure that is a name rather than a number. */
  small?: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const subStyle = tone === "warn" ? styles.warn : tone === "ok" ? styles.good : tone === "crit" ? styles.bad : null;
  return (
    <Card style={StyleSheet.flatten([styles.tile, compact && styles.tileCompact])} testID={testID}>
      <Text variant="eyebrow">{label}</Text>
      <Text style={small ? styles.name : styles.big} numberOfLines={small ? 2 : 1}>
        {value}
      </Text>
      <Text variant="meta" style={subStyle}>
        {sub}
      </Text>
    </Card>
  );
}

/** One bar, cut into its features in their colours. An empty part draws nothing. */
export function SplitBar({ parts }: { parts: readonly SplitPart[] }) {
  const styles = useThemedStyles(makeStyles);
  const toneColor = useToneColor();
  return (
    <View style={styles.track} aria-hidden>
      {parts.map((part) => (
        <View key={part.feature} style={{ flexGrow: part.fraction, flexBasis: 0, backgroundColor: toneColor(part.tone) }} />
      ))}
    </View>
  );
}

/** The little square a feature is known by, in its colour. */
export function Swatch({ tone }: { tone: SegmentTone }) {
  const styles = useThemedStyles(makeStyles);
  const toneColor = useToneColor();
  return <View style={[styles.swatch, { backgroundColor: toneColor(tone) }]} aria-hidden />;
}

/** A heading inside a panel, a step smaller than the panel's own. */
export function SubHead({ children, first = false }: { children: string; first?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <Text
      variant="rowTitle"
      role="heading"
      aria-level={3}
      style={[styles.subHead, compact && styles.subHeadCompact, first && styles.subHeadFirst]}
    >
      {children}
    </Text>
  );
}

/** A fraction of a bar, drawn as a track with a fill: a capped use today. */
export function MeterBar({ fraction, tone }: { fraction: number; tone: SegmentTone }) {
  const styles = useThemedStyles(makeStyles);
  const toneColor = useToneColor();
  return (
    <View style={styles.meter} aria-hidden>
      <View style={{ width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`, height: "100%", backgroundColor: toneColor(tone), borderRadius: radii.pill }} />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    tile: { flexGrow: 1, flexBasis: 200, gap: 6 },
    tileCompact: { flexBasis: "47%", flexGrow: 0 },
    big: {
      fontSize: pointerType.title,
      lineHeight: leading(pointerType.title, 1.2),
      fontWeight: "600",
      letterSpacing: -0.9,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    name: {
      fontSize: pointerType.lede,
      lineHeight: leading(pointerType.lede, 1.3),
      fontWeight: "600",
      color: colors.text,
    },
    good: { color: colors.okText },
    warn: { color: colors.warnText },
    bad: { color: colors.critText },
    track: {
      flexDirection: "row",
      width: "100%",
      height: 6,
      borderRadius: 3,
      overflow: "hidden",
      backgroundColor: colors.line,
    },
    meter: { height: 6, width: "100%", borderRadius: radii.pill, overflow: "hidden", backgroundColor: colors.line },
    swatch: { width: 8, height: 8, borderRadius: 2 },
    subHead: { marginTop: space.x4, marginBottom: space.x2, paddingHorizontal: space.x5 },
    subHeadCompact: { paddingHorizontal: space.x4 },
    subHeadFirst: { marginTop: 0 },
  });
