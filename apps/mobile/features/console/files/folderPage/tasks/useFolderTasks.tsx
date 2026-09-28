/**
 * A folder page's task controls, and what it draws for them: the primary
 * "+ Add task" at the right of the Show bar, the right-click menu, and the
 * selection bar. Kept out of `FolderPage.tsx` so the page stays a reading of
 * its notes with this laid over it for somebody who may write.
 */

import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";
import { Button } from "../../../../design/components/Button";
import type { ListNote } from "../../listBlock/model";
import { baseName, folderLabel } from "../../paths";
import type { OwnerChoice } from "../items";
import { makeItTaskStatus } from "../listLayout";
import { entriesIn, rowsAreProjects, summarizeFolder, type FolderItem } from "../model";
import { folderStatuses, governingFolder, statusMenu, type StatusList } from "../statuses";
import type { FolderNotes } from "../useFolderPage";
import { ownersPlan } from "./menuRun";
import { planSet, statusPlan, type ProjectRef } from "./taskEdits";
import type { TaskHost } from "./taskHost";
import { SelectionBar } from "./SelectionBar";
import { TaskMenu } from "./TaskMenu";
import type { PendingRecord } from "./usePendingNotes";
import { useTaskActions, type TaskControls } from "./useTaskActions";

export interface FolderTasks {
  readonly controls: TaskControls | null;
  /** The primary "+ Add task", for the Show bar's right; null for who may not write. */
  readonly addButton: ReactNode;
  /** The menu and the selection bar. */
  readonly overlays: ReactNode;
  /** A value chosen on a row, with an Undo; null for who may not write. */
  readonly choose: ((item: FolderItem, key: string, value: string | null) => void) | null;
  /** "Make it a task", with an Undo. */
  readonly makeTask: ((item: FolderItem) => void) | null;
}

export function useFolderTasks({
  host,
  loaded,
  folder,
  notes,
  rows,
  items,
  list,
  record,
  owners,
  label,
  me,
  onOpen,
  makeTaskLabel,
}: {
  host: TaskHost | undefined;
  loaded: FolderNotes;
  folder: string;
  notes: readonly ListNote[];
  rows: readonly { readonly path: string }[];
  items: readonly FolderItem[];
  list: StatusList;
  record: PendingRecord;
  owners: OwnerChoice;
  label: (value: string) => string;
  /** The viewer's own words (`FolderPageHost.me`). */
  me: readonly string[] | undefined;
  onOpen: (item: FolderItem) => void;
  makeTaskLabel: string;
}): FolderTasks {
  const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
  const projectsHere = rowsAreProjects(folder);
  const controls = useTaskActions({
    host,
    loaded,
    folder,
    notes,
    rows,
    items,
    list,
    record,
    owners,
    projectsHere,
    onRemember: host?.remember,
  });
  // The projects beside this one, when this page is a project in the projects folder.
  const projects = useMemo<ProjectRef[]>(() => {
    if (projectsHere || folder === "" || !rowsAreProjects(parent)) return [];
    return entriesIn(parent, notes)
      .filter((entry) => entry.kind === "folder" && entry.path !== folder)
      .map((entry) => ({ path: entry.path, label: summarizeFolder(entry.path, notes).title ?? folderLabel(baseName(entry.path)) }));
  }, [projectsHere, folder, parent, notes]);
  // "Assign to me" writes the viewer's handle, never a display name somebody else might share.
  const myOwner = useMemo(() => (me ?? []).map(label).find((word) => word.startsWith("@")) ?? null, [me, label]);
  const statusSections = useMemo(() => statusMenu(list), [list]);

  const makeTask = useCallback(
    (item: FolderItem) => {
      if (controls === null) return;
      const status = makeItTaskStatus(folderStatuses(governingFolder(item.target), notes).list);
      void controls.perform(statusPlan(item, status));
    },
    [controls, notes],
  );
  const choose = useCallback(
    (item: FolderItem, key: string, value: string | null) => {
      if (controls === null) return;
      if (key === "status" && value !== null) return void controls.perform(statusPlan(item, value));
      if (key === "owner") return void controls.perform(ownersPlan(item, value === null ? [] : [value], owners));
      void controls.perform(planSet(item, [[key, value]], `Changed “${item.label}”.`, `Nothing changed on “${item.label}”.`));
    },
    [controls, owners],
  );

  if (controls === null || host === undefined) return { controls: null, addButton: null, overlays: null, choose: null, makeTask: null };
  return {
    controls,
    addButton: (
      <Button
        label={controls.addLabel}
        variant="dialogPrimary"
        onPress={() => controls.openComposer({ kind: "task", section: "not-started", status: controls.firstToDo, at: "top" })}
        testID="folder-add-task-primary"
      />
    ),
    overlays: (
      <>
        <TaskMenu
          controls={controls}
          host={host}
          items={items}
          statusSections={statusSections}
          projects={projects}
          me={myOwner}
          owners={owners}
          makeTaskLabel={makeTaskLabel}
          onOpen={onOpen}
          onMakeTask={makeTask}
        />
        <SelectionBar controls={controls} host={host} statusSections={statusSections} owners={owners} />
      </>
    ),
    choose,
    makeTask,
  };
}
