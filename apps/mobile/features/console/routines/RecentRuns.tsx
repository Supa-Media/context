import { useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { densityFor, type Density } from "../../app/frame";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { layout, radii, space } from "../../design/tokens";
import { useRoutineHost } from "./RoutineHost";
import { runWhen, runWords, type RoutineRow, type RoutineRun } from "./model";

/** The right-hand column's width on a wide window (board r2). */
export const RUNS_ASIDE_WIDTH = 300;

/**
 * Where the recent runs go at each density: beside the note on a wide window,
 * a folded section under the bar on a medium one (whose editor scrolls itself,
 * so nothing below it would be reachable), and a folded section after the
 * note's last line on a phone, where the note and everything after it scroll
 * as one page.
 */
export function runsPlacement(density: Density): "aside" | "top" | "below" {
  return density === "wide" ? "aside" : density === "medium" ? "top" : "below";
}

function usePlacement() {
  return runsPlacement(densityFor(useWindowDimensions().width));
}

/** The column beside a routine note on a wide window. Nothing anywhere else. */
export function RecentRunsAside() {
  const host = useRoutineHost();
  const styles = useThemedStyles(makeStyles);
  const placement = usePlacement();
  if (host === null || host.row === null || placement !== "aside") return null;
  return (
    <View style={styles.aside} testID="routine-runs-aside">
      <Text variant="eyebrow" style={styles.head}>
        Recent runs
      </Text>
      <ScrollView style={styles.asideScroll} contentContainerStyle={styles.asideList}>
        <RunList runs={host.runs} send={host.row?.send ?? "text"} />
      </ScrollView>
    </View>
  );
}

/** The folded section, drawn only where `runsPlacement` puts it. */
export function RecentRunsSection({ where, gutter }: { where: "top" | "below"; gutter: number }) {
  const host = useRoutineHost();
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const placement = usePlacement();
  const [open, setOpen] = useState(false);
  if (host === null || host.row === null || placement !== where) return null;
  const count = host.runs?.length ?? 0;
  return (
    <View style={[styles.section, { paddingLeft: gutter, paddingRight: gutter }]} testID="routine-runs-section">
      <PressRow
        accessibilityLabel={open ? "Hide recent runs" : "Show recent runs"}
        ariaExpanded={open}
        onPress={() => setOpen((current) => !current)}
        radius={radii.sm}
        style={[styles.sectionHead, where === "below" && styles.sectionHeadTouch]}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} color={colors.muted} />
        <Text variant="treeMeta">{host.runs === null ? "Recent runs" : `Recent runs (${count})`}</Text>
      </PressRow>
      {open ? (
        <View style={styles.sectionList}>
          <RunList runs={host.runs} send={host.row?.send ?? "text"} />
        </View>
      ) : null}
    </View>
  );
}

/** The runs, newest first. Exported for its test. */
export function RunList({ runs, send, now }: { runs: RoutineRun[] | null; send: RoutineRow["send"]; now?: number }) {
  const styles = useThemedStyles(makeStyles);
  if (runs === null) {
    return (
      <Text variant="meta" style={styles.quiet}>
        Reading…
      </Text>
    );
  }
  if (runs.length === 0) {
    return (
      <Text variant="meta" style={styles.quiet} testID="routine-runs-empty">
        No runs yet.
      </Text>
    );
  }
  const at = now ?? Date.now();
  return (
    <>
      {runs.map((run, index) => {
        const words = runWords(run, send);
        const shown = run.text !== "" && (run.outcome === "answered" || run.outcome === "finished");
        return (
          <View key={`${run.at}-${index}`} style={[styles.run, index > 0 && styles.runRule]} testID="routine-run">
            <View style={styles.runHead}>
              <Text variant="meta" style={styles.runWhen}>
                {runWhen(run.at, at)}
              </Text>
              <Text variant="meta" style={styles.runLabel} testID="routine-run-label">
                {words.label}
              </Text>
            </View>
            {shown ? (
              <View style={styles.bubble}>
                <Text variant="rowSub" style={styles.bubbleText}>
                  {run.text}
                </Text>
              </View>
            ) : words.detail === null ? null : (
              <Text variant="meta" style={styles.quiet}>
                {words.detail}
              </Text>
            )}
          </View>
        );
      })}
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    aside: {
      width: RUNS_ASIDE_WIDTH,
      flexShrink: 0,
      minHeight: 0,
      borderLeftWidth: 1,
      borderLeftColor: colors.line,
      paddingTop: space.x4,
    },
    head: { paddingHorizontal: space.x5, paddingBottom: space.x2 },
    asideScroll: { flex: 1, minHeight: 0 },
    asideList: { paddingHorizontal: space.x5, paddingBottom: space.x6 },
    section: { paddingBottom: space.x2 },
    sectionHead: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 6,
      minHeight: 24,
      paddingRight: space.x2,
    },
    sectionHeadTouch: { minHeight: layout.minTouchTarget },
    sectionList: { paddingTop: space.x1 },
    run: { paddingVertical: space.x3, gap: 6 },
    runRule: { borderTopWidth: 1, borderTopColor: colors.line },
    runHead: { flexDirection: "row", justifyContent: "space-between", gap: space.x2 },
    runWhen: { color: colors.text2 },
    runLabel: { color: colors.muted },
    bubble: {
      alignSelf: "flex-start",
      maxWidth: "100%",
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
      borderRadius: radii.card,
      backgroundColor: colors.surface3,
    },
    bubbleText: { color: colors.text },
    quiet: { color: colors.muted },
  });
