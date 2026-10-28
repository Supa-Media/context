import { Linking, Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { PRIVACY_POLICY_URL, TRANSCRIPTION_CONSENT_COPY } from "@context/shared";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { TextLink } from "../../design/components/TextLink";
import { radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * "Use AI for meeting notes?", asked before any recording audio or meeting
 * notes go to an AI provider (`docs/decisions/meetings/transcription-consent.md`).
 *
 * App Review rejected build 12 under 5.1.1(i)/5.1.2(i): the microphone prompt
 * says the app will hear you, not that a third-party AI service will. So this
 * says, in one line, that audio and notes go to AI providers and what for, and
 * links the privacy policy, which names them, with two choices of equal reach:
 *
 *  - **Allow** records the yes on the account, then records.
 *  - **Not now** writes nothing, sends nothing and opens nothing: the meeting
 *    runs as typed notes only. Dismissing the card (the scrim, Escape, the
 *    Android back button) is the same as Not now, never a yes.
 *
 * The card scrolls, so the whole disclosure and both buttons stay reachable
 * on a small iPhone with the largest text size, and on an iPad in either
 * orientation.
 */
export function TranscriptionConsent({
  onAllow,
  onDecline,
  busy = false,
  failed = null,
}: {
  onAllow: () => void;
  onDecline: () => void;
  /** The yes is being saved: Allow is held so it cannot be sent twice. */
  busy?: boolean;
  /** Why the yes did not save, said under the buttons. */
  failed?: string | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const { width, height } = useWindowDimensions();
  const wide = width >= 720;
  const copy = TRANSCRIPTION_CONSENT_COPY;

  return (
    <Modal transparent animationType="fade" onRequestClose={onDecline} visible supportedOrientations={["portrait", "landscape"]}>
      <View style={[styles.scrim, wide && styles.scrimWide]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityLabel={copy.decline}
          accessibilityRole="button"
          onPress={onDecline}
          testID="transcription-consent-scrim"
        />
        <View
          style={[styles.card, wide ? styles.cardWide : styles.cardNarrow, { maxHeight: Math.max(320, height - (wide ? 64 : 24)) }]}
          accessibilityViewIsModal
          testID="transcription-consent"
        >
          <ScrollView contentContainerStyle={styles.content} bounces={false}>
            <Text variant="rowTitle" style={styles.title} accessibilityRole="header">
              {copy.title}
            </Text>
            <Text variant="rowSub" style={styles.body}>
              {copy.body}
            </Text>
            <TextLink
              label={copy.privacyLink}
              onPress={() => void Linking.openURL(PRIVACY_POLICY_URL).catch(() => {})}
              testID="transcription-consent-privacy"
            />
            <View style={styles.actions}>
              <Button
                label={copy.allow}
                variant="dialogPrimary"
                onPress={onAllow}
                disabled={busy}
                testID="transcription-consent-allow"
              />
              <Button label={copy.decline} variant="dialog" onPress={onDecline} testID="transcription-consent-decline" />
            </View>
            {failed !== null ? (
              <Text variant="foot" style={styles.failed} accessibilityLiveRegion="polite">
                {failed}
              </Text>
            ) : null}
          </ScrollView>
        </View>
      </View>
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
    // On a computer or an iPad it sits in the middle, a decision rather than a tip.
    scrimWide: { alignItems: "center", justifyContent: "center", padding: 32 },
    card: {
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
    },
    cardWide: { width: 460, maxWidth: "100%", borderRadius: radii.sheet },
    cardNarrow: {
      borderTopLeftRadius: radii.sheet,
      borderTopRightRadius: radii.sheet,
      borderBottomWidth: 0,
    },
    content: { paddingTop: 22, paddingHorizontal: 22, paddingBottom: 34, gap: 12 },
    title: { color: colors.text },
    body: { color: colors.text },
    failed: { color: colors.warnText },
    actions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12, marginTop: 4 },
  });
