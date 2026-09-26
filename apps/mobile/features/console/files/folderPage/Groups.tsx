/**
 * A folder's children grouped by status — the List view of a folder page,
 * drawn the way a grouped list block draws (spec A1): a heading per group
 * with its count, rows on hairlines, the status and owner at the right, the
 * last save at the far right. Everything with no status is one "No status"
 * group at the end, each row with `Set status` for somebody who may write,
 * so the layout itself is the nudge.
 *
 * A folder row opens the folder's page; a note row opens the note. On a
 * phone the owner column goes and moves under the name, as the list block
 * does at that width, and each group is one card like the Files view's.
 */

import { Fragment, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { shortWhen } from "../listBlock/words";
import { NEW_FRONT_NOTE, type FolderGroup, type FolderItem } from "./model";
import { PropertyValue } from "./PropertyValue";
import { isStale, textOf, type ItemActions } from "./items";

export function FolderGroups({
  groups,
  compact,
  now,
  actions,
}: {
  groups: readonly FolderGroup[];
  compact: boolean;
  now: number;
  actions: ItemActions;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View testID="folder-groups">
      {groups.map((group, index) => (
        <View key={group.value.toLowerCase()} style={index > 0 && styles.groupGap} testID="folder-group">
          <View style={styles.groupHead}>
            <Text variant="rowTitle">{group.label}</Text>
            <Text variant="tree" style={styles.count}>
              {String(group.items.length)}
            </Text>
          </View>
          <View style={compact ? styles.card : styles.rows}>
            {group.items.map((item, at) => (
              <Fragment key={item.path}>
                {compact && at > 0 ? <View style={styles.cardRule} /> : null}
                <GroupRow item={item} compact={compact} now={now} actions={actions} />
              </Fragment>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function GroupRow({ item, compact, now, actions }: { item: FolderItem; compact: boolean; now: number; actions: ItemActions }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  const owner = textOf(item.properties, "owner");
  const updated = item.updatedAt === null ? "" : shortWhen(item.updatedAt, now);
  const stale = isStale(item.updatedAt, now);
  const edit = actions.onChoose;
  const status = (
    <PropertyValue
      property="status"
      value={item.status}
      choices={actions.choices("status")}
      savesTo={item.creates ? NEW_FRONT_NOTE : null}
      onChoose={edit === null ? null : (value) => edit(item, "status", value)}
      variant="tree"
      // The group already says it: a set status is the row's handle, shown when the row is.
      quiet={!compact && item.status !== "" && !hovered}
      style={compact ? styles.cellMuted : styles.cellText}
      testID="folder-item-status"
    />
  );
  const ownerValue = (
    <PropertyValue
      property="owner"
      value={owner}
      choices={actions.choices("owner")}
      savesTo={item.creates ? NEW_FRONT_NOTE : null}
      onChoose={edit === null ? null : (value) => edit(item, "owner", value)}
      quiet={owner === "" && !hovered}
      style={styles.cellText}
      testID="folder-item-owner"
    />
  );
  return (
    <Pressable
      onPress={() => actions.onOpen(item)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="link"
      accessibilityLabel={item.kind === "folder" ? `${item.label}, folder` : item.label}
      style={[compact ? styles.rowTouch : styles.row, hovered && styles.rowHover]}
      testID="folder-item"
    >
      {compact ? null : (
        <View style={styles.gutter}>
          {item.kind === "folder" ? <Icon name="chevronRight" size={15} color={colors.muted} /> : null}
        </View>
      )}
      <View style={styles.name}>
        <View style={styles.nameLine}>
          {compact ? (
            <Icon name={item.kind === "folder" ? "folder" : "file"} size={16} color={colors.muted} />
          ) : null}
          <Text variant={compact ? "treeTouch" : "tree"} numberOfLines={1} style={styles.label}>
            {item.label}
          </Text>
          {item.progress === null ? null : (
            <Text variant="meta" style={styles.progress} accessibilityLabel={`${item.progress.done} of ${item.progress.total} done`}>
              {`${item.progress.done}/${item.progress.total}`}
            </Text>
          )}
        </View>
        {compact && (owner !== "" || updated !== "") ? (
          <Text variant="meta" numberOfLines={1} style={styles.sub}>
            {[owner === "" ? null : owner, updated === "" ? null : updated].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
      </View>
      {edit === null ? null : <View style={compact ? styles.statusTouch : styles.cell}>{status}</View>}
      {compact ? null : <View style={styles.cell}>{ownerValue}</View>}
      {compact ? null : (
        <Text variant="meta" numberOfLines={1} style={[styles.when, stale && styles.stale]}>
          {updated}
        </Text>
      )}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    groupGap: { marginTop: space.x6 },
    groupHead: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: space.x2,
      height: 32,
      paddingTop: space.x2,
    },
    count: { color: colors.chromeMuted },
    rows: { borderTopWidth: 1, borderTopColor: colors.line },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      height: 44,
      paddingRight: space.x1,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    rowTouch: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: 56,
      paddingHorizontal: space.x4,
      paddingVertical: space.x2,
    },
    rowHover: { backgroundColor: colors.surface3 },
    gutter: { width: 18, alignItems: "center", justifyContent: "center", marginRight: -space.x2 },
    name: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    nameLine: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    label: { flexShrink: 1, color: colors.text },
    progress: { color: colors.chromeMuted },
    sub: { color: colors.muted },
    cell: { width: 96, flexShrink: 0 },
    statusTouch: { flexShrink: 0, maxWidth: 120 },
    cellText: { color: colors.text2 },
    cellMuted: { color: colors.muted },
    when: { width: 72, flexShrink: 0, textAlign: "right", color: colors.muted },
    stale: { color: colors.chromeMuted },
    card: { backgroundColor: colors.pageSurface, borderRadius: radii.sheet, overflow: "hidden" },
    cardRule: { height: 1, marginLeft: space.x4, backgroundColor: colors.line },
  });
