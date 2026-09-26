/**
 * Every change to a folder's status list, and the notes a change rewrites.
 *
 * The list is written where it lives — the front note that declared it, or,
 * while a folder only has the defaults, this folder's own front note (made
 * as `overview.md` when there is none). The workspace root has no front note
 * of its own, so a root page with nothing declared cannot change its list.
 *
 * Renaming, deleting and merging a status also change the notes that use
 * it, since otherwise the notes disagree with the board. Those are ordinary
 * one-line property writes, one note at a time, over every note under the
 * list's folder that the list describes (`notesUsing`) — read fresh from the
 * device at the moment of the change rather than from what the page drew, so
 * a note in a subfolder the page never loaded is not missed. Each asks first,
 * with the count (`plan` → a confirm → `apply`).
 */

import { useCallback, useMemo } from "react";
import type { ListNote } from "../listBlock/model";
import type { FolderNotes } from "./useFolderPage";
import {
  notesUsing,
  placeStatus,
  removeStatus,
  renameStatus,
  replacementFor,
  statusListIssue,
  statusListWrite,
  type FolderStatuses,
  type StatusGroup,
  type StatusList,
} from "./statuses";

/** A change that rewrites notes, described before it runs. */
export interface StatusPlan {
  /** The list to write first, or null when only notes change (a merge). */
  readonly list: StatusList | null;
  /** The notes whose status changes. */
  readonly paths: readonly string[];
  /** Their new status; null clears it. */
  readonly to: string | null;
}

export interface StatusEdits {
  /** Null when the list cannot be changed here: not an owner or editor, or the root with nothing declared. */
  readonly savesTo: string | null;
  /** Write a new list as it is: add, move, reorder. Resolves to the problem, or null. */
  save(next: StatusList): Promise<string | null>;
  /** Put a word in use into a group. */
  place(word: string, group: StatusGroup): Promise<string | null>;
  planRename(from: string, to: string): Promise<StatusPlan | string>;
  planRemove(word: string): Promise<StatusPlan | string>;
  planMerge(word: string, into: string): Promise<StatusPlan | string>;
  apply(plan: StatusPlan): Promise<string | null>;
}

export function useStatusEdits(
  loaded: FolderNotes,
  folder: string,
  statuses: FolderStatuses,
  front: { target: string; creates: boolean } | null,
): StatusEdits {
  const { list, from, note } = statuses;
  const within = from ?? folder;
  const frontTarget = front?.target ?? null;
  const frontCreates = front?.creates ?? false;
  const target = useMemo(
    () =>
      !loaded.canEdit
        ? null
        : note !== null
          ? { target: note, creates: false }
          : folder === "" || frontTarget === null
            ? null
            : { target: frontTarget, creates: frontCreates },
    [loaded.canEdit, note, folder, frontTarget, frontCreates],
  );
  const { chooseMany, choose, loadAll } = loaded;

  const save = useCallback(
    async (next: StatusList): Promise<string | null> => {
      if (target === null) return "This folder’s statuses can’t be changed here.";
      const issue = statusListIssue(next);
      if (issue !== null) return issue;
      return chooseMany(target.target, statusListWrite(next), target.creates);
    },
    [target, chooseMany],
  );

  const using = useCallback(
    async (word: string): Promise<string[] | string> => {
      const notes: readonly ListNote[] | null = await loadAll(within);
      if (notes === null) return "The notes that use it could not be read on this device.";
      return notesUsing(word, from, within, notes);
    },
    [loadAll, within, from],
  );

  const planRename = useCallback(
    async (old: string, to: string): Promise<StatusPlan | string> => {
      const name = to.trim();
      if (name === "") return "A status needs a name.";
      const next = renameStatus(list, old, name);
      const issue = statusListIssue(next);
      if (issue !== null) return issue;
      const paths = await using(old);
      return typeof paths === "string" ? paths : { list: next, paths, to: name };
    },
    [list, using],
  );

  const planRemove = useCallback(
    async (word: string): Promise<StatusPlan | string> => {
      const next = removeStatus(list, word);
      const issue = statusListIssue(next);
      if (issue !== null) return issue;
      const paths = await using(word);
      return typeof paths === "string" ? paths : { list: next, paths, to: replacementFor(list, word) };
    },
    [list, using],
  );

  const planMerge = useCallback(
    async (word: string, into: string): Promise<StatusPlan | string> => {
      const paths = await using(word);
      return typeof paths === "string" ? paths : { list: null, paths, to: into };
    },
    [using],
  );

  const apply = useCallback(
    async (plan: StatusPlan): Promise<string | null> => {
      if (plan.list !== null) {
        const problem = await save(plan.list);
        if (problem !== null) return problem;
      }
      let failed = 0;
      for (const path of plan.paths) {
        // One at a time: each is its own read and write, merged into anybody typing in that note.
        if ((await choose(path, "status", plan.to, false)) !== null) failed += 1;
      }
      if (failed === 0) return null;
      return failed === 1 ? "One note could not be changed; its status is as it was." : `${failed} notes could not be changed; their status is as it was.`;
    },
    [save, choose],
  );

  const place = useCallback((word: string, group: StatusGroup) => save(placeStatus(list, word, group)), [save, list]);

  return {
    savesTo: target === null ? null : target.target,
    save,
    place,
    planRename,
    planRemove,
    planMerge,
    apply,
  };
}
