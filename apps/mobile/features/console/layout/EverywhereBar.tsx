import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { fonts, layout, pointerType, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { SearchableContext } from "../search/results";
import { SLOW_MS, seconds, type TimingBreakdown } from "./everywhereSearch";
import { useEverywhereSearch, type EverywhereSearch } from "./useEverywhereSearch";
import type { PaletteSearch } from "../../design/components/Palette";
import { useBlendedDeviceSearch } from "../../offline/useDeviceSearch";
import type { Reachability } from "../../offline/copy";

/**
 * ⌘K's chrome for searching every workspace: the timing pill beside the field,
 * and under it the workspace chips and, when the pill is pressed, where the
 * time went. Drawn from the approved boards (Dev2, 2026-10-10: "build it"),
 * https://claude.ai/artifact/LXa6CCDcrd6zZtxkggJZTK.
 */

/** The pill: how long the last search took. Green under a second, amber over. */
export function TimingPill({
  timing,
  settled,
  open,
  onToggle,
}: {
  timing: TimingBreakdown | null;
  settled: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  if (timing === null) return null;
  const slow = timing.total > SLOW_MS;
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`Search took ${seconds(timing.total)}. ${open ? "Hide" : "Show"} where the time went`}
      style={[styles.pill, slow ? styles.pillSlow : styles.pillFast, settled ? null : styles.pillStale]}
      testID="palette-timing"
    >
      <View style={[styles.dot, slow ? styles.dotSlow : styles.dotFast]} />
      <Text style={[styles.pillText, slow ? styles.textSlow : styles.textFast]}>{seconds(timing.total)}</Text>
    </Pressable>
  );
}

/** "All workspaces" and one chip per workspace, scrolling sideways when there are many. */
export function WorkspaceChips({
  contexts,
  narrowed,
  typedScope,
  onNarrow,
}: {
  contexts: readonly SearchableContext[];
  narrowed: string | null;
  typedScope: boolean;
  onNarrow: (slug: string | null) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  // One workspace is nothing to choose between.
  if (contexts.length < 2) return null;
  const chip = (slug: string | null, label: string) => {
    const on = narrowed === slug;
    return (
      <Pressable
        key={slug ?? "all"}
        onPress={() => onNarrow(slug)}
        // Narrowed by "@name " in the field, the field is what widens it.
        disabled={typedScope}
        accessibilityRole="button"
        accessibilityState={{ selected: on, disabled: typedScope }}
        style={({ pressed }) => [styles.chip, on ? styles.chipOn : null, pressed ? styles.pressed : null]}
        testID={`palette-scope-${slug ?? "all"}`}
      >
        <Text style={[styles.chipText, on ? styles.chipTextOn : null]} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    );
  };
  return (
    <View style={styles.chipRow}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
        {chip(null, "All workspaces")}
        {contexts.map((context) => chip(context.slug, `@${context.slug}`))}
      </ScrollView>
      <Text style={styles.hint} numberOfLines={1}>
        {typedScope ? "Delete the @name to search everywhere" : "or type @name first"}
      </Text>
    </View>
  );
}

/** Where the time went: the three searches, the trip, and each workspace. */
export function TimingPanel({ timing }: { timing: TimingBreakdown }) {
  const styles = useThemedStyles(makeStyles);
  const scale = Math.max(timing.total, 1);
  const lane = (label: string, ms: number | null, tone: "words" | "meaning" | "travel" | "workspace" | "slowest") =>
    ms === null ? null : (
      <View key={label} style={styles.lane}>
        <Text style={styles.laneLabel} numberOfLines={1}>{label}</Text>
        <View style={styles.track}>
          <View style={[styles.bar, styles[tone], { width: `${Math.min(100, (ms / scale) * 100)}%` }]} />
        </View>
        <Text style={styles.laneMs}>{seconds(ms)}</Text>
      </View>
    );
  return (
    <View style={styles.panel} testID="palette-timing-panel">
      <Text style={styles.panelTitle}>
        {`Search took ${seconds(timing.total)}, from sending it to the answer arriving`}
      </Text>
      <Text style={styles.eyebrow}>Run at the same time</Text>
      {lane("Has your words", timing.words, "words")}
      {lane("Same topic", timing.meaning, "meaning")}
      {lane("Getting there and back", timing.travel, "travel")}
      {timing.workspaces.length > 1 ? <Text style={styles.eyebrow}>By workspace</Text> : null}
      {timing.workspaces.length > 1
        ? timing.workspaces.map((each) =>
            lane(`@${each.slug}${each.slowest ? " · slowest" : ""}`, each.ms, each.slowest ? "slowest" : "workspace"),
          )
        : null}
      <Text style={styles.same}>
        Same search your AI uses: the same words over the same workspaces give Claude or ChatGPT these
        notes in this order, less any its connection is not allowed to see.
      </Text>
    </View>
  );
}

/** What ⌘K draws with: its search, and the pill and bar around the field. */
export interface PaletteChrome {
  search: PaletteSearch | undefined;
  accessory: ReactNode;
  bar: ReactNode;
  /** The every-workspace search, or `null` where ⌘K searches the old way. */
  everywhere: EverywhereSearch | null;
}

/**
 * ⌘K's search of every workspace, where it runs, and the old one where not.
 *
 * Mounted only while ⌘K is open, so the fan-out and its subscription live no
 * longer than the palette does. `enabled` false — a folder's "Search in", a
 * visitor, the landing page's demo — never mounts the hooks at all: those
 * consoles have no workspaces to fan out over, and the demo has no Convex
 * client to ask.
 */
export function PaletteSearchHost({
  enabled,
  fallback,
  currentSlug,
  contexts,
  reachability,
  render,
}: {
  enabled: boolean;
  /** The single-workspace search (`usePaletteSearch`), used where this does not run. */
  fallback: PaletteSearch | undefined;
  currentSlug: string | null;
  contexts: readonly { id: string; slug: string; displayName: string; role: string }[];
  reachability: Reachability;
  render: (chrome: PaletteChrome) => ReactNode;
}) {
  if (!enabled) return <>{render({ search: fallback, accessory: null, bar: undefined, everywhere: null })}</>;
  return <EverywhereOn currentSlug={currentSlug} contexts={contexts} reachability={reachability} render={render} />;
}

function EverywhereOn({
  currentSlug,
  contexts,
  reachability,
  render,
}: {
  currentSlug: string | null;
  contexts: readonly { id: string; slug: string; displayName: string; role: string }[];
  reachability: Reachability;
  render: (chrome: PaletteChrome) => ReactNode;
}) {
  const device = useBlendedDeviceSearch(contexts, reachability);
  const everywhere = useEverywhereSearch({ enabled: true, currentSlug, device });
  const [open, setOpen] = useState(false);
  const accessory = (
    <TimingPill
      timing={everywhere.timing}
      settled={everywhere.settled}
      open={open}
      onToggle={() => setOpen((was) => !was)}
    />
  );
  const bar = (
    <View>
      <WorkspaceChips
        contexts={everywhere.contexts}
        narrowed={everywhere.narrowed}
        typedScope={everywhere.typedScope}
        onNarrow={everywhere.narrow}
      />
      {open && everywhere.timing !== null ? <TimingPanel timing={everywhere.timing} /> : null}
    </View>
  );
  return <>{render({ search: everywhere.search, accessory, bar, everywhere })}</>;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      height: 28,
      paddingHorizontal: space.x2,
      borderRadius: radii.pill,
      borderWidth: 1,
      marginLeft: space.x2,
    },
    pillFast: { backgroundColor: colors.okWash, borderColor: colors.okBorder },
    pillSlow: { backgroundColor: colors.warnWash, borderColor: colors.warnBorder },
    pillStale: { opacity: 0.55 },
    dot: { width: 7, height: 7, borderRadius: 4 },
    dotFast: { backgroundColor: colors.okText },
    dotSlow: { backgroundColor: colors.warnText },
    pillText: { fontFamily: fonts.mono, fontSize: pointerType.meta, fontWeight: "500" },
    textFast: { color: colors.okText },
    textSlow: { color: colors.warnText },
    chipRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: layout.readingMargin,
      paddingBottom: space.x2,
    },
    chips: { gap: space.x2 },
    chip: {
      minHeight: 32,
      paddingHorizontal: space.x3,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      justifyContent: "center",
    },
    chipOn: { backgroundColor: colors.text, borderColor: colors.text },
    chipText: { fontFamily: fonts.body, fontSize: pointerType.ui, color: colors.text2 },
    chipTextOn: { color: colors.ground, fontWeight: "600" },
    pressed: { opacity: 0.6 },
    hint: { flexShrink: 1, fontFamily: fonts.body, fontSize: pointerType.meta, color: colors.muted },
    panel: {
      marginHorizontal: layout.readingMargin,
      marginBottom: space.x2,
      padding: space.x3,
      gap: space.x2,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
    },
    panelTitle: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "600", color: colors.text },
    eyebrow: { fontFamily: fonts.body, fontSize: pointerType.label, fontWeight: "600", color: colors.muted, textTransform: "uppercase", marginTop: space.x1 },
    lane: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    laneLabel: { width: 170, fontFamily: fonts.body, fontSize: pointerType.meta, color: colors.text2 },
    track: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.surface3, overflow: "hidden" },
    bar: { height: 8, borderRadius: 4 },
    words: { backgroundColor: colors.accent },
    meaning: { backgroundColor: colors.sharedText },
    travel: { backgroundColor: colors.muted },
    workspace: { backgroundColor: colors.text2 },
    slowest: { backgroundColor: colors.warnText },
    laneMs: { width: 56, textAlign: "right", fontFamily: fonts.mono, fontSize: pointerType.meta, color: colors.text },
    same: { fontFamily: fonts.body, fontSize: pointerType.meta, color: colors.text2, marginTop: space.x1 },
  });
