/**
 * The side panel's lines: a subtask with the dot that ticks it off, a note
 * in the task, and "+ Add …". Every name opens here, in the panel's place.
 */

import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { ListNote } from "../../listBlock/model";
import { OwnerFace, StatusDot } from "../Glyphs";
import type { ItemActions } from "../items";
import type { FolderItem } from "../model";
import { folderStatuses, governingFolder, groupOfStatus } from "../statuses";
import { faceFor } from "../taskFace";
import { ownersOf } from "../taskProps";
import type { PropertyChanges } from "../useFolderPage";
import { tickStatus } from "./panelModel";

type ChooseMany = ((target: string, changes: PropertyChanges, creates: boolean) => Promise<string | null>) | null;

function isDone(item: FolderItem, notes: readonly ListNote[]): boolean {
  return groupOfStatus(item.status, folderStatuses(governingFolder(item.target), notes).list) === "done";
}

export function subtaskHead(subtasks: readonly FolderItem[], notes: readonly ListNote[]): string {
  if (subtasks.length === 0) return "Subtasks";
  const done = subtasks.filter((sub) => isDone(sub, notes)).length;
  return `Subtasks · ${done} of ${subtasks.length} done`;
}

export function Subtask({
  item,
  notes,
  actions,
  chooseMany,
  onShow,
}: {
  item: FolderItem;
  notes: readonly ListNote[];
  actions: ItemActions;
  chooseMany: ChooseMany;
  onShow: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const list = folderStatuses(governingFolder(item.target), notes).list;
  const tone = groupOfStatus(item.status, list) ?? "unplaced";
  const done = tone === "done";
  const next = tickStatus(item.status, list);
  const owner = ownersOf(item.properties)[0];
  return (
    <View style={styles.line} testID="task-panel-subtask">
      {chooseMany === null || next === null ? (
        <StatusDot tone={tone} />
      ) : (
        <Pressable
          onPress={() => void chooseMany(item.target, [["status", next]], item.creates)}
          role="button"
          accessibilityLabel={done ? "Mark not done" : "Mark done"}
          hitSlop={6}
          testID="task-panel-tick"
        >
          <StatusDot tone={tone} />
        </Pressable>
      )}
      <Pressable onPress={() => onShow(item.path)} role="link" style={styles.shrink} testID="task-panel-subtask-open">
        <Text variant="tree" numberOfLines={1} style={done ? styles.finished : styles.text}>
          {item.label}
        </Text>
      </Pressable>
      <View style={styles.push} />
      <OwnerFace face={faceFor(actions, owner)} size={20} />
    </View>
  );
}

/** A note in the task, or anything in a plain folder: its name opens it here. */
export function NoteLine({ item, onShow }: { item: FolderItem; onShow: (path: string) => void }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable onPress={() => onShow(item.path)} role="link" style={styles.line} testID="task-panel-note">
      <Icon name={item.kind === "folder" ? "folder" : "file"} size={15} color={colors.chromeMuted} />
      <Text variant="tree" numberOfLines={1} style={[styles.shrink, styles.text2]}>
        {item.label}
      </Text>
    </Pressable>
  );
}

export function Add({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable onPress={onPress} role="button" style={styles.add} testID={testID}>
      <Text variant="tree" style={styles.muted}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    line: { flexDirection: "row", alignItems: "center", gap: space.x3, minHeight: 32, borderRadius: radii.sm },
    push: { flexGrow: 1 },
    shrink: { flexShrink: 1, minWidth: 0 },
    muted: { color: colors.chromeMuted },
    text: { color: colors.text },
    text2: { color: colors.text2 },
    finished: { color: colors.chromeMuted, textDecorationLine: "line-through" },
    add: { alignSelf: "flex-start", paddingVertical: space.x2, paddingRight: space.x2 },
  });
