import { StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { useThemedStyles, type Colors } from "../../design/theme";
import { useSplitAudioLevel } from "../capture";
import { useMeetingsSnapshot } from "../useMeetings";
import { Waveform } from "./Waveform";

/**
 * Two labelled lines, You and Call, for the console's live card.
 *
 * Seeing the call's line move is how somebody knows the other side is being
 * heard, before any warning has to say it isn't (board m3, 2026-10-17). A
 * room meeting has no call, so it draws one line called Room. The Call line
 * is flat and grey whenever nothing is measuring a call (no share, a refused
 * one, a browser that cannot), and only green when something is.
 *
 * Its own component for `LiveWaveform`'s reason: the level arrives ten times a
 * second, and only this leaf re-renders for it.
 */
export function LiveMeters({ live, testID }: { live: boolean; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  const snapshot = useMeetingsSnapshot();
  const level = useSplitAudioLevel(live);
  const room = snapshot.callAudioNote?.kind === "room";
  const callMissing =
    snapshot.callAudioWarning != null || snapshot.callAudioNote != null;
  const callLevel = level?.call ?? null;
  const hearingCall = live && !callMissing && callLevel !== null;

  return (
    <View style={styles.grid} testID={testID}>
      <View style={styles.row}>
        <Text variant="foot" style={styles.label}>
          {room ? "Room" : "You"}
        </Text>
        <Waveform
          tone={live ? "ok" : "muted"}
          live={live}
          level={level?.you ?? null}
          testID={testID === undefined ? undefined : `${testID}-you`}
        />
      </View>
      {room ? null : (
        <View style={styles.row}>
          <Text variant="foot" style={styles.label}>
            Call
          </Text>
          <Waveform
            tone={hearingCall ? "ok" : "muted"}
            live={hearingCall}
            level={hearingCall ? callLevel : null}
            testID={testID === undefined ? undefined : `${testID}-call`}
          />
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    grid: { gap: 6 },
    row: { flexDirection: "row", alignItems: "center", gap: 10 },
    label: { color: colors.muted, width: 40 },
  });
