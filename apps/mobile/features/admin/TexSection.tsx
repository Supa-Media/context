/**
 * The Tex tab: how many texts Tex handles, what they cost and on which
 * models, which tools it reaches for, how its conversations score, which
 * tasks frustrate people, and Explore to slice all of it (the owner,
 * 2026-10-24, from the approved dashboard concept).
 *
 * The figures are `texReport` (`apps/convex/functions/lib/adminFns/
 * texReport.ts`); the words and arithmetic are `./tex`. It keeps its own
 * window: scores reach back ninety days, turns thirty.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Card, Text, leading, space, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { EmptyNote, NoticeLine, Panel, Skeleton, TwoUp, useCompact } from "./AdminKit";
import { TrendBars } from "./Charts";
import { Segments } from "./Segments";
import { TexExplore } from "./TexExplore";
import {
  KIND_LABELS,
  TEX_WINDOWS,
  formatMicroUsd,
  frustrationByTask,
  isFrustrated,
  modelLabel,
  scoreAverages,
  textsHandled,
  type TexReport,
  type TexWindow,
} from "./tex";
import { formatCount } from "./report";

export function TexSection() {
  const styles = useThemedStyles(makeStyles);
  const [days, setDays] = useState<TexWindow>("30");
  const report = useQuery(api.functions.admin.texReport, { days: Number(days) });
  return (
    <View style={styles.section} testID="admin-tex">
      <View style={styles.filters}>
        <Segments options={TEX_WINDOWS} value={days} onChange={setDays} label="Window" testID="admin-tex-days" />
        <Text variant="meta" style={styles.kept}>
          Scores are kept 90 days, turns 30
        </Text>
      </View>
      {report === undefined ? <Loading /> : <Body report={report} />}
    </View>
  );
}

function Loading() {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card aria-busy testID="admin-loading">
      <Skeleton width={140} height={14} />
      <Skeleton width={90} height={30} style={styles.skGap} />
      <Skeleton width="100%" height={120} style={styles.skGap} />
    </Card>
  );
}

function Body({ report }: { report: TexReport }) {
  const styles = useThemedStyles(makeStyles);
  const { turns, reviews } = report;
  if (turns.total === 0 && reviews.length === 0) {
    return (
      <Card>
        <EmptyNote title="Nothing from Tex in this window" body="Texts and scores appear here as soon as somebody texts Tex." />
      </Card>
    );
  }
  const texts = textsHandled(report);
  const frustrated = reviews.length === 0 ? null : reviews.filter(isFrustrated).length / reviews.length;
  const perText = turns.priced === 0 ? null : turns.costMicroUsd / turns.priced;
  return (
    <>
      {turns.truncated || report.reviewsTruncated ? (
        <NoticeLine mark="!" tone="warn">
          This window holds more than the tab reads at once; the figures cover the newest.
        </NoticeLine>
      ) : null}
      <View style={styles.tiles}>
        <Tile label="Texts handled" value={formatCount(texts)} sub={`${formatCount(turns.total)} turns in ${report.turnDays} days, jobs included`} testID="admin-tex-texts" />
        <Tile label="Spend" value={formatMicroUsd(turns.costMicroUsd)} sub={`list price, ${formatCount(turns.priced)} priced turns`} testID="admin-tex-spend" />
        <Tile label="Cost per turn" value={perText === null ? "—" : formatMicroUsd(perText)} sub="all models in the turn" testID="admin-tex-per-text" />
        <Tile label="Conversations scored" value={formatCount(reviews.length)} sub={`in ${report.days} days`} testID="admin-tex-scored" />
        <Tile
          label="Frustrated"
          value={frustrated === null ? "—" : `${Math.round(frustrated * 100)}%`}
          sub="a signal showed, or calm 4 or under"
          tone={frustrated !== null && frustrated > 0.25 ? "crit" : "neutral"}
          testID="admin-tex-frustrated"
        />
      </View>
      <TwoUp>
        <Panel title="Turns per day" meta={`${report.turnDays} days`} testID="admin-tex-daily">
          <TrendBars points={turns.byDay.map((day) => ({ day: day.day, count: day.turns }))} />
        </Panel>
        <Panel title="Spend per day" meta="list price" testID="admin-tex-daily-spend">
          <TrendBars points={turns.byDay.map((day) => ({ day: day.day, count: day.costMicroUsd }))} />
        </Panel>
      </TwoUp>
      <TwoUp>
        <Panel title="Scorecard" meta="average of 10" help="Haiku scores each finished conversation 1 to 10 on five things. Higher is better; calm 10 is no frustration at all." testID="admin-tex-scores">
          {scoreAverages(reviews).map((score) => (
            <Bar key={score.key} label={score.label} share={score.value === null ? 0 : score.value / 10} value={score.value === null ? "—" : score.value.toFixed(1)} />
          ))}
        </Panel>
        <Panel title="What frustrates people" meta="by task" help="Share of each task's conversations where a frustration signal showed or calm scored 4 or under. Open Explore below to slice further." testID="admin-tex-by-task">
          {reviews.length === 0 ? (
            <Text variant="meta">No scored conversations yet.</Text>
          ) : (
            frustrationByTask(reviews).slice(0, 8).map((row) => (
              <Bar key={row.task} label={`${row.label} (${row.n})`} share={row.share} value={`${Math.round(row.share * 100)}%`} tone="crit" />
            ))
          )}
        </Panel>
      </TwoUp>
      <TwoUp>
        <Panel title="Where texts come from" meta={`${report.turnDays} days`} testID="admin-tex-kinds">
          {(Object.entries(turns.byKind) as [string, number][])
            .filter(([, count]) => count > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([kind, count]) => (
              <Bar key={kind} label={KIND_LABELS[kind] ?? kind} share={turns.total === 0 ? 0 : count / turns.total} value={formatCount(count)} />
            ))}
        </Panel>
        <Panel title="Models" meta="turns · tokens in/out · spend" testID="admin-tex-models">
          {turns.models.slice(0, 6).map((model) => (
            <View key={model.model} style={styles.line}>
              <Text variant="rowSub" style={styles.flex} numberOfLines={1}>
                {modelLabel(model.model)}
              </Text>
              <Text variant="meta" style={styles.num}>
                {formatCount(model.turns)} · {formatTokens(model.inputTokens)}/{formatTokens(model.outputTokens)} · {formatMicroUsd(model.costMicroUsd)}
              </Text>
            </View>
          ))}
        </Panel>
      </TwoUp>
      <Panel title="Tools" meta="calls · failed" testID="admin-tex-tools">
        {turns.tools.length === 0 ? (
          <Text variant="meta">No tool calls in this window.</Text>
        ) : (
          turns.tools.slice(0, 10).map((tool) => (
            <Bar
              key={tool.tool}
              label={tool.tool}
              share={tool.calls / turns.tools[0].calls}
              value={`${formatCount(tool.calls)}${tool.failed > 0 ? ` · ${Math.round((tool.failed / tool.calls) * 100)}% failed` : ""}`}
            />
          ))
        )}
      </Panel>
      <TexExplore reviews={reviews} />
    </>
  );
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

function Tile({ label, value, sub, tone = "neutral", testID }: { label: string; value: string; sub: string; tone?: "crit" | "neutral"; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <Card style={StyleSheet.flatten([styles.tile, compact && styles.tileCompact])} testID={testID}>
      <Text variant="eyebrow">{label}</Text>
      <Text style={[styles.big, tone === "crit" && styles.bad]}>{value}</Text>
      <Text variant="meta">{sub}</Text>
    </Card>
  );
}

function Bar({ label, share, value, tone }: { label: string; share: number; value: string; tone?: "crit" }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.barRow}>
      <Text variant="rowSub" style={styles.barLabel} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.track}>
        <View style={[styles.fill, tone === "crit" && styles.fillCrit, { width: `${Math.max(0, Math.min(1, share)) * 100}%` }]} />
      </View>
      <Text variant="meta" style={styles.barValue}>
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x4 },
    filters: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x3 },
    kept: { marginLeft: "auto" },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.x3 },
    tile: { flexGrow: 1, flexBasis: 170, gap: 6 },
    tileCompact: { flexBasis: "45%" },
    big: {
      fontSize: pointerType.title,
      lineHeight: leading(pointerType.title, 1.2),
      fontWeight: "600",
      letterSpacing: -0.9,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    bad: { color: colors.critText },
    line: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingVertical: 6 },
    flex: { flex: 1, color: colors.text },
    num: { fontVariant: ["tabular-nums"] },
    barRow: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingVertical: 5 },
    barLabel: { width: 190, color: colors.text },
    track: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: "hidden" },
    fill: { height: "100%", backgroundColor: colors.accent },
    fillCrit: { backgroundColor: colors.critText },
    barValue: { minWidth: 56, textAlign: "right", fontVariant: ["tabular-nums"] },
    skGap: { marginTop: 14 },
  });
