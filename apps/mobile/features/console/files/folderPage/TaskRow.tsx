/**
 * One row of a project's List: a task, a subtask under an opened task, or a
 * plain note.
 *
 * A **task** row reads left to right: the chevron that opens it (only when it
 * holds subtasks or notes), its priority, its name with "2 of 4 done", its
 * tags, when it is due, and its first owner's face and name ("+1" when there
 * are more). Its status stays a quiet control at the right for somebody who
 * may write: the section already says it. Opened, it shows its subtasks, then
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
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { shortWhen } from "../listBlock/words";
import { OwnerFace, PriorityGlyph, StatusDot, type Face } from "./Glyphs";
import { ownerChoiceFor, ownerLabel, type ItemActions } from "./items";
import type { TaskEntry } from "./listLayout";
import { NEW_FRONT_NOTE, type FolderItem } from "./model";
import { PropertyValue } from "./PropertyValue";
import { dueOf, dueWord, ownersOf, tagsOf } from "./taskProps";
import { isPickPress, PickBox, RowFrame, SubtaskAdder, SubtaskButton } from "./tasks/RowParts";

/** Tags drawn on a row before the rest are counted. */
const TAGS_SHOWN = 2;

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
  const [hovered, setHovered] = useState(false);
  const { item } = entry;
  const opens = entry.subtasks.length > 0 || entry.notes.length > 0;
  const tags = tagsOf(item.properties);
  const due = dueOf(item.properties);
  const edit = actions.onChoose;
  const progress = item.progress === null ? null : `${item.progress.done} of ${item.progress.total} done`;
  const tasks = actions.tasks ?? null;
  const picked = tasks?.selected.has(item.path) ?? false;
  return (
    <>
      <RowFrame item={item} controls={tasks}>
        <Pressable
          onPress={(event) => (tasks !== null && isPickPress(event) ? tasks.togglePick(item.path) : actions.onOpen(item))}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          role="link"
          aria-current={actions.selected === item.path ? "true" : undefined}
          accessibilityLabel={item.kind === "folder" ? `${item.label}, folder` : item.label}
          style={[compact ? styles.rowTouch : styles.row, (hovered || actions.selected === item.path) && styles.rowHover, picked && styles.rowPicked, entry.dim && styles.dim]}
          testID="folder-item"
        >
          {tasks === null ? null : (
            <PickBox picked={picked} shown={hovered || tasks.selected.size > 0} label={item.label} onPick={() => tasks.togglePick(item.path)} />
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
          <PriorityGlyph priority={item.priority} />
          <View style={styles.name}>
            <View style={styles.nameLine}>
              <Text variant={compact ? "treeTouch" : "tree"} numberOfLines={1} style={styles.label}>
                {item.label}
              </Text>
              {progress === null ? null : (
                <Text variant="meta" style={styles.muted} testID="folder-item-progress">
                  {progress}
                </Text>
              )}
            </View>
            {compact ? <CompactLine item={item} due={due === null ? "" : dueWord(due, now)} actions={actions} /> : null}
          </View>
          {tasks === null || compact ? null : (
            <SubtaskButton shown={hovered} onPress={() => tasks.openComposer({ kind: "subtask", parent: item.path })} />
          )}
          {compact ? null : <Tags tags={tags} />}
          {compact ? null : (
            <Text variant="meta" numberOfLines={1} style={styles.due} testID="folder-item-due">
              {due === null ? "" : dueWord(due, now)}
            </Text>
          )}
          {edit === null ? null : (
            <View style={compact ? styles.statusTouch : styles.cell}>
              <StatusValue item={item} actions={actions} quiet={!compact && !hovered} compact={compact} />
            </View>
          )}
          {compact ? null : (
            <View style={styles.owner}>
              <OwnerCell item={item} actions={actions} />
            </View>
          )}
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
  const [hovered, setHovered] = useState(false);
  const tone = actions.toneOf(item.status);
  const tasks = actions.tasks ?? null;
  const picked = tasks?.selected.has(item.path) ?? false;
  return (
    <RowFrame item={item} controls={tasks}>
      <Pressable
        onPress={(event) => (tasks !== null && isPickPress(event) ? tasks.togglePick(item.path) : actions.onOpen(item))}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        role="link"
        accessibilityLabel={item.label}
        style={[compact ? styles.rowTouch : styles.row, styles.nested, hovered && styles.rowHover, picked && styles.rowPicked]}
        testID="folder-subtask"
      >
        {tasks === null ? null : (
          <PickBox picked={picked} shown={hovered || tasks.selected.size > 0} label={item.label} onPick={() => tasks.togglePick(item.path)} />
        )}
        <StatusDot tone={tone} />
        <Text variant={compact ? "treeTouch" : "tree"} numberOfLines={1} style={[styles.label, styles.grow, tone === "done" && styles.finished]}>
          {item.label}
        </Text>
        {actions.onChoose === null ? null : (
          <View style={compact ? styles.statusTouch : styles.cell}>
            <StatusValue item={item} actions={actions} quiet={!compact && !hovered} compact={compact} />
          </View>
        )}
        {compact ? null : (
          <View style={styles.owner}>
            <OwnerCell item={item} actions={actions} />
          </View>
        )}
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
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const owner = ownersOf(item.properties)[0];
  const meta = [owner === undefined ? null : ownerLabel(actions.owners, owner), item.updatedAt === null ? null : shortWhen(item.updatedAt, now)]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const make = actions.onMakeTask ?? null;
  const label = actions.makeTaskLabel ?? "Make it a task";
  return (
    <RowFrame item={item} controls={actions.tasks ?? null} note>
      <Pressable
        onPress={() => actions.onOpen(item)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        role="link"
        accessibilityLabel={item.kind === "folder" ? `${item.label}, folder` : item.label}
        style={[compact ? styles.rowTouch : styles.noteRow, nested && styles.nested, hovered && styles.rowHover]}
        testID="folder-note"
      >
        <Icon name={item.kind === "folder" ? "folder" : "file"} size={16} color={colors.chromeMuted} />
        <Text variant={compact ? "treeTouch" : "tree"} numberOfLines={1} style={[styles.noteLabel, styles.grow]}>
          {item.label}
        </Text>
        {make === null ? null : (
          <Pressable
            onPress={() => make(item)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            role="button"
            accessibilityLabel={item.creates ? `${label}, saves to ${NEW_FRONT_NOTE}` : label}
            style={[styles.mini, !compact && !hovered && !focused && styles.quiet]}
            testID="folder-make-task"
          >
            <Text variant="meta" style={styles.miniText}>
              {label}
            </Text>
          </Pressable>
        )}
        {meta === "" ? null : (
          <Text variant="meta" numberOfLines={1} style={styles.muted}>
            {meta}
          </Text>
        )}
      </Pressable>
    </RowFrame>
  );
}

function StatusValue({ item, actions, quiet, compact }: { item: FolderItem; actions: ItemActions; quiet: boolean; compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const edit = actions.onChoose;
  return (
    <PropertyValue
      property="status"
      value={item.status}
      choices={actions.choices("status")}
      sections={actions.statusMenu}
      onEditList={actions.onEditStatuses}
      savesTo={item.creates ? NEW_FRONT_NOTE : null}
      onChoose={edit === null ? null : (value) => edit(item, "status", value)}
      variant="tree"
      // The section already says it: a set status is the row's handle, shown when the row is.
      quiet={quiet}
      style={compact ? styles.cellMuted : styles.cellText}
      testID="folder-item-status"
    />
  );
}

function faceFor(actions: ItemActions, owner: string | undefined): Face {
  if (owner === undefined) return { kind: "nobody" };
  return actions.faceOf?.(owner) ?? { kind: "person", name: ownerLabel(actions.owners, owner) };
}

function OwnerCell({ item, actions }: { item: FolderItem; actions: ItemActions }) {
  const styles = useThemedStyles(makeStyles);
  const owners = ownersOf(item.properties);
  const first = owners[0];
  const more = owners.length - 1;
  const edit = actions.onChoose;
  // A list of owners is shown, never offered as one choice: picking one would drop the rest.
  const editable = edit !== null && more <= 0;
  return (
    <View style={styles.ownerLine}>
      <PropertyValue
        property="owner"
        value={first ?? ""}
        choices={actions.choices("owner")}
        {...(actions.owners === undefined ? {} : { owners: ownerChoiceFor(actions.owners, item.creates ? null : item.target) })}
        savesTo={item.creates ? NEW_FRONT_NOTE : null}
        onChoose={editable ? (value) => edit(item, "owner", value) : null}
        lead={<OwnerFace face={faceFor(actions, first)} />}
        unsetLabel="No owner"
        style={styles.cellText}
        testID="folder-item-owner"
      />
      {more > 0 ? (
        <Text variant="meta" style={styles.muted} accessibilityLabel={`and ${more} more`} testID="folder-item-more-owners">
          {`+${more}`}
        </Text>
      ) : null}
    </View>
  );
}

function Tags({ tags }: { tags: readonly string[] }) {
  const styles = useThemedStyles(makeStyles);
  if (tags.length === 0) return null;
  const rest = tags.length - TAGS_SHOWN;
  return (
    <View style={styles.tags} testID="folder-item-tags">
      {tags.slice(0, TAGS_SHOWN).map((tag) => (
        <Text key={tag.toLowerCase()} variant="meta" numberOfLines={1} style={styles.tag}>
          {isolateForDisplay(tag)}
        </Text>
      ))}
      {rest > 0 ? (
        <Text variant="meta" style={styles.muted}>
          {`+${rest}`}
        </Text>
      ) : null}
    </View>
  );
}

/** On a phone the columns go, and who and when move under the name. */
function CompactLine({ item, due, actions }: { item: FolderItem; due: string; actions: ItemActions }) {
  const styles = useThemedStyles(makeStyles);
  const owners = ownersOf(item.properties);
  const who = owners.length === 0 ? null : ownerLabel(actions.owners, owners[0]) + (owners.length > 1 ? ` +${owners.length - 1}` : "");
  const tags = tagsOf(item.properties);
  const parts = [who, due === "" ? null : due, tags.length === 0 ? null : tags.map((tag) => isolateForDisplay(tag)).join(", ")];
  const line = parts.filter((part): part is string => part !== null).join(" · ");
  return line === "" ? null : (
    <Text variant="meta" numberOfLines={1} style={styles.sub}>
      {line}
    </Text>
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
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
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
    gutter: { width: 13, alignItems: "center", justifyContent: "center", marginRight: -space.x1 },
    name: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    nameLine: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    grow: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    label: { flexShrink: 1, color: colors.text },
    noteLabel: { color: colors.text2 },
    finished: { color: colors.chromeMuted, textDecorationLine: "line-through" },
    muted: { color: colors.chromeMuted },
    sub: { color: colors.muted },
    tags: { flexDirection: "row", alignItems: "center", gap: space.x1, flexShrink: 0, maxWidth: 180 },
    tag: {
      flexShrink: 1,
      color: colors.muted,
      backgroundColor: colors.chipFill,
      borderRadius: radii.sm,
      paddingHorizontal: space.x2,
      paddingVertical: 2,
    },
    due: { width: 48, flexShrink: 0, textAlign: "right", color: colors.muted },
    cell: { width: 96, flexShrink: 0 },
    statusTouch: { flexShrink: 0, maxWidth: 120 },
    owner: { width: 136, flexShrink: 0 },
    ownerLine: { flexDirection: "row", alignItems: "center", gap: space.x1, minWidth: 0 },
    cellText: { color: colors.text2 },
    cellMuted: { color: colors.muted },
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
