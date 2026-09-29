import { Pressable, Text as Inline, ScrollView, StyleSheet, View } from "react-native";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { castTimeLabel } from "../home/cast/castTimeline";
import type { ScriptRow } from "./studioScript";

/**
 * The script, one row a step: when it starts, who does it, what they do.
 * Pressing a row plays the scene from there. The row playing now is marked,
 * and the ones already played are quieter.
 */
export function StudioScriptRail({
  rows,
  current,
  colors: memberColors,
  problems,
  onJump,
}: {
  rows: readonly ScriptRow[];
  current: number;
  colors: ReadonlyMap<string, string>;
  problems: readonly string[];
  onJump: (index: number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const fallbackFace = useColors().muted;
  return (
    <View style={styles.rail}>
      <Text variant="eyebrow" style={styles.head}>
        Script
      </Text>
      <ScrollView contentContainerStyle={styles.list}>
        {rows.map((row) => {
          const now = row.index === current;
          const done = row.index < current;
          return (
            <Pressable
              key={row.index}
              onPress={() => onJump(row.index)}
              accessibilityRole="button"
              accessibilityLabel={`Play from ${row.actor?.name ?? ""} ${row.says}`.trim()}
              aria-current={now ? "step" : undefined}
              style={({ pressed }) => [styles.row, now ? styles.rowNow : pressed ? styles.rowHover : null]}
              testID={`studio-step-${row.index}`}
            >
              <Text variant="treeMetaMono" style={[styles.time, now ? styles.timeNow : null]}>
                {row.at === null ? "–" : castTimeLabel(row.at)}
              </Text>
              {row.actor === null ? (
                <View style={[styles.face, styles.waitFace]}>
                  <Icon name="clock" size={14} />
                </View>
              ) : (
                <View style={[styles.face, { backgroundColor: memberColors.get(row.actor.name) ?? fallbackFace }]}>
                  {row.actor.kind === "agent" ? <Icon name="robot" size={15} color="#FFFFFF" /> : null}
                </View>
              )}
              <Text variant="rowSub" style={[styles.says, done ? styles.saysDone : null]} numberOfLines={2}>
                {row.actor === null ? null : <Inline style={styles.who}>{`${row.actor.name} `}</Inline>}
                {row.says}
              </Text>
            </Pressable>
          );
        })}
        {rows.length === 0 ? (
          <Text variant="rowSub" style={styles.empty}>
            This note has no cast yet. Add a ```cast block to it to make a scene.
          </Text>
        ) : null}
        {problems.map((problem) => (
          <Text key={problem} variant="rowSub" style={styles.problem}>
            {`Skipped, not understood: ${problem}`}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    rail: { width: 360, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.line, backgroundColor: colors.chromeSurface },
    head: { paddingHorizontal: space.x5, paddingTop: space.x4, paddingBottom: space.x2, color: colors.muted },
    list: { paddingHorizontal: space.x2, paddingBottom: space.x5, gap: 2 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: 48,
      paddingHorizontal: space.x3,
      paddingVertical: space.x2,
      borderRadius: radii.xl,
    },
    rowNow: { backgroundColor: colors.accentDim },
    rowHover: { backgroundColor: colors.chipFill },
    time: { width: 36, color: colors.muted },
    timeNow: { color: colors.accentText },
    face: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
    waitFace: { backgroundColor: colors.chipFill },
    says: { flex: 1, color: colors.text },
    saysDone: { color: colors.muted },
    who: { fontWeight: "600" },
    empty: { padding: space.x4, color: colors.muted },
    problem: { paddingHorizontal: space.x3, paddingTop: space.x2, color: colors.crit },
  });
