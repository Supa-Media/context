/**
 * One row of the page, open beside its List or Board — Notion's side peek:
 * where it is, then Expand, Open in new tab and ✕ (`PanelHead.tsx`), its
 * name, and then —
 *
 * - for a **task** (anything with a status: a task, a subtask, a project on
 *   the projects folder's page): its values (`PanelProperties.tsx`), its
 *   subtasks with dots that tick them off, the notes in it, "+ Add subtask"
 *   and "+ Add a note";
 * - for a **plain note**: nothing else; for a plain folder, what is in it;
 * - and for either, the note's words (`PanelBody.tsx`) — a folder's are its
 *   front note's.
 *
 * - A **subtask's dot** flips it between the list's first Done word and its
 *   first Not started word that is not Backlog (`tickStatus`). Two levels of
 *   task and no deeper: a subtask has no Subtasks section.
 * - **Adding** a subtask or a note is planned first (`planAddSubtask`,
 *   `planAddNote`) and run through the console's own writes; a one-note task
 *   becomes a folder on the first, and the panel follows it there.
 * - A **name** — a subtask, a note in the task — opens it here, in this
 *   one's place; the crumb goes back up.
 *
 * Nothing is read but the device's notes at the reader's clearance, and a
 * member is shown the same row with nothing to press that would write.
 */

import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { space } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import { useConsoleNav } from "../../../ConsoleNavContext";
import type { FolderListSource, ListNote } from "../../listBlock/model";
import type { ItemActions } from "../items";
import { makeItTaskStatus } from "../listLayout";
import type { FolderItem } from "../model";
import { folderStatuses } from "../statuses";
import { QuickAddComposer, type QuickAddTask } from "../tasks/QuickAddComposer";
import { planAddNote, planAddSubtask, type Planned, type TaskRef } from "../tasks/taskWrites";
import type { TaskControls } from "../tasks/useTaskActions";
import { tagsInUse } from "../tasks/taskWords";
import type { PropertyChanges } from "../useFolderPage";
import { PanelBody } from "./PanelBody";
import { PanelHead } from "./PanelHead";
import { PanelProperties } from "./PanelProperties";
import { Add, NoteLine, Subtask, subtaskHead } from "./PanelRows";
import { bodyPath, panelEntry, taskRefOf, type PanelEntry } from "./panelModel";
import { useFoldTree } from "./useFoldTree";

export interface TaskPanelProps {
  /** The row shown: a task, a subtask, a plain note, a project. */
  path: string;
  /** The project's folder. */
  folder: string;
  notes: readonly ListNote[];
  /** What the project is called, for where the task is. */
  projectTitle: string;
  actions: ItemActions;
  /** Several properties of one note, as the page writes them (`FolderNotes.chooseMany`); null for a member. */
  chooseMany: ((target: string, changes: PropertyChanges, creates: boolean) => Promise<string | null>) | null;
  /**
   * The List's own write road (`TaskControls.perform`): drawn at once, read
   * again, put into this device's copy and said with an Undo. Null where the
   * page cannot write, and nothing is offered that needs it.
   */
  perform: TaskControls["perform"] | null;
  /** Every path the page's listing shows, so a new name misses them too. */
  paths: readonly string[];
  now: number;
  /** Where the words are read from (`FolderListSource.readBody`). */
  source: FolderListSource | undefined;
  /** The width the panel's contents are drawn at (`PanelBeside`). */
  width: number;
  /** Show another row here. */
  onShow: (path: string) => void;
  /** Leave for a note's or a folder's own page. */
  onNavigate: (path: string) => void;
  onClose: () => void;
}

export function TaskPanel(props: TaskPanelProps) {
  const { path, folder, notes, actions, chooseMany, perform, now, onShow, onNavigate, onClose } = props;
  const styles = useThemedStyles(makeStyles);
  const nav = useConsoleNav();
  // Notion's side peek: the file tree gives the panel its width while it is on screen.
  useFoldTree();
  // What was last shown stays while the device's copy catches up with a move (a task that just became a folder).
  const last = useRef<PanelEntry | null>(null);
  // A one-note task that just became a folder is drawn as that folder at once (the List's pending
  // overlay), before the panel is told to follow it there: it is the same task, not one that went.
  const found = panelEntry(path, folder, notes) ?? (/\.md$/i.test(path) ? panelEntry(path.replace(/\.md$/i, ""), folder, notes) : null);
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
    if (perform === null) return "This can’t be changed from here.";
    return perform(planned, {
      quiet: true,
      // A one-note task is a folder now; the panel follows it there.
      after: () => {
        if (ref.kind === "note") onShow(ref.path.replace(/\.md$/i, ""));
      },
    });
  };
  const snapshot = { folder, notes, paths: props.paths };
  const canAdd = write !== null && perform !== null;
  const isTask = item.status !== "";
  // A tab holds a note: a folder opens its front note, and one with none is not offered a tab.
  const words = bodyPath(ref);
  const onNewTab = nav === null || words === null ? null : () => nav.follow(words, "background");
  // A plain folder lists what is in it, to open here; a task's are its subtasks and its notes.
  const inside = isTask ? entry.notes : [...(entry.subtasks ?? []), ...entry.notes];
  return (
    <View style={styles.panel} role="complementary" aria-label={isTask ? "Task details" : "Note"} testID="task-panel">
      <PanelHead
        where={props.projectTitle}
        parent={parent}
        onShow={onShow}
        onExpand={() => onNavigate(ref.path)}
        onNewTab={onNewTab}
        onClose={onClose}
      />
      <Text variant="paneTitle" testID="task-panel-title">
        {item.label}
      </Text>
      {isTask ? (
        <PanelProperties
          item={item}
          target={item.creates ? null : ref.target}
          actions={actions}
          write={write}
          tagSuggestions={tagsInUse(notes, folder)}
          now={now}
        />
      ) : null}
      {!isTask || entry.subtasks === null ? null : (
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
      {inside.length === 0 && !(isTask && canAdd) ? null : (
        <View style={styles.section}>
          <Text variant="tree" style={styles.head} testID="task-panel-notes-head">
            {`${isTask ? "Notes" : "In this folder"} · ${inside.length}`}
          </Text>
          {inside.map((each) => (
            <NoteLine key={each.path} item={each} onShow={onShow} />
          ))}
          {isTask && canAdd ? (
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
      <View style={isTask ? styles.words : undefined}>
        <PanelBody
          source={props.source}
          path={words}
          title={item.label}
          width={props.width}
          onOpenNote={(to, mode) => (mode === "background" && nav !== null ? nav.follow(to, "background") : onNavigate(to))}
        />
      </View>
    </View>
  );
}

/** `path` is the folder a remembered one-note task just became, which the device's copy may not show yet. */
function became(item: FolderItem, path: string): boolean {
  return item.kind === "note" && item.path !== path && item.path.replace(/\.md$/i, "") === path;
}

/** A subtask starts at the first To do of the list inside its task (`to do` by default), never Backlog. */
function newSubtask(task: QuickAddTask, parent: TaskRef, notes: readonly ListNote[]) {
  const inside = parent.kind === "folder" ? parent.path : parent.path.replace(/\.md$/i, "");
  return { ...task, status: makeItTaskStatus(folderStatuses(inside, notes).list) };
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // The frame, the width and the scrolling are the peek's (`PanelBeside`).
    panel: { gap: space.x5 },
    section: { gap: 2 },
    head: { color: colors.muted, fontWeight: "600", paddingBottom: space.x1 },
    // Under a task's values and lists, the words start below a rule.
    words: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.x5 },
  });
