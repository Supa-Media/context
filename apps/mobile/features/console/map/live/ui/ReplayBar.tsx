import { useRef } from "react";
import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Text } from "../../../../design/components/Text";
import { fonts, space } from "../../../../design/tokens";
import { useColors, useScheme, useThemedStyles, type Colors } from "../../../../design/theme";
import { darkMapColors, lightMapColors } from "../../../../design/tokens/colors";
import type { MapPageState } from "../hooks/useMapPage";
import { REPLAY_SPEEDS, clockText, dayText, fractionOf, replayTicks, type ReplayState } from "../replayClock";
import { RoundButton } from "./controls";

/**
 * The replay bar: play and pause, how fast, the clock, and the day (or the
 * week) as a track — taller bars where more happened, the marked moments
 * above it, the hours (or days) below, and a playhead to drag. The track is a
 * slider to a keyboard and a screen reader: arrows step, Shift steps further,
 * Home and End go to the ends.
 */
export function ReplayBar({ page, compact = false }: { page: MapPageState; compact?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const replay = page.replay;
  if (replay === null) {
    return (
      <View style={[styles.bar, compact && styles.barCompact]} testID="map-replay-bar">
        <Text variant="meta">{page.historyLoading ? "Gathering what happened…" : ""}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.bar, compact && styles.barCompact]} testID="map-replay-bar">
      <View style={styles.controls}>
        <RoundButton
          icon={replay.playing ? "pause" : "play"}
          label={replay.playing ? "Pause the replay" : "Play the replay"}
          filled
          size={compact ? 34 : 38}
          onPress={() => page.dispatch({ type: "toggle" })}
          testID="map-replay-play"
        />
        <View style={styles.speeds} accessibilityRole="radiogroup" accessibilityLabel="Replay speed">
          {REPLAY_SPEEDS.map((speed) => (
            <Pressable
              key={speed}
              onPress={() => page.dispatch({ type: "speed", speed })}
              accessibilityRole="radio"
              accessibilityState={{ checked: replay.speed === speed }}
              accessibilityLabel={`${speed} times speed`}
              style={[styles.speed, replay.speed === speed && styles.speedOn]}
              testID={`map-replay-speed-${speed}`}
            >
              <Text style={[styles.speedText, replay.speed === speed && styles.speedTextOn]}>{`${speed}×`}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={[styles.time, compact && styles.timeCompact]}>
        <Text style={[styles.clock, compact && styles.clockCompact]} testID="map-replay-clock">
          {clockText(replay.at)}
        </Text>
        <Text style={styles.day}>{dayText(replay.at, replay.to)}</Text>
      </View>
      <Track page={page} replay={replay} compact={compact} />
    </View>
  );
}

function Track({ page, replay, compact }: { page: MapPageState; replay: ReplayState; compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const map = useScheme() === "dark" ? darkMapColors : lightMapColors;
  const ref = useRef<View>(null);
  const max = Math.max(1, ...page.bars);
  const box = useRef({ x: 0, width: 1 });
  const head = fractionOf(replay.at, replay.from, replay.to);
  const ticks = replayTicks(replay.range, replay.from, replay.to);

  const measure = () => {
    const node = ref.current as unknown as { getBoundingClientRect?: () => { left: number; width: number } } | null;
    const rect = node?.getBoundingClientRect?.();
    if (rect) box.current = { x: rect.left, width: Math.max(1, rect.width) };
  };
  const seekTo = (event: GestureResponderEvent) => {
    const x = event.nativeEvent.pageX - box.current.x;
    const frac = Math.max(0, Math.min(1, x / box.current.width));
    page.dispatch({ type: "scrub", at: replay.from + frac * (replay.to - replay.from) });
  };

  return (
    <View
      ref={ref}
      style={[styles.track, compact && styles.trackCompact]}
      onLayout={(e) => {
        box.current = { x: box.current.x, width: Math.max(1, e.nativeEvent.layout.width) };
        measure();
      }}
      focusable
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Replay position"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(head * 100), text: `${clockText(replay.at)}, ${dayText(replay.at, replay.to)}` }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => page.dispatch({ type: "key", key: e.nativeEvent.actionName === "increment" ? "ArrowRight" : "ArrowLeft" })}
      {...({
        onKeyDown: (e: { key: string; shiftKey?: boolean; preventDefault?: () => void }) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
            e.preventDefault?.();
            page.dispatch({ type: "key", key: e.key, shift: !!e.shiftKey });
          } else if (e.key === " " || e.key === "Enter") {
            e.preventDefault?.();
            page.dispatch({ type: "toggle" });
          }
        },
      } as object)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        measure();
        seekTo(e);
      }}
      onResponderMove={seekTo}
      testID="map-replay-track"
    >
      {compact ? null : (
        <View style={styles.moments} pointerEvents="box-none">
          {page.moments.slice(0, 8).map((m, i) => (
            <Pressable
              key={`${m.at}-${i}`}
              onPress={() => page.dispatch({ type: "scrub", at: m.at })}
              accessibilityRole="button"
              accessibilityLabel={`Jump to ${m.label}, ${clockText(m.at)}`}
              style={[styles.moment, { left: `${fractionOf(m.at, replay.from, replay.to) * 100}%`, top: i % 2 ? 15 : 0 }]}
              testID="map-replay-moment"
            >
              <View style={[styles.momentDot, { backgroundColor: map.ink }]} />
              <Text style={styles.momentText} numberOfLines={1}>
                {isolateForDisplay(m.label)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={[styles.bars, compact && styles.barsCompact]} pointerEvents="none">
        {page.bars.map((count, i) => {
          const past = (i + 0.5) / page.bars.length <= head;
          return (
            <View
              key={i}
              style={[
                styles.histBar,
                { height: `${Math.max(6, (count / max) * 100)}%`, backgroundColor: past ? colors.text2 : map.dot, opacity: past ? 1 : 0.45 },
              ]}
            />
          );
        })}
      </View>
      <View style={[styles.head, compact && styles.headCompact, { left: `${head * 100}%` }]} pointerEvents="none" testID="map-replay-head">
        <View style={styles.knob} />
      </View>
      <View style={styles.ticks} pointerEvents="none">
        {ticks.map((tick) => (
          <Text key={tick.at} style={[styles.tick, { left: `${tick.frac * 100}%` }]}>
            {tick.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    bar: {
      height: 104,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.lineStrong,
      flexDirection: "row",
      alignItems: "center",
      gap: 18,
      paddingHorizontal: 20,
      backgroundColor: colors.pageSurface,
    },
    barCompact: { height: 76, gap: space.x3, paddingHorizontal: 0, borderTopWidth: 0, backgroundColor: "transparent" },
    controls: { alignItems: "center", gap: space.x2 },
    speeds: { flexDirection: "row", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, borderRadius: 8, overflow: "hidden" },
    speed: { paddingHorizontal: 7, paddingVertical: 3 },
    speedOn: { backgroundColor: colors.text },
    speedText: { fontFamily: fonts.body, fontSize: 11.5, fontWeight: "600", color: colors.text2 },
    speedTextOn: { color: colors.pageSurface },
    time: { width: 112 },
    timeCompact: { width: 84 },
    clock: { fontFamily: fonts.body, fontSize: 22, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] },
    clockCompact: { fontSize: 17 },
    day: { fontFamily: fonts.body, fontSize: 11.5, color: colors.chromeMuted },
    track: { flex: 1, height: 92, position: "relative", cursor: "pointer" } as object,
    trackCompact: { height: 60 },
    moments: { position: "absolute", left: 0, right: 0, top: 0, height: 30 },
    moment: { position: "absolute", flexDirection: "row", alignItems: "center", gap: 4, transform: [{ translateX: -4 }] },
    momentDot: { width: 6, height: 6, borderRadius: 3 },
    momentText: { fontFamily: fonts.body, fontSize: 11, fontWeight: "600", color: colors.text2 },
    bars: { position: "absolute", left: 0, right: 0, top: 34, height: 38, flexDirection: "row", alignItems: "flex-end", gap: 2 },
    barsCompact: { top: 8, height: 32 },
    histBar: { flex: 1, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
    head: { position: "absolute", top: 28, height: 44, width: 2, marginLeft: -1, backgroundColor: colors.text, borderRadius: 1 },
    headCompact: { top: 2, height: 40 },
    knob: {
      position: "absolute",
      left: -5,
      top: -6,
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: colors.text,
      borderWidth: 3,
      borderColor: colors.pageSurface,
    },
    ticks: { position: "absolute", left: 0, right: 0, bottom: 0, height: 14 },
    tick: { position: "absolute", fontFamily: fonts.body, fontSize: 11, color: colors.chromeMuted, transform: [{ translateX: -10 }] },
  });
