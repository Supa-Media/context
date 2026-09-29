import { Modal, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Button } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { useInAppMessage } from "../messages/useInAppMessage";

/**
 * "Context is in early beta", once per person.
 *
 * Shown the first time the signed-in app opens after this shipped, which
 * covers people finishing sign-up and people who signed up before it — both
 * are told the same thing once. "Got it" is kept on the account through the
 * in-app message path (`features/messages/`), so another browser, the desktop
 * app or cleared site data does not ask again, and it waits its turn behind
 * anything already on screen. The same sentences are in Settings → Privacy &
 * feedback, which is where "Change in Settings" goes.
 */

const SEEN_KEY = "context.betaNotice.seen.v1";

export const BETA_POINTS = [
  "When something breaks, the app sends us a crash report so we can fix it.",
  "We count which screens get opened, linked to your account, not your name or email.",
  "On the web we record some visits with every word and picture hidden, so we can see where people get stuck.",
  "We never collect your notes, their titles, your folder names or your links, unless you put them in a report yourself.",
] as const;

export function BetaNotice() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const notice = useInAppMessage({ id: "beta-notice", eligible: true, deviceKey: SEEN_KEY });

  if (!notice.visible) return null;

  const close = (then?: () => void) => {
    notice.dismiss();
    then?.();
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => close()}>
      <View style={styles.scrim}>
        <View style={styles.card} testID="beta-notice">
          <Text variant="paneTitle" role="heading" aria-level={2}>
            Context is in early beta
          </Text>
          <View style={styles.points}>
            {BETA_POINTS.map((point, index) => (
              <Text
                key={point}
                variant="paneSub"
                style={index === BETA_POINTS.length - 1 ? styles.strong : null}
              >
                {`• ${point}`}
              </Text>
            ))}
          </View>
          <View style={styles.buttons}>
            <Button
              label="Change in Settings"
              variant="dialog"
              onPress={() => close(() => router.setParams({ settings: "feedback" }))}
              testID="beta-notice-settings"
            />
            <Button label="Got it" variant="dialogPrimary" onPress={() => close()} testID="beta-notice-ok" />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: colors.scrim,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    card: {
      width: "100%",
      maxWidth: 440,
      gap: 14,
      paddingVertical: 22,
      paddingHorizontal: 24,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
    },
    points: { gap: 8 },
    strong: { color: colors.text },
    buttons: { flexDirection: "row", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" },
  });
