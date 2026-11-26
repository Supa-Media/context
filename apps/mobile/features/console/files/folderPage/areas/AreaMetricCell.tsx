/**
 * An area's one metric as the Areas List draws it, trimmed for people who do
 * not live in the numbers (the owner, 2026-11-26: "cofounders complaining that
 * this is just a wall of text"; the approved trimmed list, option A): the
 * latest value, coloured by how it stands, then the goal in words and the
 * metric's name, `186 aim 100+ · Weekly deploys`; and, in a column of its own,
 * one verdict in words with a mark (`verdict.ts`). The trend, the time-range
 * tag, the sources and the dates live in the area's side panel and the hover
 * tip, not on the row. With no value yet, just the name and the goal. An area
 * with no metric leaves the cell blank; picking one lives in the area's side
 * panel and its ⋯ menu (the owner, 2026-11-25).
 */

import { useRef } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { useHoverTitle } from "../../../../design/useHoverTitle";
import { areasType, pointerType } from "../../../../design/tokens";
import type { Headline } from "./headline";
import type { Verdict } from "./verdict";

/** The words a hover tip says about a metric: its name, time range, sources, target and date. */
export function metricTip(headline: Headline): string {
  return `${headline.label}${headline.period === "" ? "" : ` (${headline.period})`}${headline.source === "" ? "" : ` · ${headline.source}`}${headline.target === "" ? "" : `, target ${headline.target}`}${headline.date === "" ? "" : `, ${headline.date}`}`;
}

/** The headline metric on a pointer: value, goal and name on one line. */
export function MetricCell({ headline }: { headline: Headline }) {
  const styles = useThemedStyles(makeStyles);
  const ref = useRef<View>(null);
  useHoverTitle(ref, metricTip(headline));
  return (
    <View ref={ref} style={styles.metric} testID="area-metric">
      <MetricLine headline={headline} size={pointerType.ui} />
    </View>
  );
}

/** The headline metric in a phone's block: the same line, a size up. */
export function PhoneMetric({ headline }: { headline: Headline }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.metric} testID="area-metric">
      <MetricLine headline={headline} size={areasType.value} />
    </View>
  );
}

function MetricLine({ headline, size }: { headline: Headline; size: number }) {
  const styles = useThemedStyles(makeStyles);
  const rest = [headline.goal, headline.label].filter((part) => part !== "").join(" · ");
  return (
    <Text variant="tree" style={[styles.line, { fontSize: size - 1, lineHeight: size + 5 }]} numberOfLines={1}>
      {headline.value === null ? null : (
        <>
          <Value headline={headline} size={size} />
          {" "}
        </>
      )}
      <Text variant="tree" style={[styles.rest, { fontSize: size - 1, lineHeight: size + 5 }]} testID={headline.value === null ? "area-row-target" : "area-row-goal"}>
        {rest}
      </Text>
    </Text>
  );
}

/** The latest value, green when the verdict is good and amber when not; muted when Hidden or still being worked out. */
function Value({ headline, size }: { headline: Headline; size: number }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const quiet = headline.status === "hidden" || headline.status === "loading";
  const ink = quiet ? colors.muted : headline.state === "met" ? colors.okText : headline.state === "missed" ? colors.warnText : colors.text;
  return (
    <Text variant="tree" style={[styles.value, quiet && styles.quietValue, { fontSize: size, lineHeight: size + 5, color: ink }]} testID="area-row-value">
      {headline.value}
    </Text>
  );
}

/**
 * A verdict in words with a mark, so it never rests on colour alone: a dot
 * for on target and on pace, a dot with a soft ring for exceeds, a hollow
 * ring for under target, a bar for needs a look.
 */
export function VerdictMark({ verdict, size = pointerType.meta }: { verdict: Verdict; size?: number }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const ink = verdict.good ? colors.okText : colors.warnText;
  const fill = verdict.good ? colors.ok : colors.warn;
  const mark =
    verdict.kind === "exceeds"
      ? [styles.ringDot, { backgroundColor: fill, borderColor: colors.okBorder }]
      : verdict.kind === "under"
        ? [styles.dot, { borderColor: fill, borderWidth: 2, backgroundColor: "transparent" }]
        : verdict.kind === "over"
          ? [styles.bar, { backgroundColor: fill }]
          : [styles.dot, { backgroundColor: fill }];
  return (
    <View style={styles.verdict} testID={`area-verdict-${verdict.kind}`} accessibilityLabel={verdict.words}>
      <View style={mark} />
      <Text variant="treeMeta" style={[styles.verdictWords, { color: ink, fontSize: size, lineHeight: size + 4 }]} numberOfLines={1}>
        {verdict.words}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    metric: { minWidth: 0 },
    line: { color: colors.muted, minWidth: 0 },
    rest: { color: colors.muted },
    value: { fontWeight: "600" },
    quietValue: { fontWeight: "500" },
    verdict: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
    dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
    ringDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, flexShrink: 0, marginHorizontal: -2 },
    bar: { width: 9, height: 3, borderRadius: 2, flexShrink: 0 },
    verdictWords: { fontWeight: "600", flexShrink: 1, minWidth: 0 },
  });
