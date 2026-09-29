import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { castTimeLabel } from "../home/cast/castTimeline";
import type { ScriptRow } from "./studioScript";
import type { StudioPlayer } from "./useStudioPlayer";

/**
 * Under the stage: play or pause, restart, the time, a bar with a mark for
 * every step (pressing a mark plays from that step), and Loop, which plays the
 * scene again each time it ends while a sound or a line is being tuned.
 */
export function StudioTransport({ player, rows, total }: { player: StudioPlayer; rows: readonly ScriptRow[]; total: number }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const playing = player.status === "playing";
  const progress = total <= 0 ? 0 : Math.min(1, player.time / total);
  return (
    <View style={styles.bar}>
      <Pressable
        onPress={player.toggle}
        disabled={player.status === "loading"}
        accessibilityRole="button"
        accessibilityLabel={playing ? "Pause" : "Play"}
        style={[styles.round, player.status === "loading" ? styles.dim : null]}
        testID="studio-play"
      >
        <Icon name={playing ? "pause" : "play"} size={18} color={colors.ground} />
      </Pressable>
      <Pressable onPress={player.restart} accessibilityRole="button" accessibilityLabel="Restart" style={styles.square} testID="studio-restart">
        <Icon name="undo" size={18} />
      </Pressable>
      <Text variant="treeMetaMono" style={styles.time}>
        {`${castTimeLabel(player.time)} / ${castTimeLabel(total)}`}
      </Text>
      <View style={styles.track} accessibilityLabel={`Scene position ${castTimeLabel(player.time)}`}>
        <View style={styles.rule}>
          <View style={[styles.fill, { width: `${progress * 100}%` }]} />
        </View>
        {rows.map((row) =>
          row.at === null ? null : (
            <Pressable
              key={row.index}
              onPress={() => player.jump(row.index)}
              accessibilityRole="button"
              accessibilityLabel={`Play from ${castTimeLabel(row.at)}`}
              style={[styles.tick, { left: `${total <= 0 ? 0 : (row.at / total) * 100}%` }]}
            >
              <View style={[styles.tickMark, row.index <= player.current ? styles.tickPlayed : null]} />
            </Pressable>
          ),
        )}
      </View>
      <Pressable
        onPress={() => player.setLoop(!player.loop)}
        accessibilityRole="switch"
        aria-checked={player.loop}
        accessibilityLabel="Loop"
        style={[styles.loop, player.loop ? styles.loopOn : null]}
        testID="studio-loop"
      >
        <Text variant="rowSub" style={player.loop ? styles.loopTextOn : styles.loopText}>
          Loop
        </Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    bar: { flexDirection: "row", alignItems: "center", gap: space.x3, paddingHorizontal: space.x5, paddingVertical: space.x3 },
    round: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
    dim: { opacity: 0.4 },
    square: { width: 44, height: 44, borderRadius: radii.xl, alignItems: "center", justifyContent: "center" },
    time: { width: 92, color: colors.muted },
    track: { flex: 1, height: 44, justifyContent: "center" },
    rule: { height: 6, borderRadius: 3, backgroundColor: colors.lineStrong, overflow: "hidden" },
    fill: { height: 6, backgroundColor: colors.accent },
    tick: { position: "absolute", top: 0, width: 20, height: 44, marginLeft: -10, alignItems: "center", justifyContent: "center" },
    tickMark: { width: 2, height: 14, borderRadius: 1, backgroundColor: colors.muted },
    tickPlayed: { backgroundColor: colors.accent },
    loop: { height: 44, paddingHorizontal: space.x4, borderRadius: radii.xl, alignItems: "center", justifyContent: "center" },
    loopOn: { backgroundColor: colors.accentDim },
    loopText: { color: colors.text2 },
    loopTextOn: { color: colors.accentText, fontWeight: "600" },
  });
