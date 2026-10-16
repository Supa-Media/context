import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { setOnlineOnly, useOnlineOnly } from "../../offline/downloadChoice";
import { downloadRows, rowStatus, type DownloadPill, type DownloadRow } from "../../offline/downloadSummary";
import { useMirrorStatuses } from "../../offline/mirrorStatus";
import { mirrorSupported } from "../../offline/mirrorStore";
import { openStore } from "../../offline/store";

/**
 * Downloads, on a phone (owner, 2026-10-16): the top-right pill while notes
 * come down, and the block in the sheet behind it with a line and a Don't
 * download button per workspace. Words are `downloadSummary.ts`'s.
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

/** The ring and the count inside the pill. */
export function DownloadPillContent({ pill }: { pill: DownloadPill }) {
  const colors = useColors();
  const r = 8;
  const around = 2 * Math.PI * r;
  return (
    <>
      <Svg width={20} height={20} viewBox="0 0 20 20" aria-hidden>
        <Circle cx={10} cy={10} r={r} fill="none" stroke={colors.lineStrong} strokeWidth={2.5} />
        <Circle
          cx={10}
          cy={10}
          r={r}
          fill="none"
          stroke={colors.accent}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={`${Math.max(0.5, pill.fraction * around)} ${around}`}
          transform="rotate(-90 10 10)"
        />
      </Svg>
      <Text variant="pill" numberOfLines={1}>
        {pill.text}
      </Text>
    </>
  );
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
