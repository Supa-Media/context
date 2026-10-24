import { useState } from "react";
import { Linking, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { getDesktopBridge } from "@context/desktop-bridge";
import { Text } from "../../design/components/Text";
import { TextLink } from "../../design/components/TextLink";
import { useThemedStyles, type Colors } from "../../design/theme";
import { MAC_APP_URL, browserName, onMac, onPhoneOrTablet } from "../capture";
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
 * The link is a fresh press, which is what the browser's picker needs; it
 * calls straight into the controller without awaiting anything first.
 *
 * Three shapes, one line each plus a muted fix (boards m3/m4, 2026-10-17):
 *
 *  - **Asked and given no sound**: the warning colour, then "Share call audio
 *    and turn on Also share system audio". On a Mac in a browser that is not
 *    Chrome (Arc, Brave, Edge) a second muted line: Mac browsers need System
 *    Settings' permission and a restart after it changes, and some cannot hand
 *    over sound at all yet — Dev2's Arc said "already checked" and still
 *    failed. Chrome on a Mac gets its own line: with the switch on and Chrome
 *    not allowed in macOS's "Screen & System Audio Recording", the share
 *    hands back a dead audio track, so the switch is not the whole fix.
 *  - **Not asked, on purpose** (`callAudioNote`): this browser failed the last
 *    few times, or the person chose to record the room. Muted, not red —
 *    nothing was chosen wrong — with a link that asks after all.
 *  - **A browser that can never share sound** (Safari, Firefox on a computer):
 *    the warning colour once, and where to record calls instead. It was
 *    silent before, so those meetings recorded one side with nothing said.
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
  if (snapshot.live == null) return null;

  const share = () => {
    setAsking(true);
    void meetings.shareCallAudio().finally(() => setAsking(false));
  };
  const shareLink = (label: string) => (
    <TextLink
      label={asking ? "Waiting for the browser…" : label}
      onPress={share}
      disabled={asking}
      testID={`${testID}-share`}
    />
  );
  const macApp = (
    <TextLink
      label="Mac app"
      onPress={() => void Linking.openURL(MAC_APP_URL).catch(() => {})}
      testID={`${testID}-mac-app`}
    />
  );
  const browser = browserName();
  const picker = snapshot.capture?.systemAudioNeedsPicker === true;

  const warning = snapshot.callAudioWarning;
  if (warning != null) {
    return (
      <View style={[styles.band, style]} testID={testID}>
        <Text variant="rowSub" style={styles.text}>
          {warning}
        </Text>
        {!picker ? null : (
          <Text variant="rowSub" style={styles.hint}>
            {shareLink("Share call audio")}
            {asking ? null : " and turn on Also share system audio."}
          </Text>
        )}
        {!picker || !onMac() ? null : browser === "Chrome" ? (
          <Text variant="rowSub" style={styles.hint} testID={`${testID}-mac`}>
            {"Already on? Allow Chrome in System Settings › Privacy & Security › Screen & System Audio Recording, or use the "}
            {macApp}.
          </Text>
        ) : (
          <Text variant="rowSub" style={styles.hint} testID={`${testID}-mac`}>
            {`Already on? Quit and reopen ${browser === "This browser" ? "your browser" : browser}, or record in Chrome or the `}
            {macApp}.
          </Text>
        )}
      </View>
    );
  }

  const note = snapshot.callAudioNote;
  if (note != null) {
    return (
      <View style={[styles.band, style]} testID={`${testID}-note`}>
        <Text variant="rowSub" style={styles.hint}>
          {`${note.message} `}
          {shareLink(note.kind === "room" ? "Add call audio" : "Try again")}
        </Text>
      </View>
    );
  }

  if (snapshot.capture != null && cannotHearCalls(snapshot.capture)) {
    return (
      <View style={[styles.band, style]} testID={`${testID}-cannot`}>
        <Text variant="rowSub" style={styles.text}>
          {`${browser === "This browser" ? "This browser" : browser} can't hear the call, only your voice.`}
        </Text>
        <Text variant="rowSub" style={styles.hint}>
          {"Record calls in Chrome or the "}
          {macApp}.
        </Text>
      </View>
    );
  }

  return null;
}

/**
 * A browser on a computer that records the microphone and can never be asked
 * for a call's sound (Safari, Firefox). Not the desktop shell, which says its
 * own sentence; not a phone, where no browser can and the app is the answer.
 */
export function cannotHearCalls(capture: {
  audio: boolean;
  systemAudio: boolean;
}): boolean {
  if (Platform.OS !== "web") return false;
  if (!capture.audio || capture.systemAudio) return false;
  if (getDesktopBridge() !== null) return false;
  return !onPhoneOrTablet();
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    band: { gap: 2 },
    text: { color: colors.critText },
    hint: { color: colors.muted },
  });
