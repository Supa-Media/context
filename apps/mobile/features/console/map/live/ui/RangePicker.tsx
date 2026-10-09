import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type GestureResponderEvent } from "react-native";
import { Button } from "../../../../design/components/Button";
import { Text } from "../../../../design/components/Text";
import { space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { useHistoryDays } from "../hooks/useHistoryDays";
import type { MapPageState } from "../hooks/useMapPage";
import { DEFAULT_LENGTH, dateShort, dateText, lengthLabel } from "../replayClock";
import { Chip } from "./controls";
import {
  SHORTCUTS,
  changesText,
  countIn,
  dragEnd,
  dragStart,
  fitSelection,
  litShortcuts,
  nudge,
  selectionStretch,
  shortcutSelection,
  startFieldText,
  stretchSelection,
  stripFor,
  type Selection,
} from "./rangeModel";

/** Where the Custom chip sits in the window, so the popover can hang under it. */
export type Anchor = { x: number; y: number; width: number; height: number };

const POPOVER_WIDTH = 640;
/** The days a stretch starts on when nothing has been picked: the past week. */
const DEFAULT_DAYS = 7;

/**
 * Pick a stretch of time to replay, by day. A popover under the Custom chip on
 * a desktop; a sheet from the bottom on a phone. The activity strip has a bar
 * per day since the first change, and two handles on the day boundaries: the
 * start handle is the first day, the end handle past the last one, and at
 * today's end it means "now". Shortcut pills set the handles to a common span.
 * Two read-only fields say where the stretch starts and ends, and the count
 * says what it holds. Escape, or a press outside, closes it.
 */
export function RangePicker({
  page,
  compact,
  anchor,
  onClose,
}: {
  page: MapPageState;
  compact: boolean;
  anchor: Anchor | null;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { width: windowWidth } = useWindowDimensions();
  const history = useHistoryDays(page.workspaceIds);
  const now = page.now;
  const strip = useMemo(() => stripFor(history.days, history.startsAt, now), [history.days, history.startsAt, now]);
  const { starts, counts } = strip;
  const n = starts.length;

  // A pick is kept until the strip changes length under it; before any pick, the page's own stretch or the past week.
  const [picked, setPicked] = useState<Selection | null>(null);
  const sel = fitSelection(
    picked ?? (page.custom !== null ? stretchSelection(page.custom, starts) : { s: Math.max(0, n - DEFAULT_DAYS), b: n }),
    n,
  );
  const lit = litShortcuts(sel, n);
  const changes = countIn(counts, sel);
  const startText = startFieldText(starts[sel.s]!);
  const endText = sel.b >= n ? "Now" : dateText(starts[sel.b - 1]!);
  const changesWord = changesText(changes);

  // Escape closes it, on the web build; the Modal's own back gesture does on a phone.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const play = () => {
    page.playStretch(selectionStretch(sel, starts, Date.now()));
    onClose();
  };

  // The strip is one drag surface: the handle nearer the finger moves.
  const stripNode = useRef<View>(null);
  const box = useRef({ x: 0, width: 1 });
  const grabbed = useRef<"start" | "end">("end");
  const measure = () => {
    const node = stripNode.current as unknown as { getBoundingClientRect?: () => { left: number; width: number } } | null;
    const rect = node?.getBoundingClientRect?.();
    if (rect) box.current = { x: rect.left, width: Math.max(1, rect.width) };
  };
  const boundaryAt = (event: GestureResponderEvent) => {
    const frac = Math.max(0, Math.min(1, (event.nativeEvent.pageX - box.current.x) / box.current.width));
    return Math.round(frac * n);
  };
  const dragTo = (boundary: number) => setPicked(grabbed.current === "start" ? dragStart(sel, boundary, n) : dragEnd(sel, boundary, n));

  const keyFor = (edge: "start" | "end") => ({
    onKeyDown: (event: { key: string; shiftKey?: boolean; preventDefault?: () => void }) => {
      const days = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
      if (days === 0) return;
      event.preventDefault?.();
      setPicked(nudge(sel, edge, event.shiftKey ? days * 7 : days, n));
    },
  });

  const body = (
    <View style={[styles.panel, compact ? styles.sheet : { width: Math.min(POPOVER_WIDTH, windowWidth - 16) }]} testID="map-range-picker">
      <View style={compact ? styles.headStack : styles.headRow}>
        <Text variant="paneTitle">Replay a stretch of time</Text>
        <Text variant="meta" style={styles.muted}>
          {history.startsAt === null
            ? history.loading
              ? "Gathering your history…"
              : "No changes in this context yet"
            : `History goes back to ${dateText(history.startsAt)}`}
        </Text>
      </View>

      <View style={styles.pills}>
        {SHORTCUTS.map((shortcut) => (
          <Chip
            key={shortcut.key}
            label={shortcut.label}
            on={lit.includes(shortcut.key)}
            onPress={() => setPicked(shortcutSelection(shortcut.key, n))}
            testID={`map-range-${shortcut.key}`}
          />
        ))}
      </View>

      {history.loading ? (
        <Text variant="meta" style={styles.muted} testID="map-range-loading">
          Gathering your history…
        </Text>
      ) : (
        <View style={styles.strip} ref={stripNode} onLayout={(e) => (box.current = { x: box.current.x, width: Math.max(1, e.nativeEvent.layout.width) })}>
          <View style={styles.bars} pointerEvents="none">
            {counts.map((count, i) => {
              const max = Math.max(1, ...counts);
              const inside = i >= sel.s && i < sel.b;
              return (
                <View
                  key={starts[i]}
                  style={[styles.bar, { height: `${Math.max(2, (count / max) * 100)}%`, backgroundColor: inside ? colors.accent : colors.lineStrong }]}
                />
              );
            })}
          </View>
          <View
            style={[styles.box, { left: `${(sel.s / n) * 100}%`, width: `${((sel.b - sel.s) / n) * 100}%`, borderColor: colors.accent }]}
            pointerEvents="none"
          />
          <View
            style={[styles.handle, { left: `${(sel.s / n) * 100}%`, backgroundColor: colors.accent, borderColor: colors.pageSurface }]}
            pointerEvents="none"
            {...({ focusable: true } as object)}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Start of the stretch"
            accessibilityValue={{ text: startText }}
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(e) => setPicked(nudge(sel, "start", e.nativeEvent.actionName === "increment" ? 1 : -1, n))}
            {...(keyFor("start") as object)}
            testID="map-range-start"
          />
          <View
            style={[styles.handle, { left: `${(sel.b / n) * 100}%`, backgroundColor: colors.accent, borderColor: colors.pageSurface }]}
            pointerEvents="none"
            {...({ focusable: true } as object)}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="End of the stretch"
            accessibilityValue={{ text: endText }}
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(e) => setPicked(nudge(sel, "end", e.nativeEvent.actionName === "increment" ? 1 : -1, n))}
            {...(keyFor("end") as object)}
            testID="map-range-end"
          />
          <View
            style={StyleSheet.absoluteFill}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={(e) => {
              measure();
              const at = boundaryAt(e);
              grabbed.current = Math.abs(at - sel.s) <= Math.abs(at - sel.b) ? "start" : "end";
              dragTo(at);
            }}
            onResponderMove={(e) => dragTo(boundaryAt(e))}
            testID="map-range-strip"
          />
        </View>
      )}

      {history.loading || n === 0 ? null : (
        <View style={styles.dates}>
          {dateLabels(starts, n).map((label, i) => (
            <Text key={`${i}-${label}`} variant="meta" style={styles.muted}>
              {label}
            </Text>
          ))}
        </View>
      )}

      <View style={compact ? styles.fieldsStack : styles.fieldsRow}>
        <Field label="From" value={startText} />
        <Field label="To" value={endText} />
        {compact ? null : <View style={styles.spacer} />}
        <Text variant="rowTitle" testID="map-range-count">
          {`${changesWord} · plays in ${lengthLabel(DEFAULT_LENGTH)}`}
        </Text>
      </View>

      {compact ? (
        <Button
          label={`Replay ${changesWord}`}
          variant="dialogPrimary"
          disabled={history.loading}
          onPress={play}
          style={styles.fullWidth}
          testID="map-range-replay"
        />
      ) : (
        <View style={styles.footer}>
          <Button label="Cancel" variant="dialog" onPress={onClose} testID="map-range-cancel" />
          <Button label="Replay" variant="dialogPrimary" disabled={history.loading} onPress={play} testID="map-range-replay" />
        </View>
      )}
    </View>
  );

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" testID="map-range-scrim">
        {compact ? (
          <View style={styles.bottom}>
            <Pressable onPress={() => {}} style={styles.sheetWrap}>
              <ScrollView>{body}</ScrollView>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => {}}
            style={[styles.popover, { top: (anchor?.y ?? 80) + (anchor?.height ?? 0) + 6, left: clampLeft(anchor?.x ?? 16, windowWidth) }]}
          >
            {body}
          </Pressable>
        )}
      </Pressable>
    </Modal>
  );
}

/** The strip's date labels: the first day, the last as "Now", and between them up to three more dates. */
export function dateLabels(starts: readonly number[], n: number): string[] {
  if (n === 1) return ["Now"];
  const k = Math.min(5, n);
  const out: string[] = [];
  for (let j = 0; j < k - 1; j++) out.push(dateShort(starts[Math.round((j * (n - 1)) / (k - 1))]!));
  out.push("Now");
  return out;
}

function clampLeft(x: number, windowWidth: number): number {
  return Math.max(8, Math.min(x, windowWidth - POPOVER_WIDTH - 8));
}

function Field({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.field}>
      <Text variant="meta" style={styles.muted}>
        {label}
      </Text>
      <Text variant="rowTitle">{value}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: colors.scrim },
    popover: { position: "absolute" },
    bottom: { flex: 1, justifyContent: "flex-end" },
    sheetWrap: { width: "100%" },
    panel: {
      gap: space.x3,
      padding: space.x4,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      backgroundColor: colors.pageSurface,
    },
    sheet: { width: "100%", borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
    headRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.x3 },
    headStack: { gap: space.x1 },
    muted: { color: colors.chromeMuted },
    pills: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    strip: { height: 96, position: "relative", overflow: "hidden", cursor: "pointer" } as object,
    bars: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, flexDirection: "row", alignItems: "flex-end", gap: 1 },
    bar: { flex: 1, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
    box: { position: "absolute", top: 0, bottom: 0, borderWidth: 2, borderRadius: 6 },
    handle: {
      position: "absolute",
      top: "50%",
      width: 16,
      height: 16,
      marginLeft: -8,
      marginTop: -8,
      borderRadius: 8,
      borderWidth: 2,
    },
    dates: { flexDirection: "row", justifyContent: "space-between" },
    fieldsRow: { flexDirection: "row", alignItems: "flex-end", gap: space.x3 },
    fieldsStack: { gap: space.x2 },
    field: { gap: 2, minWidth: 130 },
    spacer: { flex: 1 },
    footer: { flexDirection: "row", justifyContent: "flex-end", gap: space.x2 },
    fullWidth: { alignSelf: "stretch" },
  });
