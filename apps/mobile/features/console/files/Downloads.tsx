import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { setOnlineOnly, useOnlineOnly } from "../../offline/downloadChoice";
import { downloadRows, rowStatus, type DownloadRow } from "../../offline/downloadSummary";
import { useMirrorStatuses } from "../../offline/mirrorStatus";
import { mirrorSupported } from "../../offline/mirrorStore";
import { openStore } from "../../offline/store";

/**
 * Downloads, on a phone (owner, 2026-10-16): the block in the sync sheet with
 * a line and a Don't download button per workspace, opened from the count
 * under the Notes title (2026-10-18). Words are `downloadSummary.ts`'s.
 */

/** Every workspace's download line; empty where this runtime keeps no copy. */
export function useDownloadRows(contexts: readonly { id: string; slug: string }[] | undefined): DownloadRow[] {
  const statuses = useMirrorStatuses();
  const onlineOnly = useOnlineOnly();
  return useMemo(
    () => (contexts === undefined || !mirrorSupported() ? [] : downloadRows(contexts, statuses, onlineOnly)),
    [contexts, statuses, onlineOnly],
  );
}

/** How long notes must keep coming down before the line says so. */
export const STEADY_DOWNLOAD_MS = 3_000;

/**
 * `row`, but "downloading" only once it has lasted `STEADY_DOWNLOAD_MS`.
 *
 * Dev2 (2026-10-18): the line under Notes "keeps flickering … between spinning
 * [and] how many notes are actually downloaded". Each background pass that
 * finds a note or two new says "downloading" for a moment and "done" again,
 * so "2,842 of 2,844" and its spinner came and went every few seconds. Until
 * a download has lasted, the line counts what is on the phone, without a
 * spinner, which is true the whole time.
 */
export function useSteadyDownloadRow(row: DownloadRow | undefined): DownloadRow | undefined {
  const downloading = row?.state === "downloading";
  const [steady, setSteady] = useState(false);
  useEffect(() => {
    setSteady(false);
    if (!downloading) return;
    const timer = setTimeout(() => setSteady(true), STEADY_DOWNLOAD_MS);
    return () => clearTimeout(timer);
  }, [downloading, row?.workspaceId]);
  if (row === undefined || !downloading || steady) return row;
  return { ...row, state: "done", total: row.done };
}

export function DownloadsSection({ rows }: { rows: readonly DownloadRow[] }) {
  const styles = useThemedStyles(makeStyles);
  const [failed, setFailed] = useState<string | null>(null);
  if (rows.length === 0) return null;
  const choose = (row: DownloadRow, onlineOnly: boolean) => {
    setFailed(null);
    setOnlineOnly(openStore(), row.workspaceId, onlineOnly).catch(() =>
      setFailed(`Could not save that for ${row.label}. Try again.`),
    );
  };
  return (
    <View style={styles.section} testID="sync-section-downloads">
      <Text variant="railHead" role="heading" aria-level={3} style={styles.head}>
        Downloads
      </Text>
      {rows.map((row) => (
        <View key={row.workspaceId} style={styles.row} testID={`download-row-${row.workspaceId}`}>
          <View style={styles.line}>
            <Text variant="rowTitle" numberOfLines={1} style={styles.name}>
              {row.label}
            </Text>
            <Text variant="rowSub" style={row.state === "done" ? styles.doneText : undefined}>
              {rowStatus(row)}
            </Text>
          </View>
          {row.state === "online-only" ? null : (
            <View style={styles.track}>
              <View
                style={[styles.fill, { width: `${row.total > 0 ? Math.round((row.done / row.total) * 100) : 0}%` }]}
              />
            </View>
          )}
          <View style={styles.actions}>
            <Button
              variant="mini"
              label={row.state === "online-only" ? "Download" : "Don't download"}
              accessibilityLabel={
                row.state === "online-only" ? `Download ${row.label} to this device` : `Keep ${row.label} online only`
              }
              onPress={() => choose(row, row.state !== "online-only")}
              testID={`download-toggle-${row.workspaceId}`}
            />
          </View>
        </View>
      ))}
      {failed === null ? null : (
        <Text variant="meta" style={styles.note}>
          {failed}
        </Text>
      )}
      <Text variant="meta" style={styles.note}>
        Archive stays online and opens when you are connected. Downloads run while Context is open.
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x3 },
    head: { paddingHorizontal: 4 },
    row: { gap: space.x2, paddingHorizontal: 4, paddingVertical: 6 },
    line: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.x2 },
    name: { flexShrink: 1 },
    doneText: { color: colors.accent },
    track: { height: 6, borderRadius: radii.pill, backgroundColor: colors.lineStrong, overflow: "hidden" },
    fill: { height: 6, borderRadius: radii.pill, backgroundColor: colors.accent },
    actions: { flexDirection: "row" },
    note: { paddingHorizontal: 4, color: colors.muted },
  });
