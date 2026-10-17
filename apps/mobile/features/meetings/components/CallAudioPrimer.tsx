import { Linking, Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { TextLink } from "../../design/components/TextLink";
import { radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { MAC_APP_URL, browserName } from "../capture";

/**
 * What the browser is about to ask, said once, before it asks.
 *
 * Pressing Record in a browser used to open the screen picker at once, with
 * nothing from us first. People read "share your screen" as Context recording
 * their screen, missed the sound switch, and got the same picker at every
 * meeting (Supa Leadership Weekly, 2026-10-17). So the first time — until a
 * share has carried sound in this browser (`callAudioMemory`) — this says what
 * to pick, in the picker's own words, and that only the sound is used.
 *
 * **Continue is the press the picker rides.** `getDisplayMedia` needs a fresh
 * user activation, and this button is one; the original Record press is spent
 * on opening this card.
 *
 * "Nobody on a call? Record the room" starts this one meeting without the
 * picker. It is not a setting: the next meeting asks again, and the call's
 * audio stays on by default (Dev2, 2026-10-01; kept as an option on board m2).
 */
export function CallAudioPrimer({
  onContinue,
  onRoom,
  onClose,
}: {
  onContinue: () => void;
  onRoom: () => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const wide = width >= 720;
  const browser = browserName();
  const asker = browser === "This browser" ? "Your browser" : browser;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable
        style={[styles.scrim, wide && styles.scrimWide]}
        accessibilityLabel="Not now"
        onPress={onClose}
      >
        <Pressable
          style={[styles.card, wide ? styles.cardWide : styles.cardNarrow]}
          onPress={() => {}}
          accessibilityLabel="Record both sides of the call"
          testID="meeting-call-audio-primer"
        >
          <Text variant="rowTitle" style={styles.title}>
            Record both sides of the call
          </Text>
          <Text variant="rowSub" style={styles.body}>
            {`${asker} will ask to share your screen. That's how a browser hears a call in your headphones.`}
          </Text>
          <View style={styles.steps}>
            <Text variant="rowSub" style={styles.body}>
              {"Pick "}
              <Text variant="rowSub" style={styles.strong}>
                Entire screen
              </Text>
              {", then turn on "}
              <Text variant="rowSub" style={styles.strong}>
                Also share system audio
              </Text>
              .
            </Text>
          </View>
          <Text variant="rowSub" style={styles.muted}>
            Only the sound is used. Your screen is never recorded.
          </Text>
          <View style={styles.actions}>
            <Button
              label="Continue"
              variant="dialogPrimary"
              onPress={onContinue}
              testID="meeting-call-audio-primer-continue"
            />
            <TextLink
              label="Nobody on a call? Record the room"
              onPress={onRoom}
              testID="meeting-call-audio-primer-room"
            />
          </View>
          <Text variant="foot" style={styles.muted}>
            {"No prompt at all in the "}
            <TextLink
              label="Mac app"
              onPress={() => void Linking.openURL(MAC_APP_URL).catch(() => {})}
              testID="meeting-call-audio-primer-mac-app"
            />
            .
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: "rgba(3,3,4,.55)",
      justifyContent: "flex-end",
    },
    // On a computer it sits low on the right, where meetings are started from.
    scrimWide: { alignItems: "flex-end", padding: 32 },
    card: {
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
      paddingTop: 22,
      paddingHorizontal: 22,
      gap: 10,
    },
    cardWide: { width: 440, maxWidth: "100%", borderRadius: radii.sheet, paddingBottom: 18 },
    cardNarrow: {
      borderTopLeftRadius: radii.sheet,
      borderTopRightRadius: radii.sheet,
      borderBottomWidth: 0,
      paddingBottom: 34,
    },
    title: { color: colors.text },
    body: { color: colors.text2 },
    strong: { color: colors.text, fontWeight: "700" },
    steps: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      paddingVertical: 10,
    },
    muted: { color: colors.muted },
    actions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 16, marginTop: 4 },
  });
