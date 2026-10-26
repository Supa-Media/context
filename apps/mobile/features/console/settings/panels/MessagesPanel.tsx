import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Switch } from "../../../design/components/Switch";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
// The component's own path, not the meetings barrel, which imports a router.
import { ThisMachineCard } from "../../../meetings/components/ThisMachineCard";
import { useBackupStatus } from "../../../messagesBackup/useBackupStatus";
import { backupOnThisMac, progressLines, whoseTexts } from "../../../messagesBackup/view";
import { settingsSectionLabel } from "../sections";

/**
 * Settings › Messages (board 2 of the Messages backup, approved by the owner
 * 2026-10-26): whether this Mac backs up its texts, how far it has got, and
 * who reads them. Pictures, the download and deleting the backup arrive with
 * the steps that build them (`docs/decisions/communications/messages-backup.md`).
 *
 * `owned` is whether this account has a personal workspace: the texts are
 * kept in it, and an account invited into somebody else's has nowhere to keep
 * them.
 */
export function MessagesPanel({ owned }: { owned: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const backup = useBackupStatus();

  return (
    <View>
      <Text variant="paneTitle" role="heading" aria-level={2} style={styles.head}>
        {settingsSectionLabel("messages")}
      </Text>
      <Text variant="paneSub" style={styles.sub}>
        Texts from this Mac, copied into your own storage. Tex and your AIs read them when you ask. They never
        show up in your notes.
      </Text>

      <Text variant="eyebrow" style={styles.eyebrow}>
        This Mac
      </Text>
      {!owned ? (
        <Text variant="paneSub" style={styles.sub} testID="messages-no-workspace">
          Texts are kept in a workspace of your own, which this account does not have.
        </Text>
      ) : (
        <ThisMac backup={backup} />
      )}

      <Text variant="eyebrow" style={[styles.eyebrow, styles.spaced]}>
        Who reads them
      </Text>
      <Card>
        <Row>
          <Grow>
            <Text variant="rowTitle">Only you, and AIs you connected with private access</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              Never members of a shared workspace. Never Tex in a group chat.
            </Text>
          </Grow>
        </Row>
      </Card>

      <Text variant="hint" style={styles.foot}>
        Turning the backup off stops copying and keeps what's already there.
      </Text>
    </View>
  );
}

function ThisMac({ backup }: { backup: ReturnType<typeof useBackupStatus> }) {
  const styles = useThemedStyles(makeStyles);

  if (backup.bridge === null || backup.bridge.imessage === undefined) {
    return (
      <Text variant="paneSub" style={styles.sub} testID="messages-not-on-mac">
        Open Context on your Mac to back up the Messages there.
      </Text>
    );
  }
  if (backup.status === null) {
    return (
      <Text variant="paneSub" style={styles.sub} testID="messages-loading">
        Asking this Mac…
      </Text>
    );
  }
  const here = backupOnThisMac(backup.status);
  if (here.kind === "outdated") {
    return (
      <Text variant="paneSub" style={styles.sub} testID="messages-outdated">
        Update the Mac app to back up Messages from this Mac. It updates when you quit and reopen it.
      </Text>
    );
  }

  const progress = progressLines(here.enabled, here.view, { now: Date.now(), lastCopiedAt: backup.status.lastSyncedAt });
  return (
    <View style={styles.stack}>
      <Card>
        <Row>
          <Grow>
            <Text variant="rowTitle">Back up Messages from this Mac</Text>
            <Text variant="rowSub" style={styles.rowSub} testID="messages-whose">
              {whoseTexts(here.view)}
            </Text>
          </Grow>
          <Switch
            value={here.enabled}
            label="Back up Messages from this Mac"
            disabled={backup.changing}
            onValueChange={(next) => backup.setEnabled(next)}
            testID="messages-switch"
          />
        </Row>
        <Row divided>
          <Grow>
            <Text variant="rowTitle" testID="messages-progress">
              {progress.title}
            </Text>
            {progress.detail === null ? null : (
              <Text variant="rowSub" style={styles.rowSub} testID="messages-progress-detail">
                {progress.detail}
              </Text>
            )}
          </Grow>
          {here.enabled && here.view.phase === "needs_permission" ? (
            <Button
              label="Open System Settings"
              onPress={backup.openFullDiskAccess}
              testID="messages-open-settings"
            />
          ) : null}
        </Row>
      </Card>
      {/* The backup sends with this Mac's own grant: unconnected is why nothing is copied. */}
      {here.enabled && here.view.phase === "not_connected" ? <ThisMachineCard focus="chats" /> : null}
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    head: { marginBottom: 4 },
    sub: { marginBottom: space.x3, maxWidth: 546 },
    eyebrow: { marginBottom: space.x2 },
    spaced: { marginTop: space.x4 },
    stack: { gap: space.x3 },
    rowSub: { marginTop: 2, maxWidth: 520 },
    foot: { marginTop: space.x3 },
  });
