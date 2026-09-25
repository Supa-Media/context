/**
 * The top of the Growth tab: the two headline cards and the pair strip.
 *
 * A headline card **is** its figure — the total, the window's arrivals and
 * the change on the window before, then the curve, then three facts on a
 * hairline — so the Accounts and Contexts cards end on the same structure and
 * are the same height by construction. The pair strip holds the two figures
 * that are not growth: paying and active contexts.
 */

import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import {
  Card,
  Text,
  leading,
  radii,
  space,
  useTheme,
  useThemedStyles,
  type Colors,
} from "../design";
import { pointerType, touchType } from "../design/tokens";
import { DeltaText, Panel, useCompact, usePanelPad } from "./AdminKit";
import { EmptyGrowthArea, GrowthArea, WithheldGrowthArea } from "./GrowthArea";
import { formatCount, type Point } from "./report";

export interface Fact {
  label: string;
  /** What a phone says, where the full label would be cut. */
  short?: string;
  value: string;
  /** "of 30", in the quiet voice after the figure. */
  unit?: string;
  /** A 3pt bar under the figure: its share of the pair. */
  share?: { part: number; tone: "accent" | "shared" };
}

export function HeadlineCard({
  label,
  value,
  newInWindow,
  newInPrior,
  days,
  chart,
  facts,
  testID,
}: {
  label: string;
  value: string;
  newInWindow: number;
  newInPrior: number;
  days: number;
  chart: ReactNode;
  facts: readonly Fact[];
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const pad = usePanelPad();
  const change = newInWindow - newInPrior;
  return (
    <Panel style={styles.fill} testID={testID}>
      <View style={styles.head}>
        <View>
          <Text style={styles.headLabel}>{label}</Text>
          <Text style={[styles.big, compact && styles.bigCompact]}>{value}</Text>
        </View>
        <View style={styles.headRight}>
          {newInWindow === 0 && newInPrior === 0 ? (
            <Text variant="meta">none new in {days} days</Text>
          ) : (
            <>
              <Text variant="meta">
                <Text style={styles.headCount}>{formatCount(newInWindow)}</Text> new in {days} days
              </Text>
              <Text variant="meta">
                <DeltaText change={change} /> on the {days} before
              </Text>
            </>
          )}
        </View>
      </View>
      {chart}
      <View
        style={[
          styles.facts,
          { marginHorizontal: -pad.x, marginBottom: -pad.y },
        ]}
      >
        {facts.map((fact, index) => (
          <View
            key={fact.label}
            style={[
              styles.fact,
              compact ? styles.factCompact : { paddingHorizontal: pad.x },
              compact && index === 0 && { paddingLeft: pad.x },
              index > 0 && styles.factRuled,
            ]}
          >
            <Text variant="meta" numberOfLines={1}>
              {compact && fact.short ? fact.short : fact.label}
            </Text>
            <Text style={styles.factValue}>
              {fact.value}
              {fact.unit ? <Text variant="meta" style={styles.unit}> {fact.unit}</Text> : null}
            </Text>
            {fact.share ? <ShareBar {...fact.share} /> : null}
          </View>
        ))}
      </View>
    </Panel>
  );
}

export function Curve({
  truncated,
  empty,
  cumulative,
  added,
  testID,
}: {
  truncated: boolean;
  empty: string | null;
  cumulative: readonly Point[];
  added: readonly Point[];
  testID: string;
}) {
  // Withheld rather than drawn from a partial page, and the testID goes with
  // it: `adminPaneRender.test.ts` asserts the curve is absent, not blank.
  if (truncated) return <WithheldGrowthArea />;
  return (
    <View testID={testID}>
      {empty !== null ? (
        <EmptyGrowthArea message={empty} />
      ) : (
        <GrowthArea cumulative={cumulative} added={added} />
      )}
    </View>
  );
}

function ShareBar({ part, tone }: { part: number; tone: "accent" | "shared" }) {
  const styles = useThemedStyles(makeStyles);
  const { colors, graphColors } = useTheme();
  return (
    <View style={styles.shareTrack} aria-hidden>
      <View
        style={[
          styles.shareFill,
          {
            width: `${Math.round(part * 1000) / 10}%`,
            backgroundColor: tone === "shared" ? graphColors.shared : colors.accent,
          },
        ]}
      />
    </View>
  );
}

// -- the pair strip -------------------------------------------------------

export function PairStrip({
  cells,
}: {
  cells: readonly {
    label: string;
    caption: string;
    value: string;
    ok?: boolean;
    testID: string;
  }[];
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <Card style={StyleSheet.flatten([styles.pair, compact && styles.pairCompact])}>
      {cells.map((cell, index) => (
        <View
          key={cell.testID}
          style={[
            styles.pairCell,
            compact && styles.pairCellCompact,
            index > 0 && styles.factRuled,
          ]}
          testID={cell.testID}
        >
          <View style={compact ? null : styles.pairWords}>
            <Text variant="meta" style={styles.pairLabel}>
              {cell.label}
            </Text>
            <Text variant="meta">{cell.caption}</Text>
          </View>
          <Text style={[styles.pairValue, compact && styles.pairValueCompact, cell.ok && styles.ok]}>
            {cell.value}
          </Text>
        </View>
      ))}
    </Card>
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
    headRight: { alignItems: "flex-end" },
    headLabel: {
      fontSize: pointerType.ui,
      lineHeight: leading(pointerType.ui, 1.55),
      fontWeight: "600",
      color: colors.text,
    },
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
    headCount: { fontSize: pointerType.ui, fontWeight: "600", color: colors.text },

    facts: {
      flexDirection: "row",
      marginTop: 18,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    fact: { flex: 1, minWidth: 0, paddingTop: 12, paddingBottom: 14, minHeight: 72 },
    factCompact: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12, minHeight: 66 },
    factRuled: { borderLeftWidth: 1, borderLeftColor: colors.line },
    factValue: {
      marginTop: 1,
      fontSize: touchType.lede,
      lineHeight: leading(touchType.lede, 1.4),
      fontWeight: "600",
      letterSpacing: -0.3,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    unit: { fontWeight: "400", letterSpacing: 0 },
    shareTrack: {
      height: 3,
      marginTop: 6,
      borderRadius: radii.pill,
      backgroundColor: colors.line,
      overflow: "hidden",
    },
    shareFill: { height: "100%", borderRadius: radii.pill },

    pair: { flexDirection: "row", paddingVertical: 0, paddingHorizontal: 0 },
    pairCompact: { paddingVertical: 0, paddingHorizontal: 0 },
    pairCell: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.x3,
      paddingVertical: 14,
      paddingHorizontal: space.x5,
    },
    pairCellCompact: {
      flexDirection: "column",
      alignItems: "flex-start",
      justifyContent: "flex-start",
      gap: 2,
      paddingVertical: space.x3,
      paddingHorizontal: space.x4,
    },
    pairWords: { flexShrink: 1 },
    pairLabel: { color: colors.muted },
    pairValue: {
      fontSize: pointerType.h2,
      lineHeight: leading(pointerType.h2, 1.2),
      fontWeight: "600",
      letterSpacing: -0.8,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    pairValueCompact: { fontSize: touchType.h2, lineHeight: leading(touchType.h2, 1.2) },
    ok: { color: colors.ok },
  });
