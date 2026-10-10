/**
 * A folder page's task controls: the writes behind the Board's status menus,
 * drags and the side panel's values, each undoable from its toast. Kept out of
 * `FolderPage.tsx` so the page stays a reading of its notes with this laid over
 * it for somebody who may write. The List draws no controls (the owner,
 * 2026-10-10, board 11), so nothing here draws anything.
 */

import { useCallback } from "react";
import type { ListNote } from "../../listBlock/model";
import type { OwnerChoice } from "../items";
import { makeItTaskStatus } from "../taskBasics";
import { rowsAreProjects, type FolderItem } from "../model";
import { folderStatuses, governingFolder, type StatusList } from "../statuses";
import type { FolderNotes } from "../useFolderPage";
import { estimatePlan, ownersPlan, priorityPlan } from "./menuRun";
import { ESTIMATES, type Estimate } from "../taskProps";
import { PRIORITIES, type Priority } from "./taskWords";
import { planSet, statusPlan } from "./taskEdits";
import type { TaskHost } from "./taskHost";
import type { PendingRecord } from "./usePendingNotes";
import { useTaskActions, type TaskControls } from "./useTaskActions";

export interface FolderTasks {
  readonly controls: TaskControls | null;
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
  /** The page's Backlog folder, where parking moves a row (`backlogFolder.ts`). */
  backlogFolder?: string | null;
}): FolderTasks {
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

  if (controls === null || host === undefined) return { controls: null, choose: null, makeTask: null };
  return { controls, choose, makeTask };
}
