/**
 * Live file rows that share one noteId, and how they are repaired (staff:
 * `noteIds.sharedIdReport`, `noteIds.repairSharedIds`).
 *
 * Two live rows with one id share one key (`notes/<id>.md` names no path), so
 * one of them would read the other's body once the keys are read. The rule:
 * the id stays on ONE row, the one whose copy is fresh under that id's key, and
 * otherwise the oldest row. Every other row gets a new id and loses its copy
 * record, so the next copy pass copies its own bytes to its own key.
 *
 * In a keyed workspace the rows' bytes live only at their keys. A row that
 * would be re-id'd while its `storageKey` is the shared key cannot be given a
 * new key safely (the bytes may be the other row's), so the whole group is
 * reported `needsLook` and left as it is.
 *
 * Groups are read in pages of rows in `noteId` order. A page never ends inside
 * a group, so a group is always read whole.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../../_generated/server";
import { copyIsFresh, idKeyFor } from "../nodes/noteIds";
import { isPlumbing } from "../privacy";

export type NodeDoc = Doc<"nodes">;

/** Rows read per page of the scan (a page ends at a group boundary once this is reached). */
export const SHARED_PAGE = 500;

export type CopyState = "keyed" | "fresh" | "stale" | "none";

/** A live file row: the rows the id rule applies to. */
export function isLiveFile(row: NodeDoc): boolean {
  return row.kind === "file" && row.goneAt === undefined && !isPlumbing(row.path);
}

/** The row's copy, as the report says it: keyed (its bytes live at the key), fresh, stale, or none. */
export function copyStateOf(noteId: string, row: NodeDoc): CopyState {
  if (row.storageKey !== undefined) return "keyed";
  if (copyIsFresh(row)) return "fresh";
  if (row.idCopy !== undefined) return "stale";
  return "none";
}

export interface SharedGroup {
  noteId: string;
  /** The group's live file rows, oldest first. */
  rows: NodeDoc[];
}

/**
 * The groups of live file rows sharing a noteId, from `after` in noteId order,
 * for one page. `next` is where the following page starts, `undefined` at the
 * end. Groups with one live row are not groups.
 */
export async function sharedGroupsPage(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  after: string | undefined,
): Promise<{ groups: SharedGroup[]; next?: string }> {
  const rows = db.query("nodes").withIndex("by_workspace_noteId", (q) =>
    after === undefined ? q.eq("workspaceId", workspaceId) : q.eq("workspaceId", workspaceId).gt("noteId", after),
  );
  const runs: { noteId: string; rows: NodeDoc[] }[] = [];
  let read = 0;
  let current: string | null = null;
  let done = true;
  for await (const row of rows) {
    // Past the budget, a page stops only where the next group starts: no group is ever cut in two.
    if (read >= SHARED_PAGE && row.noteId !== current) {
      done = false;
      break;
    }
    read += 1;
    if (row.noteId === undefined) continue;
    if (row.noteId !== current) {
      runs.push({ noteId: row.noteId, rows: [] });
      current = row.noteId;
    }
    runs[runs.length - 1]!.rows.push(row);
  }
  const groups = runs
    .map((run) => ({ noteId: run.noteId, rows: run.rows.filter(isLiveFile) }))
    .filter((group) => group.rows.length >= 2);
  if (done) return { groups };
  // Rows with no id yet sort first: a page of only those restarts from the first string id.
  return { groups, next: runs.length > 0 ? runs[runs.length - 1]!.noteId : "" };
}

function oldest(rows: readonly NodeDoc[]): NodeDoc {
  return [...rows].sort((a, b) => a._creationTime - b._creationTime || (a._id < b._id ? -1 : 1))[0]!;
}

/** Whether the row's copy record (or its keyed bytes) is for the id key of this row's path. */
function onKey(noteId: string, row: NodeDoc): boolean {
  const key = idKeyFor(noteId, row.path);
  return row.idCopy?.key === key || row.storageKey === key;
}

/** The row that keeps the id: a fresh copy under the id's key, else the oldest row. */
export function keeperOf(noteId: string, rows: readonly NodeDoc[]): NodeDoc {
  const onFreshKey = rows.filter((row) => copyIsFresh(row) && onKey(noteId, row));
  return oldest(onFreshKey.length > 0 ? onFreshKey : rows);
}

/** The plan for one group: who keeps the id, who gets a new one, and whether a person must look first. */
export function planGroup(group: SharedGroup): { keeper: NodeDoc; repairs: NodeDoc[]; needsLook: boolean } {
  const keeper = keeperOf(group.noteId, group.rows);
  const repairs = group.rows.filter((row) => row._id !== keeper._id);
  const needsLook = repairs.some((row) => row.storageKey === idKeyFor(group.noteId, row.path));
  return { keeper, repairs, needsLook };
}

/**
 * Carry a re-id'd row's id change into the access snapshot (`nodeAccessState.snapshot`,
 * a copy of each row's id the derivation keeps). Grants are keyed by the row, so only
 * the snapshot names the id.
 */
export async function renameSnapshotId(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  path: string,
  from: string,
  to: string,
): Promise<void> {
  const state = await ctx.db
    .query("nodeAccessState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (state === null || state.snapshot === undefined) return;
  const snapshot = state.snapshot.map((entry) => (entry.path === path && entry.noteId === from ? { ...entry, noteId: to } : entry));
  if (snapshot.some((entry, index) => entry !== state.snapshot![index])) await ctx.db.patch(state._id, { snapshot });
}
