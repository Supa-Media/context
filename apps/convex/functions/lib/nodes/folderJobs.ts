/**
 * Built-in folders found by their job, whatever they are called (decided by
 * the owner, 2026-10-18; `docs/decisions/app-and-console/folder-jobs.md`).
 *
 * A folder row's `role` holds its job under the job's original name
 * (`inbox`, `projects`, ... `website`, `meetings`). It is written in three
 * places, and never cleared:
 *
 *  - **when the row is made** at the root under a job's name (`0-inbox`,
 *    `Projects`, `website`) and no row does that job yet (`roleForNewFolder`);
 *  - **before the folder's first move** (`claimJobBeforeMove`), for the rows
 *    made before this field existed: the name still says the job then, and
 *    after the rename it would not;
 *  - for the meetings folder, when the row sits where the workspace's meetings
 *    setting points.
 *
 * Everything else reads `folderJobsOf`: a row's own `role` wherever it now
 * is, else the root folder named for a job no row claims (`folderJobs` in
 * `folderRoles.cjs`). `canonicalJobPath` carries a path written under a job's
 * default name (`0-inbox/memories/a.md`) to the folder doing that job now, so
 * every writer that names a built-in folder keeps landing in it after a rename.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../../_generated/server";
import {
  type FolderJobs,
  type RowRole,
  NO_JOB,
  ROW_ROLES,
  folderJobs,
  isRowRole,
  jobAt,
  jobOfName,
  jobPath,
} from "@context/shared/src/folderRoles.cjs";
import { MEETINGS_FOLDER } from "../../../../../packages/meetings/src/paths.js";
import { TRASH_ROOT } from "../fileOps/store";

function lastSegment(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

/** Root rows read to decide a name's job: far past any real root, a bound on a loop. */
const ROOT_ROWS = 2_000;

/**
 * A row under the trash is no longer doing its job: a trashed Tex folder is
 * nobody's Tex folder, so its routines stop (`routinesTexRoot.test.ts`). The
 * role stays on the row, so a Restore brings the job back with the folder.
 */
function inTrash(row: Doc<"nodes">): boolean {
  return row.path === TRASH_ROOT || row.path.startsWith(`${TRASH_ROOT}/`);
}

/** The live rows at the workspace root. */
async function liveRootFolders(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<Doc<"nodes">[]> {
  const rows = await db
    .query("nodes")
    .withIndex("by_parent_name", (q) => q.eq("workspaceId", workspaceId).eq("parentId", undefined))
    .take(ROOT_ROWS);
  return rows.filter((row) => row.kind === "folder" && row.goneAt === undefined && !inTrash(row));
}

/** Rows read past for one job's live folders: gone and trashed ones, before a bound on the loop ends it. */
const JOB_ROWS_SCANNED = 200;

/**
 * Up to `limit` live folders outside the trash that carry `role`. A row keeps
 * its job when it is tombstoned or trashed, and the index lists the oldest
 * first, so taking a few and then filtering would miss the live folder of a
 * job whose earlier rows went (a folder moved the old way, or trashed and
 * made again) and the website would read as nowhere.
 */
export async function liveRowsDoing(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  role: RowRole,
  limit: number,
): Promise<Doc<"nodes">[]> {
  const rows: Doc<"nodes">[] = [];
  let scanned = 0;
  for await (const row of db.query("nodes").withIndex("by_workspace_role", (q) => q.eq("workspaceId", workspaceId).eq("role", role))) {
    if (row.kind === "folder" && row.goneAt === undefined && !inTrash(row)) rows.push(row);
    scanned += 1;
    if (rows.length >= limit || scanned >= JOB_ROWS_SCANNED) break;
  }
  return rows;
}

/** The live rows that carry a job, wherever they are. */
async function liveJobRows(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<Doc<"nodes">[]> {
  const rows: Doc<"nodes">[] = [];
  for (const role of ROW_ROLES) rows.push(...(await liveRowsDoing(db, workspaceId, role, 4)));
  return rows;
}

/** Which folder does each job in this workspace (`folderJobs`). Unfiltered: callers judge who may see a path. */
export async function folderJobsOf(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<FolderJobs> {
  return (await folderJobsAndClaims(db, workspaceId)).answer;
}

/** A job written on a row, at the row's path. */
export interface JobClaim {
  path: string;
  role: RowRole;
}

/** `folderJobsOf`, and the rows whose job is written on them (`claimed`), which no name decides. */
export async function folderJobsAndClaims(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
): Promise<{ answer: FolderJobs; claimed: JobClaim[] }> {
  const [roots, jobRows] = await Promise.all([liveRootFolders(db, workspaceId), liveJobRows(db, workspaceId)]);
  const byId = new Map<string, Doc<"nodes">>();
  for (const row of [...roots, ...jobRows]) byId.set(row._id, row);
  const rows = [...byId.values()];
  const answer = folderJobs(
    rows.map((row) => ({
      path: row.path,
      name: row.name,
      top: row.parentId === undefined,
      ...(isRowRole(row.role) || row.role === NO_JOB ? { role: row.role } : {}),
    })),
  );
  const claimed = rows.flatMap((row) => (isRowRole(row.role) ? [{ path: row.path, role: row.role }] : []));
  return { answer, claimed };
}

/**
 * `path` carried to the folder doing its first segment's job now
 * (`jobPath`), read in the caller's transaction. A path whose first segment
 * names no job, or names a root folder that exists, is returned as it is
 * after one indexed read.
 */
export async function canonicalJobPath(db: DatabaseReader, workspaceId: Id<"workspaces">, path: string): Promise<string> {
  const slash = path.indexOf("/");
  const first = slash < 0 ? path : path.slice(0, slash);
  if (first === "" || jobOfName(first) === null) return path;
  const there = await db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", first))
    .unique();
  if (there !== null && there.goneAt === undefined && there.kind === "folder" && there.parentId === undefined) return path;
  return jobPath(await folderJobsOf(db, workspaceId), path);
}

/** Where this workspace's meetings land: its setting, or the default under the Inbox wherever that is. */
async function meetingsPath(db: DatabaseReader, workspaceId: Id<"workspaces">, jobs: FolderJobs): Promise<string> {
  const workspace = await db.get(workspaceId);
  const setting = workspace?.meetingsFolder;
  return jobPath(jobs, typeof setting === "string" && setting !== "" ? setting.replace(/\/+$/, "") : MEETINGS_FOLDER);
}

/**
 * The job a folder row about to be made should carry, or undefined: a root
 * folder under a job's name when no folder does that job yet, or the folder
 * the meetings setting names when none is the meetings folder yet.
 */
export async function roleForNewFolder(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  node: { path: string; kind: string; parentId?: Id<"nodes"> | string },
): Promise<RowRole | undefined> {
  if (node.kind !== "folder") return undefined;
  const top = node.parentId === undefined && !node.path.includes("/");
  const named = top ? jobOfName(node.path) : null;
  if (!top) {
    // A sweep makes folders by the thousand: only one named as the meetings setting's last segment reads on.
    const workspace = await db.get(workspaceId as Id<"workspaces">);
    const setting = typeof workspace?.meetingsFolder === "string" && workspace.meetingsFolder !== "" ? workspace.meetingsFolder : MEETINGS_FOLDER;
    if (lastSegment(node.path) !== lastSegment(setting.replace(/\/+$/, ""))) return undefined;
    // One indexed read more: a meetings folder that exists ends it.
    const meetings = await db
      .query("nodes")
      .withIndex("by_workspace_role", (q) => q.eq("workspaceId", workspaceId).eq("role", "meetings"))
      .first();
    if (meetings !== null && meetings.goneAt === undefined) return undefined;
  }
  const jobs = await folderJobsOf(db, workspaceId);
  if (named !== null) return jobs.jobs[named] === null ? named : undefined;
  if (jobs.jobs.meetings === null && (await meetingsPath(db, workspaceId, jobs)) === node.path) return "meetings";
  return undefined;
}

/**
 * Before a folder moves, write down the job its name gives it, so the job
 * survives the new name. Nothing for a row that already has one, a file, or a
 * folder doing no job.
 */
export async function claimJobBeforeMove(ctx: MutationCtx, workspaceId: Id<"workspaces">, row: Doc<"nodes">): Promise<RowRole | null> {
  if (row.kind !== "folder" || row.role === NO_JOB) return null;
  if (isRowRole(row.role)) return row.role;
  const jobs = await folderJobsOf(ctx.db, workspaceId);
  let job = jobAt(jobs, row.path);
  if (job === null && jobs.jobs.meetings === null && (await meetingsPath(ctx.db, workspaceId, jobs)) === row.path) job = "meetings";
  if (job === null) return null;
  await ctx.db.patch(row._id, { role: job });
  return job;
}

/** The job a row does now: its own, or the one its name gives it at the root. */
export async function jobOfRow(db: DatabaseReader, workspaceId: Id<"workspaces">, row: Doc<"nodes">): Promise<RowRole | null> {
  if (row.kind !== "folder" || row.role === NO_JOB) return null;
  if (isRowRole(row.role)) return row.role;
  return jobAt(await folderJobsOf(db, workspaceId), row.path);
}
