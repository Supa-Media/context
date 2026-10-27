import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { MessagesBackupFiles } from "@context/desktop-bridge";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Switch } from "../../../design/components/Switch";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
// The component's own path, not the meetings barrel, which imports a router.
import { ThisMachineCard } from "../../../meetings/components/ThisMachineCard";
import { DeleteBackup } from "../../../messagesBackup/DeleteBackup";
import { ReadHistory } from "../../../messagesBackup/ReadHistory";
import { useBackupStatus } from "../../../messagesBackup/useBackupStatus";
import { backupOnThisMac, downloadLine, progressLines, whatsCopiedLines, whoseTexts } from "../../../messagesBackup/view";
import { settingsSectionLabel } from "../sections";

/**
 * Settings › Messages (board 2 of the Messages backup, approved by the owner
 * 2026-10-26): whether this Mac backs up its texts, how far it has got, what
 * is copied, your copy, who reads them, and deleting the backup
 * (`docs/decisions/communications/messages-backup.md`).
 *
 * `owned` is whether this account has a personal workspace: the texts are
 * kept in it, and an account invited into somebody else's has nowhere to keep
 * them.
 */
export function MessagesPanel({ owned, workspaceId = null }: { owned: boolean; workspaceId?: string | null }) {
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
      {owned ? <YourCopy backup={backup} /> : null}

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
        {owned && workspaceId !== null ? <ReadHistory workspaceId={workspaceId} /> : null}
      </Card>

      <Text variant="hint" style={styles.foot}>
        Turning the backup off stops copying and keeps what's already there.
      </Text>
      {owned && workspaceId !== null ? (
        <View style={styles.spaced}>
          <DeleteBackup workspaceId={workspaceId} backup={backup} />
        </View>
      ) : null}
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
      <WhatsCopied backup={backup} files={here.view.files} />
    </View>
  );
}

/**
 * Your copy (board 2): the backup downloaded into a folder in Downloads as it
 * is kept, the texts as JSON lines with the pictures (owner, 2026-10-27). Only
 * the Mac app can write that folder; anywhere else, Download as folders
 * carries the texts.
 */
function YourCopy({ backup }: { backup: ReturnType<typeof useBackupStatus> }) {
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const download = backup.download;
  return (
    <View>
      <Text variant="eyebrow" style={[styles.eyebrow, styles.spaced]}>
        Your copy
      </Text>
      <Card>
        <Row>
          <Grow>
            <Text variant="rowTitle">Download messages</Text>
            <Text variant="rowSub" style={styles.rowSub} testID="messages-download-detail">
              {download === null
                ? "Your texts as they're kept, in JSON lines, with the pictures. Download them from the Mac app; Download as folders on your workspace has the texts."
                : "Your texts as they're kept, in JSON lines, with the pictures, in a new folder in Downloads."}
            </Text>
            {said === null ? null : (
              <Text variant="rowSub" style={styles.rowSub} testID="messages-download-result">
                {said}
              </Text>
            )}
          </Grow>
          {download === null ? null : (
            <Button
              label={busy ? "Downloading…" : "Download"}
              disabled={busy}
              onPress={() => {
                setBusy(true);
                setSaid(null);
                void download()
                  .then((result) => setSaid(downloadLine(result)))
                  .finally(() => setBusy(false));
              }}
              testID="messages-download"
            />
          )}
        </Row>
      </Card>
    </View>
  );
}

/** Pictures and documents, and videos: each its own switch (owner's pick: pictures on, videos off). */
function WhatsCopied({
  backup,
  files,
}: {
  backup: ReturnType<typeof useBackupStatus>;
  files: MessagesBackupFiles | undefined;
}) {
  const styles = useThemedStyles(makeStyles);
  if (files === undefined || backup.setFiles === null) {
    return (
      <Text variant="paneSub" style={styles.sub} testID="messages-files-outdated">
        Update the Mac app to copy pictures and documents too.
      </Text>
    );
  }
  const setFiles = backup.setFiles;
  const lines = whatsCopiedLines(files);
  return (
    <View>
      <Text variant="eyebrow" style={[styles.eyebrow, styles.spaced]}>
        What's copied
      </Text>
      <Card>
        <Row>
          <Grow>
            <Text variant="rowTitle">Pictures and documents</Text>
            <Text variant="rowSub" style={styles.rowSub} testID="messages-pictures-detail">
              {lines.pictures}
            </Text>
          </Grow>
          <Switch
            value={files.pictures}
            label="Copy pictures and documents"
            disabled={backup.changing}
            onValueChange={(next) => setFiles({ pictures: next })}
            testID="messages-pictures-switch"
          />
        </Row>
        <Row divided>
          <Grow>
            <Text variant="rowTitle">Videos</Text>
            <Text variant="rowSub" style={styles.rowSub} testID="messages-videos-detail">
              {lines.videos}
            </Text>
          </Grow>
          <Switch
            value={files.videos}
            label="Copy videos"
            disabled={backup.changing}
            onValueChange={(next) => setFiles({ videos: next })}
            testID="messages-videos-switch"
          />
        </Row>
      </Card>
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
