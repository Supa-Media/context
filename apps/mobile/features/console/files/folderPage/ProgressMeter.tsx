/**
 * How far along a task is, as a short bar and a fraction ("2/4"): the List
 * row's progress (the owner, 2026-09-29: "show a loading bar & fraction"
 * instead of "1 of 6 done"). On a pointer layout it has its own column after
 * the name (`PROGRESS_COLUMN`) so the bars line up down the list; on a phone
 * it sits beside the name. It is one line that never shrinks. Screen readers hear "2 of 4 done".
 */

import { StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";

/** The bar's width: short enough to sit beside a name, long enough to read a fifth. */
export const METER_WIDTH = 40;
/** The List's progress column: the bar and the widest fraction likely ("12/30"). */
export const PROGRESS_COLUMN = 88;

/** The share done, 0 to 100, whole. */
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((100 * Math.min(Math.max(done, 0), total)) / total);
}

export function ProgressMeter({ done, total, testID }: { done: number; total: number; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={styles.meter}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={`${done} of ${total} done`}
      testID={testID}
    >
      <View style={styles.track} testID="progress-track">
        <View style={[styles.fill, { width: `${progressPercent(done, total)}%` }]} testID="progress-fill" />
      </View>
      <Text variant="meta" numberOfLines={1} style={styles.fraction} testID="progress-fraction">
        {`${done}/${total}`}
      </Text>
    </View>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    meter: { flexDirection: "row", alignItems: "center", gap: space.x2, flexShrink: 0, whiteSpace: "nowrap" } as never,
    track: { width: METER_WIDTH, height: 4, borderRadius: 2, backgroundColor: colors.lineStrong, overflow: "hidden" },
    fill: { height: "100%", backgroundColor: colors.accent },
    fraction: { color: colors.chromeMuted, fontVariant: ["tabular-nums"] },
  });
}
