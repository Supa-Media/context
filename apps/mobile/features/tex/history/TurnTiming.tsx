import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { T } from "../page/TexPageParts";
import { seconds, turnTimingView, type TimingRow, type TurnTimingSource, type TurnTimingView } from "./turnTiming";

type Look = "page" | "file" | "phone";

/** The pill on a turn's first text from Tex: the wait the person had, amber at 10 s or more. */
export function TimingPill({ view, open, onPress, id }: { view: TurnTimingView; open: boolean; onPress: () => void; id: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`Where this turn's ${seconds(view.totalMs)} went`}
      onPress={onPress}
      style={[styles.pill, view.slow ? styles.pillSlow : null]}
      testID={`tex-history-timing-pill-${id}`}
    >
      <T size={12} weight={view.slow ? "600" : "400"} tone={view.slow ? "warn" : "muted"}>
        {`${seconds(view.totalMs)}${open ? " ▾" : ""}`}
      </T>
    </Pressable>
  );
}

/** The view for a line's timing, or null when its reply kept none. */
export function timingFor(source: TurnTimingSource | undefined): TurnTimingView | null {
  return source === undefined ? null : turnTimingView(source);
}

/**
 * Where one turn's time went, under its line (the artboard Dev approved on
 * 2026-11-03): a verdict naming the slowest step, the total split by kind, and
 * a waterfall on one clock where the slowest step is the only solid bar.
 */
export function TurnTiming({ view, look, id }: { view: TurnTimingView; look: Look; id: string }) {
  const styles = useThemedStyles(makeStyles);
  const phone = look === "phone";
  // Folded when another step plainly dominates, or on a phone: the slow step reads first.
  const [setupOpen, setSetupOpen] = useState(!phone && !view.rows.some((r) => r.slowest && r.kind !== "setup" && r.ms / Math.max(1, view.totalMs) > 0.6));
  const [raw, setRaw] = useState(false);
  const tick = phone || view.spanMs > 40_000 ? 10_000 : 5_000;
  // A tick too near the end would run off it: the last one sits before nine tenths of the span.
  const ticks = Array.from({ length: Math.floor(view.spanMs / tick) + 1 }, (_, i) => i * tick).filter((at) => at === 0 || at <= view.spanMs * 0.9);
  const labelWidth = phone ? 116 : 300;
  const pct = (ms: number) => `${Math.min(100, (ms / view.spanMs) * 100)}%` as const;

  const bar = (row: TimingRow) => (
    <View style={styles.track}>
      {ticks.map((at) => (
        <View key={at} style={[styles.grid, { left: pct(at) }]} />
      ))}
      <View
        style={[
          styles.bar,
          row.children ? styles.barGroup : row.slowest ? styles.barSlowest : row.failed ? styles.barFailed : null,
          { left: pct(row.start), width: `${Math.max(0.6, Math.min(100, (row.ms / view.spanMs) * 100))}%` },
        ]}
      />
    </View>
  );

  const line = (row: TimingRow, inner = false) => (
    <View key={row.key} testID={`tex-history-timing-row-${row.key}`}>
      <View style={styles.row}>
        <Pressable disabled={!row.children} onPress={() => setSetupOpen((was) => !was)} style={[styles.label, { width: labelWidth }, inner ? styles.inner : null]} accessibilityRole={row.children ? "button" : undefined}>
          <T size={13} weight={row.slowest ? "600" : "400"} tone={row.failed ? "crit" : inner ? "text2" : "text"} numberOfLines={1}>
            {row.children ? `${setupOpen ? "▾" : "▸"} ` : ""}
            {row.failed ? "✕ " : ""}
            {row.label}
            {!phone && row.code && row.kind !== "tool" && row.code !== row.label ? (
              <T size={12} mono tone="muted">{` ${row.code}`}</T>
            ) : null}
          </T>
        </Pressable>
        {bar(row)}
        <T size={13} weight={row.slowest ? "600" : "400"} tone={row.slowest ? "text" : "muted"} style={styles.ms}>
          {row.after ? `+${seconds(row.ms)}` : seconds(row.ms)}
        </T>
      </View>
      {row.detail ? (
        <T size={12} tone="muted" style={inner ? styles.inner : null}>
          {row.detail}
        </T>
      ) : null}
      {row.children && setupOpen ? row.children.map((child) => line(child, true)) : null}
    </View>
  );

  return (
    <View style={[styles.panel, look === "file" ? styles.panelFile : look === "page" ? styles.panelPage : null]} testID={`tex-history-timing-${id}`}>
      <T size={15} line={1.45}>
        {view.verdict.lead}
        <T size={15} weight="600">
          {view.verdict.strong}
        </T>
        {view.verdict.rest}
      </T>
      {view.split ? (
        <T size={13} tone="muted" style={styles.split}>
          {view.split}
        </T>
      ) : null}
      <View style={styles.row}>
        <View style={{ width: labelWidth }} />
        <View style={styles.axis}>
          {ticks.map((at) => (
            <T key={at} size={11} tone="muted" numberOfLines={1} style={[styles.tick, { left: pct(at) }]}>
              {`${at / 1000} s`}
            </T>
          ))}
        </View>
        <View style={styles.ms} />
      </View>
      {view.rows.map((row) => line(row))}
      <Pressable accessibilityRole="button" onPress={() => setRaw((was) => !was)} style={styles.rawToggle} testID={`tex-history-timing-raw-${id}`}>
        <T size={13} tone="accent">{`Raw timing ${raw ? "▾" : "▸"}`}</T>
      </Pressable>
      {raw ? (
        <ScrollView horizontal style={styles.raw}>
          <T size={12} mono line={1.45} tone="text2">
            {JSON.stringify(view.raw, null, 2)}
          </T>
        </ScrollView>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pill: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 1, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong },
    pillSlow: { backgroundColor: colors.warnWash, borderColor: colors.warnBorder },
    panel: { borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: 14, paddingVertical: 6, marginBottom: 8, gap: 2 },
    // Under the words, past the time and who columns (`HistoryDayLines`).
    panelFile: { marginLeft: 72 + 12 + 128 + 12 },
    panelPage: { marginLeft: 64 + 12 + 56 + 12 },
    split: { marginBottom: 6 },
    row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 24 },
    label: { flexShrink: 0 },
    inner: { paddingLeft: 16 },
    track: { flex: 1, height: 20, justifyContent: "center" },
    grid: { position: "absolute", top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: colors.line },
    bar: { position: "absolute", height: 5, borderRadius: 3, backgroundColor: colors.lineStrong },
    barSlowest: { height: 6, backgroundColor: colors.text },
    barFailed: { backgroundColor: colors.crit },
    barGroup: { height: 6, backgroundColor: "transparent", borderWidth: 1, borderColor: colors.lineStrong },
    ms: { width: 64, textAlign: "right", fontVariant: ["tabular-nums"] },
    axis: { flex: 1, height: 16 },
    tick: { position: "absolute", top: 0, width: 40 },
    rawToggle: { alignSelf: "flex-start", paddingTop: 8 },
    raw: { backgroundColor: colors.surface2, borderRadius: 8, padding: 10, marginTop: 4 },
  });
