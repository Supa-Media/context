/**
 * The Activity tab: how much the product is being used.
 *
 * One chart of contexts seen, and every event counter as a row of one table
 * rather than eight identical tiles each repeating the same date axis. The
 * counters keep their day-over-day percentage: unlike accounts and contexts,
 * tool calls and searches run to hundreds a day, which is a denominator big
 * enough for a ratio to carry something.
 *
 * The two all-time totals that once sat here stay gone. They are the census's
 * to report, and one number arriving on one page from two different reads —
 * with two different ceilings — is how a dashboard starts disagreeing with
 * itself.
 */

import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Card, Text, leading, space, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import {
  EmptyNote,
  Panel,
  Skeleton,
  useCompact,
} from "./AdminKit";
import {
  ListRow,
  RowValue,
  TableHead,
  TableRow,
  type Column,
} from "./AdminTable";
import { TrendBars } from "./Charts";
import {
  dayOverDay,
  formatCount,
  formatDelta,
  metricLabel,
  orderSeries,
  shortDay,
} from "./report";

export function ActivitySection({ days }: { days: number }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const report = useQuery(api.functions.admin.usageReport, { days });
  const series = useMemo(() => (report ? orderSeries(report.series) : []), [report]);

  if (report === undefined) {
    return (
      <View style={styles.section} aria-busy testID="admin-loading">
        <Card>
          <Skeleton width={120} height={14} />
          <Skeleton width={80} height={30} style={styles.skGap} />
          <Skeleton width="100%" height={112} style={styles.skGap} />
        </Card>
      </View>
    );
  }

  const points = report.activeContexts.points;
  const peak = points.reduce((best, point) => Math.max(best, point.count), 0);
  const today = points[points.length - 1]?.count ?? 0;
  const range =
    points.length > 0 ? `${shortDay(points[0].day)} – ${shortDay(points[points.length - 1].day)}` : "";
  const columns: readonly Column[] = [
    { label: "Metric", flex: 1.6 },
    { label: `${report.days}-day total`, flex: 1, align: "right" },
    { label: "Per day", flex: 3.4 },
    { label: "Today vs yesterday", flex: 1.6, align: "right" },
  ];

  return (
    <View style={styles.section}>
      <Panel
        title="Contexts seen"
        meta={`distinct, last ${report.days} days`}
        help="Distinct contexts reached over the window. A cardinality, never a sum — the same context on two days is one context."
        testID="admin-active"
      >
        <View style={styles.figure}>
          <Text style={styles.big}>{formatCount(report.activeContexts.distinctInWindow)}</Text>
          <Text variant="meta">
            {formatCount(today)} today · peak {formatCount(peak)}
          </Text>
        </View>
        <TrendBars points={points} />
      </Panel>

      <Panel
        flush
        title="Events"
        meta={`each line on its own scale${range ? ` · ${range}` : ""}`}
        metaWide
      >
        {series.length === 0 ? (
          <EmptyNote title="No events yet" body="Counters start as soon as someone uses the product." />
        ) : compact ? (
          series.map((entry, index) => (
            <ListRow
              key={entry.metric}
              first={index === 0}
              title={metricLabel(entry.metric)}
              sub={
                <Text variant="meta" style={styles.phoneSub}>
                  <Change points={entry.points} /> vs yesterday
                </Text>
              }
              trailing={<RowValue>{formatCount(entry.total)}</RowValue>}
              below={<TrendBars points={entry.points} size="spark" />}
              testID={`admin-metric-${entry.metric}`}
            />
          ))
        ) : (
          <View>
            <TableHead columns={columns} />
            {series.map((entry, index) => (
              <TableRow
                key={entry.metric}
                columns={columns}
                last={index === series.length - 1}
                testID={`admin-metric-${entry.metric}`}
                cells={[
                  <Text key="label" variant="rowTitle">
                    {metricLabel(entry.metric)}
                  </Text>,
                  <Text key="total" style={styles.strongNum}>
                    {formatCount(entry.total)}
                  </Text>,
                  <View key="spark" style={styles.sparkCell}>
                    <TrendBars points={entry.points} size="spark" />
                  </View>,
                  <Change key="change" points={entry.points} />,
                ]}
              />
            ))}
          </View>
        )}
      </Panel>
    </View>
  );
}

/** Today against yesterday, coloured by direction; `—` where there is no yesterday. */
function Change({ points }: { points: Parameters<typeof dayOverDay>[0] }) {
  const styles = useThemedStyles(makeStyles);
  const delta = dayOverDay(points);
  const percent = delta === null ? 0 : Math.round(delta * 100);
  const tone = percent > 0 ? styles.up : percent < 0 ? styles.down : styles.flat;
  return <Text style={[styles.change, tone]}>{formatDelta(delta)}</Text>;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x4 },
    figure: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: 10,
      marginTop: -6,
      marginBottom: 14,
    },
    big: {
      fontSize: pointerType.title,
      lineHeight: leading(pointerType.title, 1.2),
      fontWeight: "600",
      letterSpacing: -0.9,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    strongNum: {
      fontSize: pointerType.ui,
      fontWeight: "600",
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    sparkCell: { width: "100%" },
    phoneSub: { fontSize: pointerType.ui },
    change: { fontSize: pointerType.ui, fontWeight: "600", fontVariant: ["tabular-nums"] },
    up: { color: colors.okText },
    down: { color: colors.critText },
    flat: { color: colors.muted },
    skGap: { marginTop: 14 },
  });
