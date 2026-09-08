/**
 * The Inbox landing page: recent activity across every connected channel,
 * built entirely from the folder listings `FileBrowser` already fetches —
 * **virtual**, per `docs/decisions/communications.md`.
 */

import { useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { FileBrowser } from "../files/browser";
import { discoverInboxChannels, shapeInboxRows, type InboxChannelSource } from "./inbox";
import { CHANNEL_FOLDERS, INBOX_FOLDER } from "./paths";
import type { InboxRow } from "./types";

/**
 * Gmail is behind a flag until Google's verification of the restricted scope
 * lands — see `docs/decisions/communications.md`, *the Gmail restricted scope
 * is Google's decision*. Passed in rather than read from an env var here, so
 * a test can drive both states without touching process state, and so the
 * one place that knows the flag's name stays the caller's.
 */
export function InboxView({
  files,
  onOpen,
  mailConnectEnabled,
}: {
  files: FileBrowser;
  onOpen: (path: string) => void;
  mailConnectEnabled: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const root = files.listings[INBOX_FOLDER]?.entries;
  const emailRoot = files.listings[CHANNEL_FOLDERS.email]?.entries;

  useEffect(() => {
    files.ensureListing(INBOX_FOLDER);
  }, [files]);

  const candidates = useMemo(() => discoverInboxChannels(root, emailRoot), [root, emailRoot]);

  useEffect(() => {
    if (root?.some((entry) => entry.kind === "folder" && entry.path === CHANNEL_FOLDERS.email)) {
      files.ensureListing(CHANNEL_FOLDERS.email);
    }
  }, [files, root]);

  useEffect(() => {
    for (const candidate of candidates) files.ensureListing(candidate.path);
    // `candidates` is a fresh array every render — `ensureListing` is a no-op
    // once a path is cached, so re-running this costs nothing once every
    // folder has answered, and depending on its *contents* rather than its
    // identity would need a second data structure only to avoid work this
    // already avoids on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, candidates.map((c) => c.path).join("|")]);

  const rows = useMemo<InboxRow[]>(() => {
    const sources: InboxChannelSource[] = candidates.map((candidate) => ({
      kind: candidate.kind,
      account: candidate.account,
      path: candidate.path,
      // The address a mailbox's own notes carry is a read this virtual page
      // does not make (see `channelLabel`'s own comment); the slug is the
      // honest label until a caller wants to spend that read.
      label: candidate.kind === "email" ? candidate.account : labelFor(candidate.kind),
      entries: files.listings[candidate.path]?.entries,
    }));
    return shapeInboxRows(sources);
  }, [candidates, files.listings]);

  if (root === undefined) {
    return (
      <View style={styles.page}>
        <Text variant="meta">Loading…</Text>
      </View>
    );
  }

  if (candidates.length === 0) {
    return (
      <View style={styles.page}>
        <Text variant="noteTitle" role="heading" aria-level={2}>
          Inbox
        </Text>
        <Text variant="paneSub" style={styles.lead}>
          Nothing is connected yet. Meetings you record and mail you forward to your ingestion
          address already land in <Text variant="paneSub">0-inbox</Text>; a connected mailbox,
          Google Chat and iMessage will show up here the same way once they are connected.
        </Text>
        <Text variant="hint" style={styles.flagNote}>
          {mailConnectEnabled
            ? "Connect a mailbox from Settings to start syncing your mail here."
            : "Connecting a mailbox is not open yet — it needs Google's verification of the " +
              "restricted mail scope, which is out of our hands. It will appear here once it " +
              "is available; nothing here fakes a connection in the meantime."}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <Text variant="noteTitle" role="heading" aria-level={2}>
        Inbox
      </Text>
      <View style={styles.list}>
        {rows.map((row) => (
          <PressRow
            key={row.path}
            onPress={() => onOpen(row.path)}
            style={styles.row}
            hoverStyle={styles.rowHover}
            radius={radii.md}
            accessibilityLabel={`${row.label}, ${
              row.lastActive === null ? "no activity yet" : `last active ${row.lastActive}`
            }`}
            testID="inbox-row"
          >
            <Icon name="folder" size={18} />
            <View style={styles.rowBody}>
              <Text variant="treeTouch" numberOfLines={1}>
                {row.label}
              </Text>
              <Text variant="treeMeta" style={styles.rowMeta}>
                {row.lastActive === null
                  ? "No activity yet"
                  : `Last active ${row.lastActive} · ${row.activeDays} active day${row.activeDays === 1 ? "" : "s"}`}
              </Text>
            </View>
            <Icon name="chevronRight" size={15} />
          </PressRow>
        ))}
      </View>
    </View>
  );
}

function labelFor(kind: InboxRow["kind"]): string {
  if (kind === "meetings") return "Meetings";
  if (kind === "contacts") return "Contacts";
  if (kind === "google-chat") return "Google Chat";
  return "iMessage";
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  page: { gap: space.x3 },
  lead: { color: colors.muted },
  flagNote: { color: colors.muted, marginTop: space.x1 },
  list: { marginTop: space.x2 },
  row: { flexDirection: "row", alignItems: "center", gap: space.x3, paddingVertical: space.x2 },
  rowHover: { backgroundColor: colors.surface3 },
  rowBody: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  rowMeta: { color: colors.muted, marginTop: 2 },
});
