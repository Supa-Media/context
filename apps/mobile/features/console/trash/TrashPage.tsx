import { useAction, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { type Colors, useColors, useThemedStyles } from "../../design/theme";
import { space } from "../../design/tokens";
import { toFileError } from "../files/browser";
import { relativeTime } from "../format";
import {
  byLine,
  daysLeftLabel,
  erasedSoon,
  eraseLabel,
  fromLabel,
  groupTrash,
  trashCopy,
  trashName,
  type TrashItem,
} from "./trashCopy";

/**
 * The Trash page (design A, Dev2 2026-10-17, project file `trash-page/`):
 * drawn where a note would be (`?trash=1`, `BrowseDocument`), so the tree
 * stays beside it. What goes soonest first, in bold red under "Erased this
 * week"; Restore on every row; no Delete forever (Dev2, 2026-10-14).
 *
 * The list is `trash.listTrash`, which shows only what this person could see
 * before it was trashed. Restore is the ordinary `restoreTrashEntry`; the row
 * leaves the list when the server says it is back, and a "Restored" line with
 * Open stays in its place until the page closes.
 */
export function TrashPage({
  workspaceId,
  compact,
  onOpen,
  onClose,
}: {
  workspaceId: string;
  compact: boolean;
  /** Open a note (a trashed one opens read-only, with Restore) or a restored folder. */
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const listing = useQuery(api.functions.trash.listTrash, { workspaceId: workspaceId as Id<"workspaces"> });
  const restoreAction = useAction(api.functions.files.restoreTrashEntry);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restored, setRestored] = useState<TrashItem[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const restore = (item: TrashItem) => {
    if (restoring !== null) return;
    setRestoring(item.trash);
    setFailure(null);
    void restoreAction({ workspaceId: workspaceId as Id<"workspaces">, from: item.trash, to: item.path })
      .then(() => setRestored((done) => [...done, item]))
      .catch((error: unknown) => setFailure(toFileError(error).message))
      .finally(() => setRestoring(null));
  };

  const back = new Set(restored.map((item) => item.trash));
  const items = (listing?.items ?? []).filter((item) => !back.has(item.trash));
  const { soon, later } = groupTrash(items, now);

  const row = (item: TrashItem) => (
    <TrashRow
      key={item.trash}
      item={item}
      now={now}
      compact={compact}
      busy={restoring === item.trash}
      disabled={restoring !== null}
      onRestore={() => restore(item)}
      onOpen={item.kind === "file" ? () => onOpen(item.path) : undefined}
    />
  );

  return (
    <View style={styles.page} testID="trash-page">
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text variant="paneTitle" role="heading" aria-level={1}>
            {trashCopy.heading}
          </Text>
          <Text variant="hint" style={styles.lede}>
            {trashCopy.lede(listing?.keepDays ?? 30)}
            <Text variant="hint" style={styles.bold}>{trashCopy.ledeBold}</Text>
            {trashCopy.ledeEnd}
          </Text>
        </View>
        <Pressable role="button" accessibilityLabel={trashCopy.close} onPress={onClose} style={styles.close} testID="trash-close">
          <Icon name="close" size={16} color={colors.chromeMuted} />
        </Pressable>
      </View>

      {failure !== null ? (
        <Text variant="meta" style={styles.failure} testID="trash-failure">
          {failure}
        </Text>
      ) : null}

      {restored.map((item) => (
        <View key={`back:${item.trash}`} style={styles.row} testID="trash-restored">
          <Icon name="check" size={14} color={colors.accent} />
          <View style={styles.rowText}>
            <Text variant="rowTitle" numberOfLines={1}>{trashName(item)}</Text>
            <Text variant="meta" style={styles.muted} numberOfLines={1}>
              {[trashCopy.restored, fromLabel(item.path)?.replace(/^from/, "to")].filter(Boolean).join(" ")}
            </Text>
          </View>
          <Button label={trashCopy.open} variant="dialog" onPress={() => onOpen(item.path)} testID="trash-open-restored" />
        </View>
      ))}

      {listing === undefined ? (
        <ActivityIndicator size="small" color={colors.muted} />
      ) : items.length === 0 ? (
        <Text variant="body" style={styles.muted} testID="trash-empty">
          {trashCopy.empty}
        </Text>
      ) : (
        <>
          {soon.length > 0 ? (
            <View style={styles.group}>
              <Text variant="eyebrow" style={styles.soonEyebrow} testID="trash-soon">
                {trashCopy.soon}
              </Text>
              {soon.map(row)}
            </View>
          ) : null}
          {later.length > 0 ? (
            <View style={styles.group}>
              <Text variant="eyebrow" style={styles.eyebrow} testID="trash-later">
                {trashCopy.later}
              </Text>
              {later.map(row)}
            </View>
          ) : null}
          {listing.more ? (
            <Text variant="meta" style={styles.muted}>
              {trashCopy.more}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

function TrashRow({
  item,
  now,
  compact,
  busy,
  disabled,
  onRestore,
  onOpen,
}: {
  item: TrashItem;
  now: number;
  compact: boolean;
  busy: boolean;
  disabled: boolean;
  onRestore: () => void;
  onOpen?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const soon = erasedSoon(item.eraseAt, now);
  const meta = compact
    ? [item.kind === "folder" ? trashCopy.notes(item.notes) : null, item.byYou ? "You" : (item.byName ?? "Someone"), fromLabel(item.path)]
        .filter(Boolean)
        .join(" · ")
    : [byLine(item), relativeTime(item.at, now), fromLabel(item.path)].filter(Boolean).join(" · ");
  const name = (
    <View style={styles.rowText}>
      <Text variant="rowTitle" numberOfLines={1}>
        {trashName(item)}
        {item.kind === "folder" && !compact ? <Text variant="meta" style={styles.muted}>{` · ${trashCopy.notes(item.notes)}`}</Text> : null}
      </Text>
      <Text variant="meta" style={styles.muted} numberOfLines={1}>
        {meta}
      </Text>
    </View>
  );
  return (
    <View style={styles.row} testID="trash-row">
      <Icon name={item.kind === "folder" ? "folder" : "file"} size={14} color={colors.chromeMuted} />
      {onOpen !== undefined ? (
        <Pressable role="link" accessibilityLabel={`Open ${trashName(item)}`} onPress={onOpen} style={styles.rowPress}>
          {name}
        </Pressable>
      ) : (
        <View style={styles.rowPress}>{name}</View>
      )}
      <Text variant="meta" style={soon ? styles.soonLabel : styles.muted} numberOfLines={1} testID="trash-days">
        {compact ? daysLeftLabel(item.eraseAt, now) : eraseLabel(item.eraseAt, now)}
      </Text>
      {compact && item.kind === "file" ? null : (
        <Button
          label={busy ? trashCopy.restoring : trashCopy.restore}
          variant="dialog"
          disabled={disabled}
          onPress={onRestore}
          leading={<Icon name="undo" size={12} color={colors.text} />}
          testID="trash-restore"
        />
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { paddingTop: space.x8, paddingBottom: space.x8, gap: space.x4 },
    head: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.x4 },
    headText: { flex: 1, minWidth: 0, gap: space.x2 },
    lede: { color: colors.chromeMuted },
    bold: { color: colors.critText, fontWeight: "700" },
    close: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 8 },
    failure: { color: colors.critText },
    group: { gap: space.x1 },
    eyebrow: { color: colors.chromeMuted, marginTop: space.x2 },
    soonEyebrow: { color: colors.critText, marginTop: space.x2 },
    row: { flexDirection: "row", alignItems: "center", gap: space.x3, paddingVertical: space.x2, minWidth: 0 },
    rowPress: { flex: 1, minWidth: 0 },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    muted: { color: colors.chromeMuted },
    soonLabel: { color: colors.critText, fontWeight: "700" },
  });
