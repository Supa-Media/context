/**
 * One question, step by step: every thinking round and every lookup on one
 * time axis, with the slowest step outlined and a sentence saying how it
 * compares with that lookup's typical time over the window.
 *
 * Everything here is in the turn log already — names, durations, counts —
 * which is the footer's promise: the question and the answer are never kept,
 * so no view of a turn can show them.
 */

import { Pressable, StyleSheet, View } from "react-native";
import { Card, Pill, Text, leading, radii, space, useColors, useTheme, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { useCompact } from "./AdminKit";
import {
  clientLabel,
  formatSeconds,
  keptUntil,
  outcomeLabel,
  outcomeTone,
  slowestStep,
  stepStrip,
  waterfall,
  whenLabel,
  type AgentReport,
  type AgentTurnRow,
} from "./agent";
import { formatCount } from "./report";

export function AgentTurn({
  turn,
  tools,
  onBack,
}: {
  turn: AgentTurnRow;
  tools: AgentReport["tools"];
  onBack: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const steps = waterfall(turn);
  const slowest = slowestStep(turn.trace, new Map(tools.map((tool) => [tool.tool, tool.p50])));
  const lookups = turn.trace.filter((step) => step.kind === "tool").length;
  const where = turn.workspace ? `@${turn.workspace}` : "A deleted workspace";

  return (
    <View style={styles.section} testID="admin-agent-detail">
      <Pressable onPress={onBack} role="button" style={styles.back} testID="admin-agent-back">
        <Text variant="meta" style={styles.backText}>
          ← Agent · Recent questions
        </Text>
      </Pressable>
      <View style={styles.head}>
        <View style={styles.flex}>
          <Text variant="paneTitle">
            {where} · {whenLabel(turn.at)}
          </Text>
          <Text variant="meta">
            {clientLabel(turn.client)} · {turn.provider} · {turn.model} · Kept until {keptUntil(turn.at)}
          </Text>
        </View>
        <Pill tone={outcomeTone(turn.outcome)} testID="admin-agent-outcome">
          {outcomeLabel(turn.outcome)}
        </Pill>
      </View>

      <View style={styles.stats}>
        <Stat label="Answer time" value={formatSeconds(turn.ms)} />
        <Stat label="Thinking rounds" value={formatCount(turn.rounds)} />
        <Stat label="Lookups" value={formatCount(lookups)} />
        <Stat label="Tokens in / out" value={`${formatCount(turn.inputTokens)} / ${formatCount(turn.outputTokens)}`} />
      </View>

      <Card style={styles.card}>
        <Text variant="eyebrow">Step by step</Text>
        {slowest ? (
          <Text variant="rowSub" style={styles.sentence} testID="admin-agent-slowest">
            {slowest.sentence}
          </Text>
        ) : null}
        <View style={styles.rows}>
          {steps.map((step, index) => (
            <View key={index} style={[styles.row, compact && styles.rowCompact]} testID={`admin-agent-step-${index}`}>
              <Text variant="rowSub" numberOfLines={1} style={[styles.name, compact && styles.nameCompact]}>
                {step.label}
                {step.ok ? "" : " (failed)"}
              </Text>
              <View style={styles.lane}>
                <Bar step={step} outlined={slowest?.index === index} />
              </View>
              <Text style={styles.ms}>{formatSeconds(step.ms)}</Text>
            </View>
          ))}
        </View>
        <View style={styles.axis}>
          <Text variant="meta">0 s</Text>
          <Text variant="meta">{formatSeconds(turn.ms)}</Text>
        </View>
      </Card>

      <Text variant="meta" style={styles.footer}>
        Only timings, tool names and counts are kept. The question, the answer and what the assistant looked at are
        never stored.
      </Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card style={styles.stat}>
      <Text variant="eyebrow">{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </Card>
  );
}

function Bar({ step, outlined }: { step: ReturnType<typeof waterfall>[number]; outlined: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { graphColors } = useTheme();
  const fill = !step.ok ? colors.crit : step.kind === "model" ? colors.accent : graphColors.shared;
  return (
    <View
      style={[
        styles.bar,
        { left: `${step.left}%`, width: `${Math.max(step.width, 0.6)}%`, backgroundColor: fill },
        outlined && { boxShadow: `0 0 0 2px ${colors.surface}, 0 0 0 3.5px ${colors.text}` },
      ]}
    />
  );
}

/** The tiny strip on a recent row: teal thinking, purple lookups, red where one failed. */
export function StepStrip({ turn }: { turn: Pick<AgentTurnRow, "ms" | "trace"> }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { graphColors } = useTheme();
  return (
    <View style={styles.strip} aria-hidden>
      {stepStrip(turn).map((step, index) => (
        <View
          key={index}
          style={{
            width: `${step.width}%`,
            backgroundColor: !step.ok ? colors.crit : step.kind === "model" ? colors.accent : graphColors.shared,
          }}
        />
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x4 },
    back: { alignSelf: "flex-start" },
    backText: { color: colors.accentText },
    head: { flexDirection: "row", alignItems: "flex-start", gap: space.x3 },
    flex: { flex: 1, minWidth: 0, gap: 4 },
    stats: { flexDirection: "row", flexWrap: "wrap", gap: space.x3 },
    stat: { flexGrow: 1, flexBasis: 140, gap: 6 },
    statValue: {
      fontSize: pointerType.lede,
      lineHeight: leading(pointerType.lede, 1.3),
      fontWeight: "600",
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    card: { gap: space.x3 },
    sentence: { color: colors.text },
    rows: { gap: 6 },
    row: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    rowCompact: { gap: space.x2 },
    name: { width: 150 },
    nameCompact: { width: 96 },
    lane: { flex: 1, height: 14, position: "relative", backgroundColor: colors.chipFill, borderRadius: radii.xs },
    bar: { position: "absolute", top: 0, bottom: 0, borderRadius: radii.xs },
    ms: {
      width: 56,
      textAlign: "right",
      fontSize: pointerType.meta,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    axis: { flexDirection: "row", justifyContent: "space-between", marginLeft: 162, marginRight: 68 },
    footer: { textAlign: "center" },
    strip: { flexDirection: "row", height: 6, width: "100%", borderRadius: 3, overflow: "hidden", backgroundColor: colors.line },
  });
