import { useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "../../design/components/Text";
import { TextLink } from "../../design/components/TextLink";
import { useThemedStyles, type Colors } from "../../design/theme";
import { meetings } from "../controller";
import { useMeetingsSnapshot } from "../useMeetings";

/**
 * THE OTHER SIDE OF THE CALL IS NOT BEING RECORDED, SAID WHERE IT CANNOT BE MISSED.
 *
 * A declined or silent share used to surface as one truncated line in the
 * phone's chip, and as nothing at all in the console's live card, which is
 * where a browser meeting is usually watched from. People recorded whole calls
 * that held only their own voice and found out from the note. So the warning
 * is a band on every live surface, and it carries the fix: a press that asks
 * for the call's audio again and mixes it in from that moment.
 *
 * The button is a fresh press, which is what the browser's picker needs; it
 * calls straight into the controller without awaiting anything first.
 */
export function CallAudioWarning({
  testID = "meeting-call-audio-warning",
  style,
}: {
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useThemedStyles(makeStyles);
  const snapshot = useMeetingsSnapshot();
  const [asking, setAsking] = useState(false);
  const warning = snapshot.callAudioWarning;
  if (warning == null || snapshot.live == null) return null;

  const share = () => {
    setAsking(true);
    void meetings.shareCallAudio().finally(() => setAsking(false));
  };

  /*
    One short line in the warning colour, and under it, only where asking again
    can work (a browser's picker), the fix as one muted sentence that starts
    with its own link. The desktop app's fix is a system setting, which its own
    sentence names. This used to be a four-line paragraph over a full-size
    button: the card's loudest thing by far, and too long to read mid-call.
  */
  return (
    <View style={[styles.band, style]} testID={testID}>
      <Text variant="rowSub" style={styles.text}>
        {warning}
      </Text>
      {!snapshot.capture.systemAudioNeedsPicker ? null : (
        <Text variant="rowSub" style={styles.hint}>
          <TextLink
            label={asking ? "Waiting for the browser…" : "Share call audio"}
            onPress={share}
            disabled={asking}
            testID={`${testID}-share`}
          />
          {asking ? null : ", then allow audio in the picker."}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    band: { gap: 2 },
    text: { color: colors.critText },
    hint: { color: colors.muted },
  });
