/**
 * The Usage tab's pieces: a card per site, the time-in-app strip, and the
 * ranked list that pages and buttons share. Drawn to the artboard Dev saw on
 * 2026-10-21 (`usage-analytics-artboards/`), out of the console's own parts:
 * the Growth card's head and fact row, `TrendBars`, `Panel` and the table rows.
 * The arithmetic is in `./usage`.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { UsageSite, UsageTime } from "@context/convex/functions/lib/adminFns/usageAnalyticsShape";
import { Text, leading, radii, space, useThemedStyles, type Colors } from "../design";
import { pointerType, touchType } from "../design/tokens";
import { DeltaText, EmptyNote, Panel, useCompact, usePanelPad } from "./AdminKit";
import { ListRow, RowValue, TableHead, TableRow, type Column } from "./AdminTable";
import { TrendBars } from "./Charts";
import { formatCount } from "./report";
import {
  busiestDay,
  comparison,
  durationComparison,
  formatDuration,
  formatHours,
  perEach,
  shares,
} from "./usage";

// -- a site ---------------------------------------------------------------

export function SiteCard({ site, days }: { site: UsageSite; days: number }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const pad = usePanelPad();
  const visits = comparison(site.visits, site.priorVisits, days);
  const visitors = comparison(site.visitors, site.priorVisitors, days);
  const busiest = busiestDay(site.daily);
  const facts = [
    {
      label: "Visitors",
      value: formatCount(site.visitors),
      change: visitors.change,
    },
    { label: "Visits each", value: perEach(site.visits, site.visitors), change: null },
    { label: "Busiest day", value: busiest === null ? "—" : formatCount(busiest.count), unit: busiest?.day, change: null },
  ];
  return (
    <Panel style={styles.fill} testID={`admin-usage-site-${site.host}`}>
      <View style={styles.head}>
        <View>
          <Text style={styles.headLabel}>{site.host}</Text>
          <View style={styles.bigRow}>
            <Text style={[styles.big, compact && styles.bigCompact]}>{formatCount(site.visits)}</Text>
            <Text variant="meta">visits</Text>
          </View>
        </View>
        <Text variant="meta" style={styles.headRight}>
          {visits.change === null ? null : <DeltaText change={visits.change} />} {visits.words}
        </Text>
      </View>
      <View>
        <TrendBars points={site.daily} />
        {site.visits === 0 ? (
          <View style={[styles.noVisits, { height: compact ? 88 : 112 }]}>
            <Text variant="meta">No visits yet</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.spacer} />
      <View style={[styles.facts, { marginHorizontal: -pad.x, marginBottom: -pad.y }]}>
        {facts.map((fact, index) => (
          <View
            key={fact.label}
            style={[
              styles.fact,
              compact ? styles.factCompact : { paddingHorizontal: pad.x },
              compact && index === 0 && { paddingLeft: pad.x },
              index > 0 && styles.ruled,
            ]}
          >
            <Text variant="meta" numberOfLines={1}>
              {fact.label}
            </Text>
            <Text style={styles.factValue}>
              {fact.value}
              {fact.change === null ? null : (
                <Text variant="meta"> {fact.change === 0 ? null : <DeltaText change={fact.change} />}</Text>
              )}
              {fact.unit ? <Text variant="meta" style={styles.unit}> {fact.unit}</Text> : null}
            </Text>
          </View>
        ))}
      </View>
    </Panel>
  );
}

// -- time in app ----------------------------------------------------------

const TIME_HELP =
  "Counted from a tick the app sends every 30 seconds while its tab is in front and somebody touched, typed or scrolled in the last two minutes. A tab left open is not time in the app.";

export function TimeCard({ time, prior, days }: { time: UsageTime | null; prior: UsageTime | null; days: number }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const cells = [
    {
      label: "Median session",
      value: time === null ? "—" : formatDuration(time.medianSeconds),
      compare: durationComparison(time?.medianSeconds ?? 0, prior?.medianSeconds ?? null, days),
    },
    {
      label: "Average session",
      value: time === null ? "—" : formatDuration(time.averageSeconds),
      compare: durationComparison(time?.averageSeconds ?? 0, prior?.averageSeconds ?? null, days),
    },
    {
      label: "Total hours",
      value: time === null ? "—" : formatHours(time.totalSeconds),
      compare: hoursComparison(time?.totalSeconds ?? 0, prior?.totalSeconds ?? null, days),
    },
    {
      label: "Sessions per person",
      value: time === null ? "—" : perEach(time.sessions, time.people),
      compare: {
        change: null,
        up: false,
        words: time === null ? "nobody yet" : `${formatCount(time.people)} ${time.people === 1 ? "person" : "people"} signed in`,
      },
    },
  ];
  return (
    <Panel flush title="Time in app" meta="active time, not open time" help={TIME_HELP} testID="admin-usage-time">
      <View style={[styles.strip, compact && styles.stripCompact]}>
        {cells.map((cell, index) => (
          <View
            key={cell.label}
            style={[
              styles.cell,
              compact && styles.cellCompact,
              !compact && index > 0 && styles.ruled,
              compact && index % 2 === 1 && styles.ruled,
              compact && index > 1 && styles.ruledTop,
            ]}
          >
            <Text variant="meta">{cell.label}</Text>
            <Text style={[styles.cellValue, compact && styles.cellValueCompact]}>{cell.value}</Text>
            <Text variant="meta" numberOfLines={1}>
              {cell.compare.change === null ? null : (
                <Text variant="meta" style={[styles.change, cell.compare.up ? styles.up : styles.down]}>{cell.compare.change} </Text>
              )}
              {cell.compare.words}
            </Text>
          </View>
        ))}
      </View>
    </Panel>
  );
}

function hoursComparison(now: number, prior: number | null, days: number) {
  if (prior === null || prior === 0) return { change: null, up: false, words: "nothing to compare yet" };
  const change = Math.round(now / 3600) - Math.round(prior / 3600);
  const sign = change > 0 ? "+" : change < 0 ? "−" : "±";
  return { change: `${sign}${formatCount(Math.abs(change))}`, up: change >= 0, words: `on the ${days} before` };
}

// -- pages and buttons ----------------------------------------------------

export interface RankedRow {
  key: string;
  label: string;
  value: number;
  people: number;
}

/** Rows a phone shows before "Show all". */
const PHONE_ROWS = 5;

export function RankedPanel({
  title,
  meta,
  valueLabel,
  rows,
  empty,
  testID,
  rowTestID,
}: {
  title: string;
  meta: string;
  valueLabel: string;
  rows: readonly RankedRow[];
  empty: { title: string; body: string };
  testID: string;
  rowTestID: (key: string) => string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const [all, setAll] = useState(false);
  const share = shares(rows.map((row) => row.value));
  const columns: Column[] = [
    { label: title === "Most viewed pages" ? "Page" : "Button", flex: 1 },
    { label: "", width: 72 },
    { label: valueLabel, width: 76, align: "right" },
    { label: "People", width: 92, align: "right" },
  ];

  if (rows.length === 0) {
    return (
      <Panel flush title={title} meta={meta} metaWide testID={testID}>
        <EmptyNote title={empty.title} body={empty.body} />
      </Panel>
    );
  }

  if (compact) {
    const shown = all ? rows : rows.slice(0, PHONE_ROWS);
    return (
      <Panel flush title={title} meta={meta} testID={testID}>
        {shown.map((row, index) => (
          <ListRow
            key={row.key}
            first={index === 0}
            title={row.label}
            sub={
              <Text variant="meta" numberOfLines={1}>
                <Text variant="mono">{row.key}</Text> · {formatCount(row.people)} {row.people === 1 ? "person" : "people"}
              </Text>
            }
            trailing={<RowValue>{formatCount(row.value)}</RowValue>}
            below={<ShareBar part={share[index] ?? 0} />}
            testID={rowTestID(row.key)}
          />
        ))}
        {rows.length > PHONE_ROWS && !all ? (
          <Pressable role="button" onPress={() => setAll(true)} style={styles.showAll} testID={`${testID}-all`}>
            <Text style={styles.showAllText}>Show all {rows.length}</Text>
          </Pressable>
        ) : null}
      </Panel>
    );
  }

  return (
    <Panel flush title={title} meta={meta} testID={testID}>
      <TableHead columns={columns} />
      {rows.map((row, index) => (
        <TableRow
          key={row.key}
          columns={columns}
          last={index === rows.length - 1}
          testID={rowTestID(row.key)}
          cells={[
            <View key="name" style={styles.name}>
              <Text variant="rowTitle" numberOfLines={1}>
                {row.label}
              </Text>
              <Text variant="mono" numberOfLines={1} ellipsizeMode="middle" style={styles.key}>
                {row.key}
              </Text>
            </View>,
            <ShareBar key="bar" part={share[index] ?? 0} />,
            <RowValue key="value">{formatCount(row.value)}</RowValue>,
            <Text key="people" variant="meta" style={styles.people}>
              {formatCount(row.people)}
            </Text>,
          ]}
        />
      ))}
    </Panel>
  );
}

function ShareBar({ part }: { part: number }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.track} aria-hidden>
      <View style={[styles.trackFill, { width: `${Math.max(part * 100, part > 0 ? 2 : 0)}%` }]} />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    fill: { flexGrow: 1 },
    head: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-end",
      gap: space.x3,
      marginBottom: 14,
    },
    headLabel: {
      fontSize: pointerType.ui,
      lineHeight: leading(pointerType.ui, 1.55),
      fontWeight: "600",
      color: colors.text,
    },
    headRight: { textAlign: "right", flexShrink: 1 },
    big: {
      fontSize: pointerType.title,
      lineHeight: leading(pointerType.title, 1.15),
      fontWeight: "600",
      letterSpacing: -1.2,
      color: colors.text,
      fontVariant: ["tabular-nums"],
      marginTop: 2,
    },
    bigCompact: { fontSize: touchType.title, lineHeight: leading(touchType.title, 1.15) },
    spacer: { flexGrow: 1, minHeight: 18 },
    bigRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
    unit: { fontWeight: "400", letterSpacing: 0 },
    noVisits: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center", justifyContent: "center" },

    facts: { flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.line },
    fact: { flex: 1, minWidth: 0, paddingTop: 12, paddingBottom: 14, minHeight: 72 },
    factCompact: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12, minHeight: 66 },
    factValue: {
      marginTop: 1,
      fontSize: touchType.lede,
      lineHeight: leading(touchType.lede, 1.4),
      fontWeight: "600",
      letterSpacing: -0.3,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    ruled: { borderLeftWidth: 1, borderLeftColor: colors.line },
    ruledTop: { borderTopWidth: 1, borderTopColor: colors.line },

    strip: { flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.line },
    stripCompact: { flexWrap: "wrap" },
    cell: { flex: 1, minWidth: 0, gap: 4, paddingVertical: 16, paddingHorizontal: space.x5 },
    cellCompact: { flexBasis: "50%", flexGrow: 0, paddingHorizontal: space.x4, paddingVertical: space.x3 },
    cellValue: {
      fontSize: pointerType.h2,
      lineHeight: leading(pointerType.h2, 1.2),
      fontWeight: "600",
      letterSpacing: -0.8,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    cellValueCompact: { fontSize: touchType.h2, lineHeight: leading(touchType.h2, 1.2) },
    change: { fontWeight: "600", fontVariant: ["tabular-nums"] },
    up: { color: colors.okText },
    down: { color: colors.critText },

    name: { gap: 2, minWidth: 0, alignSelf: "stretch" },
    key: { color: colors.muted },
    people: { fontVariant: ["tabular-nums"] },
    track: { width: "100%", height: 4, borderRadius: radii.pill, backgroundColor: colors.line, overflow: "hidden" },
    trackFill: { height: "100%", borderRadius: radii.pill, backgroundColor: colors.accent },
    showAll: {
      alignItems: "center",
      paddingVertical: space.x3,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    showAllText: { color: colors.accent, fontWeight: "600" },
  });
