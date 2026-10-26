import { useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { useMessageSlot } from "../messages/useInAppMessage";
import { useBackupStatus } from "./useBackupStatus";
import { waitingForFullDiskAccess } from "./view";

/**
 * "Your texts, ready for Tex": the first time the Mac app opens (board 1 of
 * the Messages backup, approved by the owner 2026-10-26).
 *
 * The backup is on by default, and macOS will not let an app ask for Full
 * Disk Access, so this card says it is on, names whose texts and which Mac,
 * shows the two steps, and opens the right pane. Turn off is right here.
 * Nothing is read or sent until the permission is there.
 *
 * Its answer is the backup's own state on the Mac (`store: "own"`): the card
 * is up while the backup is on and waiting, and gone for good once the
 * permission lands or the backup is off. Closing it hides it for this visit
 * only; Settings › Messages says the same thing whenever somebody looks.
 */
export function MessagesBackupCard() {
  const styles = useThemedStyles(makeStyles);
  const backup = useBackupStatus();
  const [closed, setClosed] = useState(false);
  const known = backup.status !== null;
  const waiting = waitingForFullDiskAccess(backup.status);
  const slot = useMessageSlot({ id: "messages-backup", eligible: known && !closed, seen: !waiting });

  if (!slot.visible || backup.status?.backup === undefined) return null;
  const view = backup.status.backup;

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => setClosed(true)}>
      <View style={styles.scrim}>
        <View style={styles.card} testID="messages-backup-card">
          <Text variant="paneTitle" role="heading" aria-level={2}>
            Your texts, ready for Tex
          </Text>
          <Text variant="paneSub">
            Context is copying the Messages on this Mac into your own storage, so Tex and your AIs can look
            something up when you ask. Only you can read them, and they never turn into notes.
          </Text>
          <Text variant="paneSub" style={styles.strong} testID="messages-backup-card-whose">
            {`Copying texts${view.account === null ? "" : ` for ${view.account}`}${view.machine === null ? " on this Mac" : ` on ${view.machine}`}`}
          </Text>
          <View style={styles.steps}>
            <Text variant="paneSub">1. Open System Settings › Privacy &amp; Security › Full Disk Access</Text>
            <Text variant="paneSub">2. Turn on Context, then come back here</Text>
          </View>
          <Text variant="hint">macOS doesn't let apps ask for this one, so it takes these two steps.</Text>
          <View style={styles.buttons}>
            <Text variant="hint" style={styles.waiting} testID="messages-backup-card-waiting">
              Waiting for Full Disk Access
            </Text>
            <Button
              label="Turn off"
              variant="dialog"
              disabled={backup.changing}
              onPress={() => backup.setEnabled(false)}
              testID="messages-backup-card-off"
            />
            <Button
              label="Open System Settings"
              variant="dialogPrimary"
              onPress={backup.openFullDiskAccess}
              testID="messages-backup-card-open"
            />
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
      maxWidth: 460,
      gap: 12,
      paddingVertical: 22,
      paddingHorizontal: 24,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
    },
    strong: { color: colors.text },
    steps: { gap: 6 },
    waiting: { flexGrow: 1, flexShrink: 1 },
    buttons: { flexDirection: "row", gap: 10, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" },
  });
