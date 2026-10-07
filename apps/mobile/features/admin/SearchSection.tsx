/**
 * The Search tab: how long searches take, in the app and for AI clients, and
 * which index answered the slow ones. Over the search timing log
 * (`searchTimings`), which holds durations and never a word anybody searched.
 *
 * Asked for by the owner, 2026-10-07 ("make sure that we are able to track
 * the average search latency"). Shaped like the Agent tab (`./AgentSection`),
 * whose chart it shares: its own window, a workspace filter, a tile per view
 * that also picks what the rest of the tab shows.
 *
 * Above them, the search-by-meaning indexing panel (`./MeaningIndexPanel`):
 * every workspace's index and a Restart button (the owner, 2026-10-07).
 *
 * The figures are `searchReport` (`apps/convex/functions/lib/adminFns/
 * searchReport.ts`); the words for them are `./search`.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Card, Text, TextField, leading, space, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { EmptyNote, NoticeLine, Panel, Skeleton, TwoUp, useCompact } from "./AdminKit";
import { ListRow, RowValue, TableHead, TableRow, type Column } from "./AdminTable";
import { AgentChart } from "./AgentChart";
import { MeaningIndexPanel } from "./MeaningIndexPanel";
import { whenLabel } from "./agent";
import { Segments } from "./Segments";
import {
  SEARCH_RETENTION_DAYS,
  SEARCH_VIEWS,
  SEARCH_WINDOWS,
  answeredByLabel,
  averageChange,
  chartBuckets,
  formatMs,
  surfaceLabel,
  viewLabel,
  type SearchReport,
  type SearchView,
} from "./search";
import { formatCount } from "./report";

export function SearchSection() {
  const styles = useThemedStyles(makeStyles);
  const [view, setView] = useState<SearchView>("screen");
  const [days, setDays] = useState<"1" | "7" | "30">("7");
  const [workspace, setWorkspace] = useState("");
  const asked = workspace.trim();
  const report = useQuery(api.functions.admin.searchReport, {
    days: Number(days),
    view,
    ...(asked === "" ? {} : { workspace: asked }),
  });

  return (
    <View style={styles.section} testID="admin-search">
      <MeaningIndexPanel />
      <View style={styles.filters}>
        <Segments options={SEARCH_WINDOWS} value={days} onChange={setDays} label="Window" testID="admin-search-days" />
        <TextField
          label="Workspace"
          labelHidden
          value={workspace}
          onChangeText={setWorkspace}
          placeholder="Find a workspace, e.g. @maya"
          autoCapitalize="none"
          autoCorrect={false}
          containerStyle={styles.find}
          testID="admin-search-workspace"
        />
        <Text variant="meta" style={styles.kept}>
          Searches are kept for {SEARCH_RETENTION_DAYS} days
        </Text>
      </View>
      {report === undefined ? <Loading /> : <Body report={report} asked={asked} view={view} onView={setView} />}
    </View>
  );
}

function Loading() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section} aria-busy testID="admin-loading">
      <Card>
        <Skeleton width={140} height={14} />
        <Skeleton width={90} height={30} style={styles.skGap} />
        <Skeleton width="100%" height={120} style={styles.skGap} />
      </Card>
    </View>
  );
}

function Body({
  report,
  asked,
  view,
  onView,
}: {
  report: SearchReport;
  asked: string;
  view: SearchView;
  onView: (view: SearchView) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  if (asked !== "" && report.workspace === null) {
    return (
      <Card>
        <EmptyNote title={`No workspace called ${asked.startsWith("@") ? asked : `@${asked}`}`} body="Check the spelling, or clear the box to see every workspace." />
      </Card>
    );
  }
  const chosen = report.views.find((entry) => entry.view === view);
  return (
    <>
      {report.truncated ? (
        <NoticeLine mark="!" tone="warn">
          This window has more searches than the tab reads at once; the figures cover the newest ones.
        </NoticeLine>
      ) : null}
      <View style={styles.tiles}>
        {SEARCH_VIEWS.map((entry) => {
          const figures = report.views.find((each) => each.view === entry.key);
          return figures ? (
            <ViewTile key={entry.key} label={entry.label} detail={entry.detail} figures={figures} days={report.days} selected={entry.key === view} onPress={() => onView(entry.key)} />
          ) : null;
        })}
      </View>
      {chosen === undefined || chosen.count === 0 ? (
        <Card>
          <EmptyNote title={`No searches ${viewLabel(view).toLowerCase()} in this window`} body="Searches appear here as soon as somebody searches." />
        </Card>
      ) : (
        <>
          <Panel title={`Search time, ${viewLabel(view).toLowerCase()}`} meta={report.days === 1 ? "by hour, UTC" : `last ${report.days} days`} metaWide>
            <AgentChart buckets={chartBuckets(report.buckets)} format={formatMs} volume="Searches" testID="admin-search-chart" />
          </Panel>
          <TwoUp>
            <AnsweredBy report={report} />
            <Found report={report} />
          </TwoUp>
          <Slowest report={report} />
        </>
      )}
    </>
  );
}

function ViewTile({
  label,
  detail,
  figures,
  days,
  selected,
  onPress,
}: {
  label: string;
  detail: string;
  figures: SearchReport["views"][number];
  days: number;
  selected: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const change = averageChange(figures, figures.prior, days);
  return (
    <Pressable
      onPress={onPress}
      role="button"
      aria-pressed={selected}
      aria-label={`${label}: average ${formatMs(figures.avg)}`}
      style={StyleSheet.flatten([styles.tile, compact && styles.tileCompact])}
      testID={`admin-search-view-${figures.view}`}
    >
      <Card style={StyleSheet.flatten([styles.tileCard, selected && styles.tileSelected])}>
        <Text variant="eyebrow">{label}</Text>
        <Text style={styles.big}>{formatMs(figures.avg)}</Text>
        <Text variant="meta">
          average · typical {formatMs(figures.p50)} · slowest 1 in 20 {formatMs(figures.p95)}
        </Text>
        <Text variant="meta" style={change.tone === "ok" ? styles.good : change.tone === "crit" ? styles.bad : null}>
          {change.text}
        </Text>
        <Text variant="meta">
          {formatCount(figures.count)} {figures.count === 1 ? "search" : "searches"} · {figures.workspaces}{" "}
          {figures.workspaces === 1 ? "workspace" : "workspaces"}
        </Text>
        <Text variant="meta" style={styles.detail}>
          {detail}
        </Text>
      </Card>
    </Pressable>
  );
}

function AnsweredBy({ report }: { report: SearchReport }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Panel flush title="Which index answered" meta="slowest 1 in 20 on the right" testID="admin-search-answered-by">
      {report.answeredBy.length === 0 ? (
        <EmptyNote title="Not known on the device" body="The device only sees how long it waited. Pick App, on our side to see which index answered." />
      ) : (
        report.answeredBy.map((entry, index) => (
          <ListRow
            key={entry.answeredBy}
            first={index === 0}
            title={answeredByLabel(entry.answeredBy)}
            sub={`${formatCount(entry.count)} searches · average ${formatMs(entry.avg)} · ${formatCount(entry.misses)} found nothing`}
            trailing={<Text style={styles.num}>{formatMs(entry.p95)}</Text>}
            testID={`admin-search-by-${entry.answeredBy}`}
          />
        ))
      )}
    </Panel>
  );
}

function Found({ report }: { report: SearchReport }) {
  const styles = useThemedStyles(makeStyles);
  const rows = [
    { key: "hits", label: "Found something", figures: report.found.hits },
    { key: "misses", label: "Found nothing", figures: report.found.misses },
  ];
  return (
    <Panel flush title="Hits and misses" meta="average on the right" testID="admin-search-found">
      {rows.map((row, index) => (
        <ListRow
          key={row.key}
          first={index === 0}
          title={row.label}
          sub={`${formatCount(row.figures.count)} searches · typical ${formatMs(row.figures.p50)} · slowest 1 in 20 ${formatMs(row.figures.p95)}`}
          trailing={<Text style={styles.num}>{formatMs(row.figures.avg)}</Text>}
          testID={`admin-search-${row.key}`}
        />
      ))}
    </Panel>
  );
}

const SLOWEST_COLUMNS: readonly Column[] = [
  { label: "When", flex: 1.1 },
  { label: "Workspace", flex: 1.3 },
  { label: "Where", flex: 1.1 },
  { label: "Answered by", flex: 1.6 },
  { label: "Found", flex: 0.8 },
  { label: "Time", flex: 0.9, align: "right" },
];

function Slowest({ report }: { report: SearchReport }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const now = Date.now();
  return (
    <Panel flush title="Slowest searches" meta="in this window" metaWide testID="admin-search-slowest">
      {compact ? null : <TableHead columns={SLOWEST_COLUMNS} />}
      {report.slowest.map((row, index) => {
        const where = row.workspace ? `@${row.workspace}` : "a deleted workspace";
        const found = row.found ? "Yes" : "Nothing";
        return compact ? (
          <ListRow
            key={row.id}
            first={index === 0}
            title={where}
            sub={`${whenLabel(row.at, now)} · ${surfaceLabel(row.surface)} · ${answeredByLabel(row.answeredBy)} · ${found}`}
            trailing={<RowValue>{formatMs(row.ms)}</RowValue>}
            testID={`admin-search-slow-${row.id}`}
          />
        ) : (
          <TableRow
            key={row.id}
            columns={SLOWEST_COLUMNS}
            last={index === report.slowest.length - 1}
            testID={`admin-search-slow-${row.id}`}
            cells={[
              <Text key="when" variant="rowSub">{whenLabel(row.at, now)}</Text>,
              <Text key="ws" variant="rowTitle" numberOfLines={1}>{where}</Text>,
              <Text key="where" variant="rowSub">{surfaceLabel(row.surface)}</Text>,
              <Text key="by" variant="rowSub">{answeredByLabel(row.answeredBy)}</Text>,
              <Text key="found" variant="rowSub">{found}</Text>,
              <Text key="ms" style={styles.num}>{formatMs(row.ms)}</Text>,
            ]}
          />
        );
      })}
    </Panel>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x4 },
    filters: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x3 },
    find: { minWidth: 220, flexGrow: 1, maxWidth: 320 },
    kept: { marginLeft: "auto" },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.x3 },
    tile: { flexGrow: 1, flexBasis: 240 },
    tileCompact: { flexBasis: "100%" },
    tileCard: { gap: 6, flexGrow: 1 },
    tileSelected: { borderColor: colors.accent, borderWidth: 2 },
    big: {
      fontSize: pointerType.title,
      lineHeight: leading(pointerType.title, 1.2),
      fontWeight: "600",
      letterSpacing: -0.9,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    detail: { color: colors.muted },
    good: { color: colors.okText },
    bad: { color: colors.critText },
    num: { fontSize: pointerType.ui, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] },
    skGap: { marginTop: 14 },
  });
