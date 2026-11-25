/**
 * An area's one metric as the Areas List draws it (the data sources board,
 * 06; the area metric rows board, 2026-11-25): its name and a small tag for
 * the time range the number covers ("7d", "MTD", "today"); then the trend,
 * the latest value in green or amber (muted when Hidden or still being worked
 * out) and the target in symbols; with no value yet, just the target, and no
 * placeholder (the owner, 2026-11-25). The sources a workspace metric reads
 * and how fresh they are stay off the row, in its hover tip and on the
 * metric's page. An area with no metric leaves the cell blank; picking one
 * lives in the area's side panel and its ⋯ menu (the owner, 2026-11-25).
 */

import { useRef } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { useHoverTitle } from "../../../../design/useHoverTitle";
import { areasType, pointerType, radii } from "../../../../design/tokens";
import type { Headline } from "./headline";
import { Trend } from "./Trend";

/** The headline metric on a pointer: its label line, then the trend, the value and the target on one line. */
export function MetricCell({ headline }: { headline: Headline }) {
  const styles = useThemedStyles(makeStyles);
  const ref = useRef<View>(null);
  const tip = `${headline.label}${headline.period === "" ? "" : ` (${headline.period})`}${headline.source === "" ? "" : ` · ${headline.source}`}${headline.target === "" ? "" : `, target ${headline.target}`}${headline.date === "" ? "" : `, ${headline.date}`}`;
  useHoverTitle(ref, tip);
  return (
    <View ref={ref} style={styles.metric} testID="area-metric">
      <Label headline={headline} />
      {headline.value === null ? (
        headline.target === "" ? null : (
          <Text variant="tree" style={styles.noData} numberOfLines={1} testID="area-row-target">
            {`target ${headline.target}`}
          </Text>
        )
      ) : (
        <View style={styles.valueLine}>
          {headline.trend === null ? null : <Trend geometry={headline.trend} state={headline.state} width={56} height={16} stroke={1.4} dot={2.2} />}
          <Value headline={headline} size={pointerType.ui} />
          <Text variant="treeMeta" style={styles.target} numberOfLines={1}>
            {headline.target}
          </Text>
        </View>
      )}
    </View>
  );
}

/** The headline metric in a phone's block: the label and its period, then the value line. */
export function PhoneMetric({ headline }: { headline: Headline }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.phone} testID="area-metric">
      <Label headline={headline} />
      {headline.value === null ? (
        headline.target === "" ? null : (
          <Text variant="tree" style={styles.noDataPhone} numberOfLines={1} testID="area-row-target">
            {`target ${headline.target}`}
          </Text>
        )
      ) : (
        <View style={styles.valueLinePhone}>
          {headline.trend === null ? null : (
            <Trend geometry={headline.trend} state={headline.state} width={56} height={18} stroke={1.8} dash="3 3" dashWidth={1.2} dot={2.8} />
          )}
          <Value headline={headline} size={areasType.value} />
          <Text variant="treeMeta" style={styles.target} numberOfLines={1}>
            {headline.target}
          </Text>
        </View>
      )}
    </View>
  );
}

/** The metric's name, cut short when it must be, then its period tag, which is never cut. */
function Label({ headline }: { headline: Headline }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.labelLine}>
      <Text variant="treeMeta" style={[styles.metricLabel, styles.labelName]} numberOfLines={1}>
        {headline.label}
      </Text>
      {headline.period === "" ? null : (
        <Text variant="treeMeta" style={styles.period} numberOfLines={1} testID="area-metric-period">
          {headline.period}
        </Text>
      )}
    </View>
  );
}

/** The latest value, green on target and amber off it; muted when Hidden or still being worked out. */
function Value({ headline, size }: { headline: Headline; size: number }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const quiet = headline.status === "hidden" || headline.status === "loading";
  const ink = quiet ? colors.muted : headline.state === "met" ? colors.okText : headline.state === "missed" ? colors.warnText : colors.text;
  return (
    <Text variant="tree" style={[styles.value, quiet && styles.quietValue, { fontSize: size, lineHeight: size + 5, color: ink }]} numberOfLines={1} testID="area-row-value">
      {headline.value}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    metric: { minWidth: 0 },
    phone: { gap: 1, minWidth: 0 },
    metricLabel: { fontSize: pointerType.meta, lineHeight: 15, minHeight: 15, color: colors.muted },
    labelLine: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
    labelName: { flexShrink: 1, minWidth: 0 },
    period: { flexShrink: 0, fontSize: pointerType.label, lineHeight: 15, fontWeight: "600", paddingHorizontal: 5, borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.accentDim, color: colors.accentText },
    valueLine: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
    valueLinePhone: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 },
    value: { fontWeight: "600", flexShrink: 0 },
    quietValue: { fontWeight: "500" },
    target: { fontSize: pointerType.meta, lineHeight: 18, color: colors.muted, flexShrink: 1, minWidth: 0 },
    noData: { fontSize: pointerType.meta, lineHeight: 18, color: colors.muted },
    noDataPhone: { fontSize: pointerType.ui, lineHeight: 20, color: colors.muted },
  });
