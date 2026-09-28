/**
 * One task, open beside a project's List or Board (the approved artboard):
 * where it is, its name, its values (`PanelProperties.tsx`), its subtasks
 * with dots that tick them off, and the notes in it — with "+ Add subtask",
 * "+ Add a note", "Open full page" and ✕.
 *
 * - A **subtask's dot** flips it between the list's first Done word and its
 *   first Not started word that is not Backlog (`tickStatus`); its name
 *   opens it here, under the task it belongs to. A subtask has no Subtasks
 *   section: two levels and no deeper.
 * - **Adding** a subtask or a note is planned first (`planAddSubtask`,
 *   `planAddNote`) and run through the console's own writes; a one-note task
 *   becomes a folder on the first, and the panel follows it there.
 * - A **note** in the task opens as a note, leaving the page.
 *
 * Nothing is read but the device's notes at the reader's clearance, and a
 * member is shown the same task with nothing to press that would write.
 */

import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { ListNote } from "../../listBlock/model";
import { OwnerFace, StatusDot } from "../Glyphs";
import type { ItemActions } from "../items";
import { makeItTaskStatus } from "../listLayout";
import type { FolderItem } from "../model";
import { folderStatuses, governingFolder, groupOfStatus } from "../statuses";
import { faceFor } from "../taskFace";
import { ownersOf } from "../taskProps";
import { QuickAddComposer, type QuickAddTask } from "../tasks/QuickAddComposer";
import { planAddNote, planAddSubtask, runPlanned, type Planned, type TaskRef, type TaskWriteIO } from "../tasks/taskWrites";
import { tagsInUse } from "../tasks/taskWords";
import type { PropertyChanges } from "../useFolderPage";
import { PanelProperties } from "./PanelProperties";
import { panelEntry, PANEL_WIDTH, taskRefOf, tickStatus, type PanelEntry } from "./panelModel";

export interface TaskPanelProps {
  /** The task shown: a task of the project, or a subtask of one. */
  path: string;
  /** The project's folder. */
  folder: string;
  notes: readonly ListNote[];
  /** What the project is called, for where the task is. */
  projectTitle: string;
  actions: ItemActions;
  /** Several properties of one note, as the page writes them (`FolderNotes.chooseMany`); null for a member. */
  chooseMany: ((target: string, changes: PropertyChanges, creates: boolean) => Promise<string | null>) | null;
  /** The console's file writes; null where the page cannot make them, and nothing is offered that needs them. */
  io: TaskWriteIO | null;
  /** Every path the page's listing shows, so a new name misses them too. */
  paths: readonly string[];
  now: number;
  /** Show another task here. */
  onShow: (path: string) => void;
  /** Leave for a note's or a folder's own page. */
  onNavigate: (path: string) => void;
  onClose: () => void;
}

export function TaskPanel(props: TaskPanelProps) {
  const { path, folder, notes, actions, chooseMany, io, now, onShow, onNavigate, onClose } = props;
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  // What was last shown stays while the device's copy catches up with a move (a task that just became a folder).
  const last = useRef<PanelEntry | null>(null);
  const found = panelEntry(path, folder, notes);
  if (found !== null) last.current = found;
  const entry = found ?? (last.current !== null && became(last.current.item, path) ? last.current : null);
  const [opened, setOpened] = useState<{ path: string; kind: "subtask" | "note" } | null>(null);
  // A composer belongs to the task it was opened on, and stays open as that task becomes a folder.
  const adding = opened !== null && (opened.path === path || opened.path.replace(/\.md$/i, "") === path) ? opened.kind : null;
  const setAdding = (kind: "subtask" | "note" | null) => setOpened(kind === null ? null : { path, kind });
  // A task that went while it was open (archived, moved out of the project) closes the panel.
  const gone = entry === null;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (entry === null) return null;
  const { item, parent } = entry;
  const ref = taskRefOf(item, path);
  const write =
    chooseMany === null ? null : (key: string, value: string | readonly string[] | null) => void chooseMany(ref.target, [[key, value]], ref.creates);
  const run = async (planned: Planned): Promise<string | null> => {
    if (io === null) return "This can’t be changed from here.";
    const result = await runPlanned(io, planned);
    if (!result.ok) return result.problem;
    // A one-note task is a folder now; the panel follows it there.
    if (ref.kind === "note") onShow(ref.path.replace(/\.md$/i, ""));
    return null;
  };
  const snapshot = { folder, notes, paths: props.paths };
  const canAdd = write !== null && io !== null;
  return (
    <View style={styles.panel} role="complementary" aria-label="Task details" testID="task-panel">
      <View style={styles.crumb} testID="task-panel-crumb">
        <Text variant="treeMeta" numberOfLines={1} style={styles.muted}>
          {props.projectTitle}
        </Text>
        {parent === null ? null : (
          <>
            <Text variant="treeMeta" style={styles.muted}>
              ›
            </Text>
            <Pressable onPress={() => onShow(parent.path)} role="link" style={styles.shrink} testID="task-panel-crumb-parent">
              <Text variant="treeMeta" numberOfLines={1} style={styles.link}>
                {parent.label}
              </Text>
            </Pressable>
          </>
        )}
        <View style={styles.push} />
        <Pressable onPress={() => onNavigate(ref.path)} role="link" testID="task-panel-open">
          <Text variant="treeMeta" style={styles.link}>
            Open full page
          </Text>
        </Pressable>
        <Pressable onPress={onClose} role="button" accessibilityLabel="Close" hitSlop={8} testID="task-panel-close">
          <Icon name="close" size={13} color={colors.chromeMuted} />
        </Pressable>
      </View>
      <Text variant="paneTitle" testID="task-panel-title">
        {item.label}
      </Text>
      <PanelProperties
        item={item}
        target={item.creates ? null : ref.target}
        actions={actions}
        write={write}
        tagSuggestions={tagsInUse(notes, folder)}
        now={now}
      />
      {entry.subtasks === null ? null : (
        <View style={styles.section}>
          <Text variant="tree" style={styles.head} testID="task-panel-subtasks-head">
            {subtaskHead(entry.subtasks, notes)}
          </Text>
          {entry.subtasks.map((sub) => (
            <Subtask key={sub.path} item={sub} notes={notes} actions={actions} chooseMany={chooseMany} onShow={onShow} />
          ))}
          {canAdd ? (
            adding === "subtask" ? (
              <QuickAddComposer
                compact
                onAdd={(task) => run(planAddSubtask(ref, newSubtask(task, ref, notes), snapshot))}
                onCancel={() => setAdding(null)}
              />
            ) : (
              <Add label="+ Add subtask" onPress={() => setAdding("subtask")} testID="task-panel-add-subtask" />
            )
          ) : null}
        </View>
      )}
      {entry.notes.length === 0 && !canAdd ? null : (
        <View style={styles.section}>
          <Text variant="tree" style={styles.head} testID="task-panel-notes-head">
            {`Notes · ${entry.notes.length}`}
          </Text>
          {entry.notes.map((each) => (
            <Pressable key={each.path} onPress={() => onNavigate(each.path)} role="link" style={styles.line} testID="task-panel-note">
              <Icon name={each.kind === "folder" ? "folder" : "file"} size={15} color={colors.chromeMuted} />
              <Text variant="tree" numberOfLines={1} style={[styles.shrink, styles.text2]}>
                {each.label}
              </Text>
            </Pressable>
          ))}
          {canAdd ? (
            adding === "note" ? (
              <QuickAddComposer
                compact
                placeholder="Name the note…"
                fieldLabel="New note"
                onAdd={(task) => run(planAddNote(ref, task.title, snapshot))}
                onCancel={() => setAdding(null)}
              />
            ) : (
              <Add label="+ Add a note" onPress={() => setAdding("note")} testID="task-panel-add-note" />
            )
          ) : null}
        </View>
      )}
    </View>
  );
}

/** `path` is the folder a remembered one-note task just became, which the device's copy may not show yet. */
function became(item: FolderItem, path: string): boolean {
  return item.kind === "note" && item.path !== path && item.path.replace(/\.md$/i, "") === path;
}

function isDone(item: FolderItem, notes: readonly ListNote[]): boolean {
  return groupOfStatus(item.status, folderStatuses(governingFolder(item.target), notes).list) === "done";
}

function subtaskHead(subtasks: readonly FolderItem[], notes: readonly ListNote[]): string {
  if (subtasks.length === 0) return "Subtasks";
  const done = subtasks.filter((sub) => isDone(sub, notes)).length;
  return `Subtasks · ${done} of ${subtasks.length} done`;
}

/** A subtask starts at the first To do of the list inside its task (`to do` by default), never Backlog. */
function newSubtask(task: QuickAddTask, parent: TaskRef, notes: readonly ListNote[]) {
  const inside = parent.kind === "folder" ? parent.path : parent.path.replace(/\.md$/i, "");
  return { ...task, status: makeItTaskStatus(folderStatuses(inside, notes).list) };
}

function Subtask({
  item,
  notes,
  actions,
  chooseMany,
  onShow,
}: {
  item: FolderItem;
  notes: readonly ListNote[];
  actions: ItemActions;
  chooseMany: TaskPanelProps["chooseMany"];
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

function Add({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
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
    panel: {
      width: PANEL_WIDTH,
      flexShrink: 0,
      alignSelf: "flex-start",
      gap: space.x5,
      paddingVertical: space.x6,
      paddingHorizontal: space.x6,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    crumb: { flexDirection: "row", alignItems: "center", gap: space.x2, minWidth: 0 },
    section: { gap: 2 },
    head: { color: colors.muted, fontWeight: "600", paddingBottom: space.x1 },
    line: { flexDirection: "row", alignItems: "center", gap: space.x3, minHeight: 32, borderRadius: radii.sm },
    push: { flexGrow: 1 },
    shrink: { flexShrink: 1, minWidth: 0 },
    muted: { color: colors.chromeMuted },
    link: { color: colors.chromeMuted, textDecorationLine: "underline" },
    text: { color: colors.text },
    text2: { color: colors.text2 },
    finished: { color: colors.chromeMuted, textDecorationLine: "line-through" },
    add: { alignSelf: "flex-start", paddingVertical: space.x2, paddingRight: space.x2 },
  });
