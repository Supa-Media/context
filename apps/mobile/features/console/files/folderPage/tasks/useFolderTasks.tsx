/**
 * A folder page's task controls, and what it draws for them: the primary
 * "+ Add task" at the right of the Show bar — on a phone, the "Add a task"
 * bar at the bottom of the page instead — the right-click menu (a sheet on a
 * phone, `tasks/PhoneParts.tsx`), and the selection bar. Kept out of `FolderPage.tsx` so the page stays a reading of
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
import { estimatePlan, ownersPlan, priorityPlan } from "./menuRun";
import { ESTIMATES, type Estimate } from "../taskProps";
import { PRIORITIES, type Priority } from "./taskWords";
import { planSet, statusPlan, type ProjectRef } from "./taskEdits";
import type { TaskHost } from "./taskHost";
import { groupLabel } from "../../listBlock/words";
import { PhoneAddBar } from "./PhoneParts";
import { SelectionBar } from "./SelectionBar";
import { TaskMenu } from "./TaskMenu";
import { useTaskMenu, type TaskMenuModel } from "./useTaskMenu";
import type { PendingRecord } from "./usePendingNotes";
import { useTaskActions, type TaskControls } from "./useTaskActions";

/** "+ Add task" at the filter bar's 28pt height, so it reads as one of its controls. */
const ADD_BUTTON = { height: 28, paddingVertical: 0, justifyContent: "center" } as const;

export interface FolderTasks {
  readonly controls: TaskControls | null;
  /** The primary "+ Add task", for the Show bar's right; null for who may not write. */
  readonly addButton: ReactNode;
  /** On a phone, "Add a task" pinned at the bottom of the page; null elsewhere and for who may not write. */
  readonly phoneBar: ReactNode;
  /** A row's menu — offered, and run — for the ⋯, the hold and the swipe; null for who may not write. */
  readonly menu: TaskMenuModel | null;
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
  compact = false,
  backlogFolder = null,
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
  /** A phone's layout: the add button moves to the bottom of the page. */
  compact?: boolean;
  /** The page's Backlog folder, where parking moves a row (`backlogFolder.ts`). */
  backlogFolder?: string | null;
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
    backlogFolder,
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
      // The row's priority mark: said in the owner's words ("… is Urgent now"), with an Undo.
      if (key === "priority" && (value === null || (PRIORITIES as readonly string[]).includes(value))) {
        return void controls.perform(priorityPlan(item, value as Priority | null));
      }
      if (key === "estimate" && (value === null || (ESTIMATES as readonly string[]).includes(value))) {
        return void controls.perform(estimatePlan(item, value as Estimate | null));
      }
      void controls.perform(planSet(item, [[key, value]], `Changed “${item.label}”.`, `Nothing changed on “${item.label}”.`));
    },
    [controls, owners],
  );

  const menu = useTaskMenu({ controls, host, items, statusSections, projects, me: myOwner, owners, makeTaskLabel, onOpen, onMakeTask: makeTask });

  if (controls === null || host === undefined) return { controls: null, addButton: null, phoneBar: null, menu: null, overlays: null, choose: null, makeTask: null };
  return {
    controls,
    menu,
    phoneBar: compact ? (
      <PhoneAddBar controls={controls} label={projectsHere ? "Add a project" : "Add a task"} groupLabel={groupLabel("status", controls.firstToDo)} />
    ) : null,
    addButton: compact ? null : (
      <Button
        label={controls.addLabel}
        variant="mini"
        onPress={() => controls.openComposer({ kind: "task", section: "not-started", status: controls.firstToDo, at: "top" })}
        style={ADD_BUTTON}
        testID="folder-add-task-primary"
      />
    ),
    overlays: (
      <>
        <TaskMenu controls={controls} model={menu} owners={owners} />
        <SelectionBar controls={controls} host={host} statusSections={statusSections} owners={owners} />
      </>
    ),
    choose,
    makeTask,
  };
}
