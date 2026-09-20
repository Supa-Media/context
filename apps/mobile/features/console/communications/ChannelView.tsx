/**
 * The Channel view: one channel's active days, newest first, paged. A
 * mailbox shows the address it maps to — read off its own most recent day's
 * frontmatter, the same field `list_channel_days` reads — and never the
 * folder slug that maps to it.
 */

import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { parseChannelDayNote } from "@context/communications";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { FileBrowser } from "../files/browser";
import { channelDayPageCount, collateChannelDays, pageChannelDays } from "./channel";
import { dayEntriesUnder, dayFolderPaths } from "./dayFolders";
import { channelLabel } from "./inbox";
import type { CommsChannel } from "./types";

const PAGE_SIZE = 20;

export function ChannelView({
  channel,
  account,
  path,
  files,
  onOpen,
}: {
  channel: CommsChannel;
  account: string;
  path: string;
  files: FileBrowser;
  onOpen: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [page, setPage] = useState(0);
  const [address, setAddress] = useState<string | null>(null);

  /*
    The channel folder, then its year folders, then their months — a day is
    filed under `YYYY/MM` and `ensureListing` fetches one folder's own
    children, so a view that asked only for `path` would show every day
    written before 2026-09-18 and none written since. `dayFolderPaths` answers
    off what is already cached, so this settles in two rounds and is a no-op
    after that.
  */
  const folders = dayFolderPaths(path, files.listings);
  const folderKey = folders.join("|");
  useEffect(() => {
    for (const folder of folders) files.ensureListing(folder);
    // Keyed on the folders themselves rather than the array's identity, which
    // is fresh every render; `ensureListing` is a no-op once a path is cached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, folderKey]);
  // A different channel is a different page: start over rather than landing
  // on whatever page this one happened to leave the state on.
  useEffect(() => setPage(0), [path]);

  const listed = files.listings[path]?.entries;
  const entries = useMemo(() => dayEntriesUnder(path, files.listings), [path, files.listings]);
  const rows = useMemo(() => collateChannelDays(channel, account, entries), [channel, account, entries]);
  const pageCount = channelDayPageCount(rows, PAGE_SIZE);
  const pageRows = pageChannelDays(rows, page, PAGE_SIZE);

  // The address a mailbox maps to, read off its own most recent day —
  // `list_channel_days`' own move, spent once per channel rather than once
  // per row. Never the slug: that is what `path` already is.
  useEffect(() => {
    setAddress(null);
    if (channel !== "email" || rows.length === 0) return;
    let cancelled = false;
    void files.readRaw(rows[0]!.path).then((note) => {
      if (cancelled || note === null) return;
      const parsed = parseChannelDayNote(note.text);
      const value = parsed.frontmatter.account;
      if (value) setAddress(value);
    });
    return () => {
      cancelled = true;
    };
    // `rows` is a fresh array every render; only its first path decides what
    // is read, and depending on the array itself would re-read on every
    // unrelated listing update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, channel, rows[0]?.path]);

  const label = channelLabel(channel, account, { address });

  return (
    <View style={styles.page}>
      <Text variant="noteTitle" role="heading" aria-level={2}>
        {label}
      </Text>

      {/*
        The *channel folder's* own listing decides "loading", not the walk's
        result: `dayEntriesUnder` is an array either way, and an empty one
        before the first listing lands would say "No days yet" to somebody
        whose mailbox is full.
      */}
      {listed === undefined ? (
        <Text variant="meta" style={styles.aside}>
          Loading…
        </Text>
      ) : rows.length === 0 ? (
        <Text variant="meta" style={styles.aside}>
          No days yet.
        </Text>
      ) : (
        <View style={styles.list}>
          {pageRows.map((row) => (
            <PressRow
              key={row.date}
              onPress={() => onOpen(row.path)}
              style={styles.row}
              hoverStyle={styles.rowHover}
              radius={radii.md}
              accessibilityLabel={`${row.date}${row.parts > 1 ? `, split into ${row.parts} parts` : ""}`}
              testID="channel-day-row"
            >
              <Text variant="treeTouch" style={styles.rowDate}>
                {row.date}
              </Text>
              {row.parts > 1 ? (
                <Text variant="treeMeta" style={styles.rowMeta}>
                  {row.parts} parts
                </Text>
              ) : null}
              <Icon name="chevronRight" size={15} />
            </PressRow>
          ))}
        </View>
      )}

      {pageCount > 1 ? (
        <View style={styles.pager}>
          <Pressable
            onPress={page > 0 ? () => setPage((current) => current - 1) : undefined}
            disabled={page === 0}
            accessibilityRole="button"
            accessibilityLabel="Newer days"
            testID="channel-page-newer"
          >
            <Text variant="hint" style={page > 0 ? undefined : styles.pagerDisabled}>
              Newer
            </Text>
          </Pressable>
          <Text variant="hint">
            Page {page + 1} of {pageCount}
          </Text>
          <Pressable
            onPress={page < pageCount - 1 ? () => setPage((current) => current + 1) : undefined}
            disabled={page >= pageCount - 1}
            accessibilityRole="button"
            accessibilityLabel="Older days"
            testID="channel-page-older"
          >
            <Text variant="hint" style={page < pageCount - 1 ? undefined : styles.pagerDisabled}>
              Older
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  page: { gap: space.x3 },
  aside: { color: colors.muted },
  list: { marginTop: space.x2 },
  row: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingVertical: space.x2 },
  rowHover: { backgroundColor: colors.surface3 },
  rowDate: { flexGrow: 1, flexShrink: 1 },
  rowMeta: { color: colors.muted },
  pager: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.x3 },
  pagerDisabled: { color: colors.muted, opacity: 0.4 },
});
