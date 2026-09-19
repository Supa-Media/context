import { Modal, Pressable, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * Why a press of New meeting did not open a microphone.
 *
 * ## What is left of the destination sheet, and why it is only this
 *
 * The sheet asked where the meeting should go, said what happens to the audio,
 * and offered a way to the meetings already recorded. The question is gone —
 * `useMeetingFlow` argues that — and with it the rows, the switch and the
 * heading. What could not go with it is the **refusal**: two states stop a
 * press, and a control that answers one of them by doing nothing is the defect
 * this feature keeps closing at every layer.
 *
 * So this is the sentence and the one thing that can be done about it. It is
 * the same `Modal` / scrim / card the sheet was, at the same bottom edge and
 * built from the same parts as `console/files/Dialogs.tsx`, because it is
 * raised from the same keys and reached with the same thumb.
 *
 * ## No title
 *
 * The heading would be a restatement of the sentence under it. A dialog with
 * one sentence and one button does not need a label saying it is a dialog with
 * one sentence and one button, and `accessibilityLabel` on the card carries
 * what a screen reader needs.
 */
export function MeetingRefusal({
  reason,
  onClaimName,
  onClose,
}: {
  /** The refusal, in words. Never a code, never an apology. */
  reason: string;
  /**
   * Claim an @name, for the one refusal that has something to press.
   *
   * `null` where there is nothing to offer — a device that has not opened a
   * context yet fixes itself a moment later, and a button that said so would
   * be a button whose only effect is to close a dialog that already closes on
   * its scrim. It is also `null` on the demo console, where there is no real
   * account behind the offer.
   */
  onClaimName: (() => void) | null;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose} visible>
      <Pressable style={styles.scrim} accessibilityLabel="Not now" onPress={onClose}>
        {/* Swallow presses inside the card so the scrim only closes on the scrim. */}
        <Pressable
          style={styles.card}
          onPress={() => {}}
          accessibilityLabel="This meeting cannot start"
          testID="meeting-refusal"
        >
          <Text variant="rowSub" style={styles.reason} testID="meeting-refusal-reason">
            {reason}
          </Text>
          <View style={styles.actions}>
            {onClaimName === null ? null : (
              <Button
                label="Claim your @name"
                variant="dialogPrimary"
                onPress={onClaimName}
                testID="meeting-refusal-claim"
              />
            )}
            <Button
              label="Not now"
              variant="dialog"
              onPress={onClose}
              testID="meeting-refusal-close"
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: "rgba(3,3,4,.72)",
      justifyContent: "flex-end",
    },
    card: {
      borderTopWidth: 1,
      borderColor: colors.lineStrong,
      borderTopLeftRadius: radii.sheet,
      borderTopRightRadius: radii.sheet,
      backgroundColor: colors.surface2,
      paddingTop: 22,
      /*
        The home indicator's worth of room below the last control, as the sheet
        this replaces had: a card at the bottom edge of a phone is the one place
        in this app where a button ends up under the gesture bar.
      */
      paddingBottom: 34,
      paddingHorizontal: 24,
      gap: 16,
    },
    reason: { color: colors.text2 },
    actions: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      flexWrap: "wrap",
      gap: 8,
    },
  });
