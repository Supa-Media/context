/**
 * One row of a project's List: a task, a subtask under an opened task, or a
 * plain note.
 *
 * A **task** row reads left to right: the chevron that opens it (only when it
 * holds subtasks or notes), its priority, its name with "2 of 4 done", its
 * tags, when it is due, and its first owner's face and name ("+1" when there
 * are more). The name takes the room; the cells after it are compact and give
 * way first (`rowCells.tsx`). For somebody who may write the priority mark is
 * a button with the priority choices, and the status value, Open and
 * "+ Subtask" lie over the end of the name while the row is hovered — the
 * section already says the status. Opened, it shows its subtasks, then
 * "NOTES IN THIS TASK" and the notes beside them.
 *
 * A **note** row is a document (or a folder) with who owns it and when it was
 * last saved, and — for somebody who may write — "Make it a task", which
 * gives it the folder's first To do status.
 *
 * For somebody who may write (`actions.tasks`), a task row is also a thing
 * to pick up and drop on, right-click, pick with its checkbox or Shift/⌘/Ctrl,
 * and give a subtask with "+ Subtask"; an opened task ends with "+ Add
 * subtask" (`tasks/RowParts.tsx`).
 *
 * A member sees the same rows with words where the controls would be. An
 * owner line naming several is shown, never offered as one choice: picking
 * one would drop the others.
 */

import { Fragment, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { shortWhen } from "../listBlock/words";
import { StatusDot } from "./Glyphs";
import { ownerLabel, type ItemActions } from "./items";
import type { TaskEntry } from "./listLayout";
import { NEW_FRONT_NOTE, type FolderItem } from "./model";
import { PeekButton } from "./PeekButton";
import { CompactLine, NAME_MIN, OwnerCell, PriorityCell, RowTools, StatusValue, Tags, useRowHover, useToolsRoom } from "./rowCells";
import { dueOf, dueWord, ownersOf, tagsOf } from "./taskProps";
import { isPickPress, PickBox, RowFrame, SubtaskAdder, SubtaskButton } from "./tasks/RowParts";
import { holdToOpen, MoreButton } from "./tasks/PhoneParts";

export function TaskRow({
  entry,
  open,
  onToggle,
  compact,
  now,
  actions,
}: {
  entry: TaskEntry;
  open: boolean;
  onToggle: () => void;
  compact: boolean;
  now: number;
  actions: ItemActions;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [hovered, hover] = useRowHover();
  const [room, toolsRoom] = useToolsRoom(hovered);
  const { item } = entry;
  const opens = entry.subtasks.length > 0 || entry.notes.length > 0;
  const due = dueOf(item.properties);
  const edit = actions.onChoose;
  const progress = item.progress === null ? null : `${item.progress.done} of ${item.progress.total} done`;
  const tasks = actions.tasks ?? null;
  const picked = tasks?.selected.has(item.path) ?? false;
  return (
    <>
      <RowFrame item={item} controls={tasks} swipe={compact ? actions.taskMenu : null}>
        <Pressable
          onPress={(event) => (tasks !== null && isPickPress(event) ? tasks.togglePick(item.path) : actions.onOpen(item))}
          {...holdToOpen(item, tasks, compact)}
          {...hover}
          role="link"
          aria-current={actions.selected === item.path ? "true" : undefined}
          accessibilityLabel={item.kind === "folder" ? `${item.label}, folder` : item.label}
          style={[compact ? styles.rowTouch : styles.row, (hovered || actions.selected === item.path) && styles.rowHover, picked && styles.rowPicked, entry.dim && styles.dim]}
          testID="folder-item"
        >
          {tasks === null ? null : (
            <View style={compact ? undefined : styles.pick}>
              <PickBox picked={picked} shown={hovered || tasks.selected.size > 0} label={item.label} onPick={() => tasks.togglePick(item.path)} />
            </View>
          )}
          <View style={styles.gutter}>
            {opens ? (
              <Pressable
                onPress={onToggle}
                role="button"
                aria-expanded={open}
                accessibilityLabel={open ? `Close ${item.label}` : `Open ${item.label}`}
                hitSlop={8}
                testID="folder-expand"
              >
                <Icon name={open ? "chevronDown" : "chevronRight"} size={13} color={colors.chromeMuted} />
              </Pressable>
            ) : null}
          </View>
          <PriorityCell item={item} actions={actions} />
          <View style={[styles.name, room]} testID="folder-item-name">
            <View style={styles.nameLine}>
              <Text variant={compact ? "treeTouch" : "tree"} numberOfLines={1} style={styles.label} testID="folder-item-label">
                {item.label}
              </Text>
              {progress === null ? null : (
                <Text variant="meta" numberOfLines={1} style={styles.progress} testID="folder-item-progress">
                  {progress}
                </Text>
              )}
            </View>
            {compact ? <CompactLine item={item} due={due === null ? "" : dueWord(due, now)} actions={actions} /> : null}
            {compact ? null : (
              <RowTools shown={hovered} room={toolsRoom}>
                <PeekButton item={item} actions={actions} shown={hovered} />
                {tasks === null ? null : (
                  <SubtaskButton shown={hovered} onPress={() => tasks.openComposer({ kind: "subtask", parent: item.path })} />
                )}
                {edit === null ? null : <StatusValue item={item} actions={actions} quiet={!hovered} compact={false} />}
              </RowTools>
            )}
          </View>
          {compact ? null : <Tags tags={tagsOf(item.properties)} />}
          {compact ? null : (
            <Text variant="meta" numberOfLines={1} style={styles.due} testID="folder-item-due">
              {due === null ? "" : dueWord(due, now)}
            </Text>
          )}
          {compact && edit !== null ? (
            <View style={styles.statusTouch}>
              <StatusValue item={item} actions={actions} quiet={false} compact />
            </View>
          ) : null}
          {compact ? null : <OwnerCell item={item} actions={actions} />}
          {compact && tasks !== null ? <MoreButton item={item} controls={tasks} /> : null}
        </Pressable>
      </RowFrame>
      {open ? <Opened entry={entry} compact={compact} now={now} actions={actions} /> : null}
    </>
  );
}

function Opened({ entry, compact, now, actions }: { entry: TaskEntry; compact: boolean; now: number; actions: ItemActions }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View testID="folder-task-open">
      {entry.subtasks.map((item) => (
        <SubtaskRow key={item.path} item={item} compact={compact} actions={actions} />
      ))}
      {entry.notes.length === 0 ? null : (
        <>
          <Text variant="eyebrow" style={styles.notesLabel} testID="folder-task-notes-label">
            NOTES IN THIS TASK
          </Text>
          {entry.notes.map((item) => (
            <NoteRow key={item.path} item={item} nested compact={compact} now={now} actions={actions} />
          ))}
        </>
      )}
      {actions.tasks == null || entry.dim ? null : <SubtaskAdder parent={entry.item} controls={actions.tasks} />}
    </View>
  );
}

function SubtaskRow({ item, compact, actions }: { item: FolderItem; compact: boolean; actions: ItemActions }) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, hover] = useRowHover();
  const [room, toolsRoom] = useToolsRoom(hovered);
  const tone = actions.toneOf(item.status);
  const tasks = actions.tasks ?? null;
  const picked = tasks?.selected.has(item.path) ?? false;
  return (
    <RowFrame item={item} controls={tasks} swipe={compact ? actions.taskMenu : null}>
      <Pressable
        onPress={(event) => (tasks !== null && isPickPress(event) ? tasks.togglePick(item.path) : actions.onOpen(item))}
        {...holdToOpen(item, tasks, compact)}
        {...hover}
        role="link"
        aria-current={actions.selected === item.path ? "true" : undefined}
        accessibilityLabel={item.label}
        style={[compact ? styles.rowTouch : styles.row, styles.nested, (hovered || actions.selected === item.path) && styles.rowHover, picked && styles.rowPicked]}
        testID="folder-subtask"
      >
        {tasks === null ? null : (
          <View style={compact ? undefined : styles.pickNested}>
            <PickBox picked={picked} shown={hovered || tasks.selected.size > 0} label={item.label} onPick={() => tasks.togglePick(item.path)} />
          </View>
        )}
        <StatusDot tone={tone} />
        <View style={[styles.name, room]}>
          <Text variant={compact ? "treeTouch" : "tree"} numberOfLines={1} style={[styles.label, tone === "done" && styles.finished]} testID="folder-item-label">
            {item.label}
          </Text>
          {compact ? null : (
            <RowTools shown={hovered} room={toolsRoom}>
              <PeekButton item={item} actions={actions} shown={hovered} />
              {actions.onChoose === null ? null : <StatusValue item={item} actions={actions} quiet={!hovered} compact={false} />}
            </RowTools>
          )}
        </View>
        {compact && actions.onChoose !== null ? (
          <View style={styles.statusTouch}>
            <StatusValue item={item} actions={actions} quiet={false} compact />
          </View>
        ) : null}
        {compact ? null : <OwnerCell item={item} actions={actions} />}
        {compact && tasks !== null ? <MoreButton item={item} controls={tasks} /> : null}
      </Pressable>
    </RowFrame>
  );
}

export function NoteRow({
  item,
  nested = false,
  compact,
  now,
  actions,
}: {
  item: FolderItem;
  nested?: boolean;
  compact: boolean;
  now: number;
  actions: ItemActions;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [hovered, hover] = useRowHover();
  const [focused, setFocused] = useState(false);
  const [room, toolsRoom] = useToolsRoom(hovered || focused);
  const owner = ownersOf(item.properties)[0];
  const meta = [owner === undefined ? null : ownerLabel(actions.owners, owner), item.updatedAt === null ? null : shortWhen(item.updatedAt, now)]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const make = actions.onMakeTask ?? null;
  const label = actions.makeTaskLabel ?? "Make it a task";
  const shown = compact || hovered || focused;
  const makeButton =
    make === null ? null : (
      <Pressable
        onPress={() => make(item)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        role="button"
        accessibilityLabel={item.creates ? `${label}, saves to ${NEW_FRONT_NOTE}` : label}
        style={[styles.mini, !shown && styles.quiet]}
        testID="folder-make-task"
      >
        <Text variant="meta" numberOfLines={1} style={styles.miniText}>
          {label}
        </Text>
      </Pressable>
    );
  return (
    <RowFrame item={item} controls={actions.tasks ?? null} note>
      <Pressable
        onPress={() => actions.onOpen(item)}
        {...holdToOpen(item, actions.tasks ?? null, compact)}
        {...hover}
        role="link"
        aria-current={actions.selected === item.path ? "true" : undefined}
        accessibilityLabel={item.kind === "folder" ? `${item.label}, folder` : item.label}
        style={[compact ? styles.rowTouch : styles.noteRow, nested && styles.nested, (hovered || actions.selected === item.path) && styles.rowHover]}
        testID="folder-note"
      >
        <Icon name={item.kind === "folder" ? "folder" : "file"} size={16} color={colors.chromeMuted} />
        <View style={[styles.name, room]}>
          <Text variant={compact ? "treeTouch" : "tree"} numberOfLines={1} style={styles.noteLabel} testID="folder-item-label">
            {item.label}
          </Text>
          {compact ? null : (
            <RowTools shown={hovered || focused} room={toolsRoom}>
              <PeekButton item={item} actions={actions} shown={hovered || focused} />
              {makeButton}
            </RowTools>
          )}
        </View>
        {compact ? makeButton : null}
        {meta === "" ? null : (
          <Text variant="meta" numberOfLines={1} style={styles.meta}>
            {meta}
          </Text>
        )}
        {compact && actions.tasks != null ? <MoreButton item={item} controls={actions.tasks} /> : null}
      </Pressable>
    </RowFrame>
  );
}

/** The rows of one column, on hairlines — or, on a phone, as one card. */
export function RowList({ children, compact }: { children: readonly ReactNode[]; compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={compact ? styles.card : styles.rows}>
      {children.map((child, at) => (
        <Fragment key={at}>
          {compact && at > 0 ? <View style={styles.cardRule} /> : null}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // Compact cells after the name, a little apart; the name is the one that grows.
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      minHeight: 40,
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
    noteRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: 36,
      paddingLeft: space.x1,
      paddingRight: space.x1,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    rowHover: { backgroundColor: colors.surface3 },
    rowPicked: { backgroundColor: colors.rowSelected },
    dim: { opacity: 0.55 },
    nested: { paddingLeft: 42 },
    // The selection's checkbox sits in the margin left of the row, so it never pushes the name.
    pick: { position: "absolute", left: -22, top: 0, bottom: 0, justifyContent: "center" },
    pickNested: { position: "absolute", left: 20, top: 0, bottom: 0, justifyContent: "center" },
    gutter: { width: 13, alignItems: "center", justifyContent: "center" },
    // The name takes the room, never less than `NAME_MIN`: the cells after it give way first.
    name: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: NAME_MIN, alignSelf: "stretch", justifyContent: "center" },
    nameLine: { flexDirection: "row", alignItems: "center", gap: space.x2, minWidth: 0 },
    label: { flexShrink: 1, minWidth: 0, color: colors.text },
    // "2 of 4 done" is one line beside the name, always whole.
    progress: { flexShrink: 0, color: colors.chromeMuted, whiteSpace: "nowrap" } as never,
    noteLabel: { color: colors.text2, minWidth: 0 },
    finished: { color: colors.chromeMuted, textDecorationLine: "line-through" },
    meta: { flexShrink: 0, color: colors.chromeMuted },
    due: { width: 52, flexShrink: 0, textAlign: "right", color: colors.muted },
    statusTouch: { flexShrink: 0, maxWidth: 120 },
    mini: {
      flexShrink: 0,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface3,
      borderRadius: radii.sm,
      paddingHorizontal: space.x2,
      paddingVertical: 2,
    },
    miniText: { color: colors.text2 },
    quiet: { opacity: 0 },
    notesLabel: { color: colors.chromeMuted, paddingLeft: 42, paddingTop: space.x2, paddingBottom: 2 },
    rows: { borderTopWidth: 1, borderTopColor: colors.line },
    card: { backgroundColor: colors.pageSurface, borderRadius: radii.sheet, overflow: "hidden" },
    cardRule: { height: 1, marginLeft: space.x4, backgroundColor: colors.line },
  });
