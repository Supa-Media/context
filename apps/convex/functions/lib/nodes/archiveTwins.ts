/**
 * Archive keeps the workspace's shape (owner, 2026-10-18; `archiveMirror.cjs`,
 * `docs/decisions/app-and-console/folder-jobs.md`): each built-in folder has a
 * twin at `<archive>/<its path>`, marked `archiveOf` on the twin's row, and
 * the twin follows the built-in folder's renames and moves.
 *
 * The rows' side of it, read and written in the caller's transaction:
 *
 *  - `archiveMoveRefusal`: Archive stays at the top level (it can be renamed),
 *    and a built-in folder, or a folder holding one, never goes into Archive:
 *    it is a place, not a thing that is done.
 *  - `markArchiveTwins`: after something lands in Archive, the folders on its
 *    way that mirror a built-in folder are marked.
 *  - `twinsToFollow`: the twins a move of `from` must carry with it, outermost
 *    first, for `rowMoveStart.ts` to move once the move itself has landed.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../../_generated/server";
import { type FolderJobs, type RowRole } from "@context/shared/src/folderRoles.cjs";
import { twinsAlong } from "@context/shared/src/archiveMirror.cjs";
import { folderJobsOf, jobOfRow } from "./folderJobs";

export type ArchiveRefusal = "archive_stays" | "built_in_archived";

function under(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** The built-in folders at or under `path`, the Archive aside, from `folderJobs`'s answer. */
function jobsUnder(jobs: FolderJobs, path: string): { role: RowRole; path: string }[] {
  const found: { role: RowRole; path: string }[] = [];
  for (const [role, home] of Object.entries(jobs.jobs) as [RowRole, string | null][]) {
    if (role === "archive" || home === null) continue;
    if (under(home, path)) found.push({ role, path: home });
  }
  return found.sort((a, b) => a.path.length - b.path.length);
}

/**
 * Why moving `root` to `to` is refused for the Archive's sake, or null. Read
 * before the move writes anything (`applyRowMove`).
 */
export async function archiveMoveRefusal(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  root: Doc<"nodes">,
  to: string,
): Promise<ArchiveRefusal | null> {
  if (root.kind !== "folder") return null;
  const job = await jobOfRow(db, workspaceId, root);
  if (job === "archive") return to.includes("/") ? "archive_stays" : null;
  const jobs = await folderJobsOf(db, workspaceId);
  const archive = jobs.jobs.archive;
  if (archive === null || !under(to, archive)) return null;
  return jobsUnder(jobs, root.path).length > 0 ? "built_in_archived" : null;
}

/**
 * Mark each folder on the way to `path` (inside Archive) that mirrors a
 * built-in folder, outermost first. A folder already marked keeps its mark;
 * one marked for another job is left alone, never re-pointed.
 */
export async function markArchiveTwins(ctx: MutationCtx, workspaceId: Id<"workspaces">, path: string): Promise<string[]> {
  const jobs = await folderJobsOf(ctx.db, workspaceId);
  const marked: string[] = [];
  for (const twin of twinsAlong(jobs, jobs.jobs.archive, path)) {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", twin.path))
      .unique();
    if (row === null || row.goneAt !== undefined || row.kind !== "folder" || row.archiveOf !== undefined) continue;
    await ctx.db.patch(row._id, { archiveOf: twin.role });
    marked.push(twin.path);
  }
  return marked;
}

/**
 * The twins a move of `from` to `to` carries: for each built-in folder at or
 * under `from`, its twin `<archive>/<old path>` going to `<archive>/<new
 * path>`, when a live folder stands there. A twin inside another moved twin
 * goes with it and is not listed. Nothing for a move into or out of Archive,
 * or of anything in it.
 */
export async function twinsToFollow(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  from: string,
  to: string,
): Promise<{ from: string; to: string; role: RowRole }[]> {
  const jobs = await folderJobsOf(db, workspaceId);
  const archive = jobs.jobs.archive;
  if (archive === null || under(from, archive) || under(to, archive)) return [];
  // Read before the move lands, so `jobs` still names the old paths.
  const follow: { from: string; to: string; role: RowRole }[] = [];
  for (const job of jobsUnder(jobs, from)) {
    const twinFrom = `${archive}/${job.path}`;
    if (follow.some((outer) => under(twinFrom, outer.from))) continue;
    const row = await db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", twinFrom))
      .unique();
    if (row === null || row.goneAt !== undefined || row.kind !== "folder") continue;
    follow.push({ from: twinFrom, to: `${archive}/${to}${job.path.slice(from.length)}`, role: job.role });
  }
  return follow;
}
