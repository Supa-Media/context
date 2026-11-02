/**
 * Token usage on the Activity tab: what crossed the MCP boundary, for Premium
 * workspaces (`docs/decisions/observability/token-usage.md`).
 *
 * Three headline numbers against the period before, tokens returned per tool
 * call and tokens out per day as stacked bars by agent, and the same figures
 * per agent as a table. It reads the same `usageReport` as the Events table,
 * over twice the window, so the comparison period comes from one read.
 */
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useReportOnce } from "./useReportOnce";
import { api } from "@context/convex/_generated/api";
import { Text, leading, space, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { EmptyNote, Panel, useCompact } from "./AdminKit";
import { ListRow, RowValue, TableHead, TableRow, type Column } from "./AdminTable";
import { StackedBars, useSeriesColors } from "./Charts";
import { formatCount, formatDelta } from "./report";
import { changeBetween, perCall, perCallSegments, tokenReport } from "./tokens";

/** `usageReport`'s own ceiling (`MAX_REPORT_DAYS`). */
const MAX_REPORT_DAYS = 90;

export function TokenUsageSection({ days }: { days: number }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const colors = useSeriesColors();
  const usage = useReportOnce(api.functions.admin.usageReport, {
    days: Math.min(days * 2, MAX_REPORT_DAYS),
  });
  const report = useMemo(() => (usage ? tokenReport(usage.series, days) : null), [usage, days]);

  if (report === null) return null;

  const { totals, previous } = report;
  const average = perCall(totals.out, totals.calls);
  const tiles = [
    { key: "in", label: "Tokens into Context", value: totals.in, change: changeBetween(totals.in, previous?.in ?? null), lowerIsGood: false },
    { key: "out", label: "Tokens out of Context", value: totals.out, change: changeBetween(totals.out, previous?.out ?? null), lowerIsGood: false },
    {
      key: "per-call",
      label: "Tokens returned per tool call",
      value: average,
      change: changeBetween(average, previous ? perCall(previous.out, previous.calls) : null),
      lowerIsGood: true,
    },
  ];
  const segments = (values: readonly (readonly number[])[]) =>
    report.agents.map((agent, i) => ({ label: agent.label, color: colors[i], values: values[i] }));
  const rows = report.agents
    .map((agent, i) => {
      const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
      return { agent, color: colors[i], calls: sum(agent.calls), in: sum(agent.in), out: sum(agent.out) };
    })
    .filter((row) => row.calls > 0 || row.out > 0)
    .sort((a, b) => b.out - a.out);
  const columns: readonly Column[] = [
    { label: "Agent", flex: 1.6 },
    { label: "Tool calls", flex: 1, align: "right" },
    { label: "Tokens in", flex: 1, align: "right" },
    { label: "Tokens out", flex: 1, align: "right" },
    { label: "Out per call", flex: 1, align: "right" },
    { label: "Share of out", flex: 1, align: "right" },
  ];
  const share = (out: number) => (totals.out > 0 ? `${Math.round((out / totals.out) * 100)}%` : "—");
  const meta = `Premium workspaces · last ${days} days${previous ? ` · vs the ${days} before` : ""}`;

  if (totals.calls === 0 && totals.out === 0) {
    return (
      <Panel title="Token usage" meta={meta} testID="admin-tokens">
        <EmptyNote title="No token usage yet" body="Counts start when a Premium workspace's agent calls a tool." />
      </Panel>
    );
  }

  return (
    <View style={styles.section} testID="admin-tokens">
      <View style={[styles.tiles, compact && styles.stack]}>
        {tiles.map((tile) => (
          <Panel key={tile.key} style={styles.tile} testID={`admin-tokens-${tile.key}`}>
            <Text variant="meta">{tile.label}</Text>
            <Text style={styles.big}>{tile.value === null ? "—" : formatCount(Math.round(tile.value))}</Text>
            <Text variant="meta">
              <Text style={[styles.change, toneOf(styles, tile.change, tile.lowerIsGood)]}>{formatDelta(tile.change)}</Text>
              {previous ? ` vs previous ${days} days` : " · no earlier period in range"}
            </Text>
          </Panel>
        ))}
      </View>

      <View style={[styles.charts, compact && styles.stack]}>
        <Panel title="Tokens returned per tool call" style={styles.chart} testID="admin-tokens-per-call">
          <StackedBars days={report.days} segments={segments(perCallSegments(report))} />
        </Panel>
        <Panel title="Tokens out of Context per day" style={styles.chart} testID="admin-tokens-out">
          <StackedBars days={report.days} segments={segments(report.agents.map((agent) => agent.out))} />
        </Panel>
      </View>

      <Panel flush title="By agent" meta={meta} metaWide testID="admin-tokens-agents">
        {compact ? (
          rows.map((row, index) => (
            <ListRow
              key={row.agent.family}
              first={index === 0}
              title={row.agent.label}
              sub={
                <Text variant="meta">
                  {formatCount(row.calls)} calls · {formatCount(row.in)} in · {share(row.out)} of out
                </Text>
              }
              trailing={<RowValue>{formatCount(row.out)}</RowValue>}
              testID={`admin-tokens-agent-${row.agent.family}`}
            />
          ))
        ) : (
          <View>
            <TableHead columns={columns} />
            {rows.map((row, index) => {
              const each = perCall(row.out, row.calls);
              return (
                <TableRow
                  key={row.agent.family}
                  columns={columns}
                  last={index === rows.length - 1}
                  testID={`admin-tokens-agent-${row.agent.family}`}
                  cells={[
                    <View key="agent" style={styles.agent}>
                      <View style={[styles.swatch, { backgroundColor: row.color }]} />
                      <Text variant="rowTitle">{row.agent.label}</Text>
                    </View>,
                    <Text key="calls" style={styles.num}>{formatCount(row.calls)}</Text>,
                    <Text key="in" style={styles.num}>{formatCount(row.in)}</Text>,
                    <Text key="out" style={styles.num}>{formatCount(row.out)}</Text>,
                    <Text key="per" style={styles.num}>{each === null ? "—" : formatCount(Math.round(each))}</Text>,
                    <Text key="share" style={styles.num}>{share(row.out)}</Text>,
                  ]}
                />
              );
            })}
          </View>
        )}
      </Panel>
    </View>
  );
}

function toneOf(styles: ReturnType<typeof makeStyles>, change: number | null, lowerIsGood: boolean) {
  const percent = change === null ? 0 : Math.round(change * 100);
  if (percent === 0) return styles.flat;
  return percent < 0 === lowerIsGood ? styles.up : styles.down;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x4 },
    tiles: { flexDirection: "row", gap: space.x4 },
    charts: { flexDirection: "row", gap: space.x4 },
    stack: { flexDirection: "column" },
    tile: { flex: 1, gap: 4 },
    chart: { flex: 1, minWidth: 0 },
    big: {
      fontSize: pointerType.title,
      lineHeight: leading(pointerType.title, 1.2),
      fontWeight: "600",
      letterSpacing: -0.9,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    change: { fontWeight: "600", fontVariant: ["tabular-nums"] },
    up: { color: colors.okText },
    down: { color: colors.critText },
    flat: { color: colors.muted },
    agent: { flexDirection: "row", alignItems: "center", gap: 8 },
    swatch: { width: 8, height: 8, borderRadius: 2 },
    num: { fontSize: pointerType.ui, color: colors.text, fontVariant: ["tabular-nums"], textAlign: "right" },
  });
