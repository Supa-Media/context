/**
 * The Agent tab: how fast the assistant answers, how its turns end, and
 * where the time goes — over the turn log (`agentTurns`), which holds names,
 * durations and counts and never a word anybody wrote.
 *
 * It keeps its own window (a day, a week, a month) rather than the console's
 * 7/30/90 picker, because the log itself only reaches back thirty days, and
 * its own filter by client and by workspace. A row of "Recent questions"
 * opens that one question step by step (`./AgentTurn`).
 *
 * The figures are `agentReport` (`apps/convex/functions/lib/adminFns/
 * agentReport.ts`); the words for them are `./agent`.
 */

import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Card, Pill, Text, TextField, leading, space, useTheme, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { EmptyNote, NoticeLine, Panel, Skeleton, TwoUp, useCompact } from "./AdminKit";
import { ListRow, RowValue, TableHead, TableRow, type Column } from "./AdminTable";
import { AgentChart } from "./AgentChart";
import { AgentTurn, StepStrip } from "./AgentTurn";
import { useToneColor } from "./Charts";
import { Segments } from "./Segments";
import {
  AGENT_CLIENTS,
  AGENT_WINDOWS,
  TURN_RETENTION_DAYS,
  clientLabel,
  countChange,
  formatSeconds,
  outcomeLabel,
  outcomeTone,
  percentOf,
  timeChange,
  timeShares,
  toolLabel,
  whenLabel,
  type AgentClient,
  type AgentReport,
} from "./agent";
import { formatCount } from "./report";

export function AgentSection() {
  const styles = useThemedStyles(makeStyles);
  const [client, setClient] = useState<AgentClient>("all");
  const [days, setDays] = useState<"1" | "7" | "30">("7");
  const [workspace, setWorkspace] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const asked = workspace.trim();
  const report = useQuery(api.functions.admin.agentReport, {
    days: Number(days),
    client,
    ...(asked === "" ? {} : { workspace: asked }),
  });
  const open = openId === null ? null : (report?.recent.find((turn) => turn.id === openId) ?? null);

  if (open && report) {
    return <AgentTurn turn={open} tools={report.tools} onBack={() => setOpenId(null)} />;
  }

  return (
    <View style={styles.section} testID="admin-agent">
      <View style={styles.filters}>
        <Segments options={AGENT_CLIENTS} value={client} onChange={setClient} label="Where the question came from" testID="admin-agent-client" />
        <Segments options={AGENT_WINDOWS} value={days} onChange={setDays} label="Window" testID="admin-agent-days" />
        <TextField
          label="Workspace"
          labelHidden
          value={workspace}
          onChangeText={setWorkspace}
          placeholder="Find a workspace, e.g. @maya"
          autoCapitalize="none"
          autoCorrect={false}
          containerStyle={styles.find}
          testID="admin-agent-workspace"
        />
        <Text variant="meta" style={styles.kept}>
          Turns are kept for {TURN_RETENTION_DAYS} days
        </Text>
      </View>
      {report === undefined ? <Loading /> : <Body report={report} asked={asked} onOpen={setOpenId} />}
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

function Body({ report, asked, onOpen }: { report: AgentReport; asked: string; onOpen: (id: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const { current, prior, days } = report;

  if (asked !== "" && report.workspace === null) {
    return (
      <Card>
        <EmptyNote title={`No workspace called ${asked.startsWith("@") ? asked : `@${asked}`}`} body="Check the spelling, or clear the box to see every workspace." />
      </Card>
    );
  }
  if (current.turns === 0) {
    return (
      <Card>
        <EmptyNote title="No questions in this window" body="Turns appear here as soon as somebody asks the assistant something." />
      </Card>
    );
  }

  const typical = timeChange(current.p50, prior.p50, prior.turns, days);
  const slowest = timeChange(current.p95, prior.p95, prior.turns, days);
  return (
    <>
      {report.truncated ? (
        <NoticeLine mark="!" tone="warn">
          This window has more questions than the tab reads at once; the figures cover the newest ones.
        </NoticeLine>
      ) : null}
      <View style={styles.tiles}>
        <Tile label="Typical answer time" value={formatSeconds(current.p50)} sub={typical.text} tone={typical.tone} testID="admin-agent-p50" />
        <Tile label="Slowest 1 in 20" value={formatSeconds(current.p95)} sub={slowest.text} tone={slowest.tone} testID="admin-agent-p95" />
        <Tile
          label="Questions asked"
          value={formatCount(current.turns)}
          sub={`${current.workspaces} ${current.workspaces === 1 ? "workspace" : "workspaces"} · ${countChange(current.turns, prior.turns, days)}`}
          testID="admin-agent-turns"
        />
        <Endings current={current} />
      </View>

      <Panel title="Answer time by day" meta={days === 1 ? "by hour, UTC" : `last ${days} days`} metaWide>
        <AgentChart buckets={report.buckets} />
      </Panel>

      <TwoUp>
        <TimeShare current={current} />
        <Models models={report.models} />
      </TwoUp>

      <Lookups report={report} />
      <Recent report={report} onOpen={onOpen} />
    </>
  );
}

function Tile({
  label,
  value,
  sub,
  tone = "neutral",
  testID,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "ok" | "crit" | "neutral";
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <Card style={StyleSheet.flatten([styles.tile, compact && styles.tileCompact])} testID={testID}>
      <Text variant="eyebrow">{label}</Text>
      <Text style={styles.big}>{value}</Text>
      <Text variant="meta" style={tone === "ok" ? styles.good : tone === "crit" ? styles.bad : null}>
        {sub}
      </Text>
    </Card>
  );
}

function Endings({ current }: { current: AgentReport["current"] }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const rows = [
    { key: "answered", label: "Answered", count: current.answered, tone: "ok" as const },
    { key: "exhausted", label: "Ran out of steps", count: current.exhausted, tone: "warn" as const },
    { key: "failed", label: "Failed", count: current.failed, tone: "crit" as const },
  ];
  return (
    <Card style={StyleSheet.flatten([styles.tile, compact && styles.tileCompact])} testID="admin-agent-endings">
      <Text variant="eyebrow">How turns ended</Text>
      <Text style={styles.big}>{percentOf(current.answered, current.turns)}%</Text>
      <View style={styles.endings}>
        {rows.slice(1).map((row) => (
          <Text key={row.key} variant="meta" style={row.count > 0 ? (row.tone === "crit" ? styles.bad : styles.warn) : null}>
            {row.label} {formatCount(row.count)}
          </Text>
        ))}
      </View>
    </Card>
  );
}

function TimeShare({ current }: { current: AgentReport["current"] }) {
  const styles = useThemedStyles(makeStyles);
  const tone = useToneColor();
  const shares = timeShares(current);
  const colors = [tone("accent"), tone("shared"), tone("muted")];
  return (
    <Panel title="Where the time goes" testID="admin-agent-share">
      <View style={styles.shareBar} aria-hidden>
        {shares.map((share, index) =>
          share.percent > 0 ? (
            <View key={share.key} style={{ flex: share.percent, backgroundColor: colors[index] }} />
          ) : null,
        )}
      </View>
      {shares.map((share, index) => (
        <View key={share.key} style={styles.shareRow}>
          <View style={[styles.swatch, { backgroundColor: colors[index] }]} />
          <Text variant="rowSub" style={styles.flex}>
            {share.label}
          </Text>
          <Text style={styles.num}>{share.percent}%</Text>
        </View>
      ))}
    </Panel>
  );
}

function Models({ models }: { models: AgentReport["models"] }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Panel flush title="Models" testID="admin-agent-models">
      {models.map((entry, index) => (
        <ListRow
          key={`${entry.provider}/${entry.model}`}
          first={index === 0}
          title={<Text variant="mono" numberOfLines={1}>{entry.model}</Text>}
          sub={`${entry.provider} · ${formatCount(entry.turns)} ${entry.turns === 1 ? "turn" : "turns"}`}
          trailing={<Text style={styles.num}>{formatSeconds(entry.p50)}</Text>}
        />
      ))}
    </Panel>
  );
}

function Lookups({ report }: { report: AgentReport }) {
  const styles = useThemedStyles(makeStyles);
  // Purple is a lookup everywhere on this tab: the time share, the strips, this bar.
  const { graphColors } = useTheme();
  const compact = useCompact();
  const { tools, current } = report;
  const perQuestion = current.turns > 0 ? Math.round((current.toolCalls / current.turns) * 10) / 10 : 0;
  const columns: readonly Column[] = [
    { label: "Lookup", flex: 2 },
    { label: "Calls", flex: 0.8, align: "right" },
    { label: "Share of calls", flex: 1.6 },
    { label: "Typical time", flex: 1, align: "right" },
    { label: "Slowest 1 in 20", flex: 1.1, align: "right" },
    { label: "Failed", flex: 0.7, align: "right" },
  ];
  return (
    <Panel flush title="Lookups the assistant makes" meta={`${perQuestion} per question on average · sorted by calls`} metaWide testID="admin-agent-tools">
      {tools.length === 0 ? (
        <EmptyNote title="No lookups" body="The assistant answered every question in this window without looking anything up." />
      ) : compact ? (
        tools.map((tool, index) => (
          <ListRow
            key={tool.tool}
            first={index === 0}
            title={toolLabel(tool.tool)}
            sub={`${formatCount(tool.calls)} calls · typical ${formatSeconds(tool.p50)}${tool.failed > 0 ? ` · ${tool.failed} failed` : ""}`}
            trailing={<RowValue>{percentOf(tool.calls, current.toolCalls)}%</RowValue>}
            testID={`admin-agent-tool-${tool.tool}`}
          />
        ))
      ) : (
        <View>
          <TableHead columns={columns} />
          {tools.map((tool, index) => {
            const share = percentOf(tool.calls, current.toolCalls);
            return (
              <TableRow
                key={tool.tool}
                columns={columns}
                last={index === tools.length - 1}
                testID={`admin-agent-tool-${tool.tool}`}
                cells={[
                  <View key="name">
                    <Text variant="rowTitle">{toolLabel(tool.tool)}</Text>
                    <Text variant="mono" style={styles.id}>
                      {tool.tool}
                    </Text>
                  </View>,
                  <Text key="calls" style={styles.num}>{formatCount(tool.calls)}</Text>,
                  <View key="share" style={styles.shareCell}>
                    <View style={styles.track}>
                      <View style={[styles.fill, { width: `${share}%`, backgroundColor: graphColors.shared }]} />
                    </View>
                    <Text variant="meta">{share}%</Text>
                  </View>,
                  <Text key="p50" style={styles.num}>{formatSeconds(tool.p50)}</Text>,
                  <Text key="p95" style={styles.num}>{formatSeconds(tool.p95)}</Text>,
                  <Text key="failed" style={[styles.num, tool.failed > 0 && styles.bad]}>
                    {formatCount(tool.failed)}
                  </Text>,
                ]}
              />
            );
          })}
        </View>
      )}
    </Panel>
  );
}

function Recent({ report, onOpen }: { report: AgentReport; onOpen: (id: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const now = Date.now();
  const columns: readonly Column[] = useMemo(
    () => [
      { label: "When", flex: 1.1 },
      { label: "Workspace", flex: 1.2 },
      { label: "Via", flex: 0.7 },
      { label: "Model", flex: 1.6 },
      { label: "Ended", flex: 1.3 },
      { label: "Steps", flex: 1.6 },
      { label: "Answer time", flex: 1, align: "right" },
    ],
    [],
  );
  return (
    <Panel flush title="Recent questions" meta="tap one to see it step by step" metaWide testID="admin-agent-recent">
      {compact ? null : <TableHead columns={columns} />}
      {report.recent.map((turn, index) => {
        const where = turn.workspace ? `@${turn.workspace}` : "a deleted workspace";
        const ended = (
          <Pill tone={outcomeTone(turn.outcome)}>{outcomeLabel(turn.outcome)}</Pill>
        );
        return (
          <Pressable key={turn.id} onPress={() => onOpen(turn.id)} role="button" aria-label={`${where}, ${whenLabel(turn.at, now)}`} testID={`admin-agent-turn-${turn.id}`}>
            {compact ? (
              <ListRow
                first={index === 0}
                title={where}
                sub={`${whenLabel(turn.at, now)} · ${clientLabel(turn.client)} · ${outcomeLabel(turn.outcome)}`}
                trailing={<RowValue>{formatSeconds(turn.ms)}</RowValue>}
                below={<StepStrip turn={turn} />}
              />
            ) : (
              <TableRow
                columns={columns}
                last={index === report.recent.length - 1}
                cells={[
                  <Text key="when" variant="rowSub">{whenLabel(turn.at, now)}</Text>,
                  <Text key="ws" variant="rowTitle" numberOfLines={1}>{where}</Text>,
                  <Text key="via" variant="rowSub">{clientLabel(turn.client)}</Text>,
                  <Text key="model" variant="mono" numberOfLines={1} style={styles.id}>{turn.model}</Text>,
                  <View key="ended">{ended}</View>,
                  <View key="steps" style={styles.full}><StepStrip turn={turn} /></View>,
                  <Text key="ms" style={styles.num}>{formatSeconds(turn.ms)}</Text>,
                ]}
              />
            )}
          </Pressable>
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
    tile: { flexGrow: 1, flexBasis: 200, gap: 6 },
    tileCompact: { flexBasis: "45%" },
    big: {
      fontSize: pointerType.title,
      lineHeight: leading(pointerType.title, 1.2),
      fontWeight: "600",
      letterSpacing: -0.9,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    endings: { gap: 2 },
    good: { color: colors.okText },
    warn: { color: colors.warnText },
    bad: { color: colors.critText },
    shareBar: { flexDirection: "row", height: 10, borderRadius: 5, overflow: "hidden", marginBottom: space.x3, backgroundColor: colors.line },
    shareRow: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingVertical: 4 },
    swatch: { width: 10, height: 10, borderRadius: 2 },
    flex: { flex: 1 },
    num: { fontSize: pointerType.ui, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] },
    id: { fontSize: pointerType.label, color: colors.muted },
    shareCell: { flexDirection: "row", alignItems: "center", gap: space.x2, width: "100%" },
    track: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.line, overflow: "hidden" },
    fill: { height: "100%" },
    full: { width: "100%" },
    skGap: { marginTop: 14 },
  });
