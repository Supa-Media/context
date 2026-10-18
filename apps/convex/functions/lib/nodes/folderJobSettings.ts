/**
 * Giving a built-in folder's job to a folder a person names, or taking an
 * optional one away (decided by the owner, 2026-10-18, picking every board of
 * `folder-jobs-marking`; `docs/decisions/app-and-console/folder-jobs.md`).
 *
 * `decideJobChange` is the whole rule, kept apart from the database so it is
 * tested as it is: Settings › Built-in folders, "Use this folder as…", the
 * import picker and an AI client's `folder_job` all come through it.
 *
 * Nothing moves. The folder named starts doing the job (its row's `role`),
 * and the folder that did it before keeps everything in it but does no job
 * (`NO_JOB`), so its name never claims the job back.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";
import { type FolderJobs, JOB_LABEL, isRowRole } from "@context/shared/src/folderRoles.cjs";
import { canGiveJob, canRemoveJob, isInboxPart, jobNames, topOnly } from "@context/shared/src/folderJobInfo.cjs";

/** Folders read to guess jobs from: past any real workspace's top three levels, a bound on the reads. */
export const SURVEY_ROWS = 4_000;
/** How deep guesses look (`guessFolderJobs` stops there too). */
export const SURVEY_DEPTH = 3;

export type JobRefusal = { code: "PATH_INVALID" | "FILE_NOT_FOUND" | "DESTINATION_EXISTS"; message: string };
export type JobChange = { clear: string[]; set: string | null };

function label(job: string): string {
  return isRowRole(job) ? JOB_LABEL[job] : job;
}

/** The job `path` does now, if any. */
function jobHeldAt(jobs: FolderJobs, path: string): string | null {
  for (const [job, held] of Object.entries(jobs.jobs)) if (held === path) return job;
  return null;
}

/**
 * What giving `job` to `path` (or, with `path` null, taking `job` away) does:
 * the folders that stop doing it and the one that starts, or why not.
 * `isFolder` answers whether a live folder sits at a path.
 */
export function decideJobChange(
  jobs: FolderJobs,
  job: string,
  path: string | null,
  isFolder: (path: string) => boolean,
): JobChange | JobRefusal {
  if (job === "website") return { code: "PATH_INVALID", message: "Website keeps its name and place: your site is published from it." };
  if (!canGiveJob(job) || !isRowRole(job)) {
    return {
      code: "PATH_INVALID",
      message: `There is no "${job}" job. The jobs are ${jobNames()}. A folder of your own kind explains itself in its about.md.`,
    };
  }
  const holder = jobs.jobs[job];
  if (path === null) {
    if (!canRemoveJob(job)) return { code: "PATH_INVALID", message: `${label(job)} is needed. Give it to another folder instead.` };
    return { clear: holder === null ? [] : [holder], set: null };
  }
  if (!isFolder(path)) return { code: "FILE_NOT_FOUND", message: "There is no folder there." };
  if (topOnly(job) && path.includes("/")) return { code: "PATH_INVALID", message: `${label(job)} stays at the top of the workspace.` };
  if (isInboxPart(path, jobs.jobs.inbox)) return { code: "PATH_INVALID", message: "That folder is one of the Inbox's own: Context files into it." };
  const now = jobHeldAt(jobs, path);
  if (now === job) return { clear: [], set: null };
  if (now !== null) {
    return { code: "DESTINATION_EXISTS", message: `That folder is already your ${label(now)} folder. Give that job to another folder first.` };
  }
  return { clear: holder === null ? [] : [holder], set: path };
}

export function isRefusal(value: JobChange | JobRefusal): value is JobRefusal {
  return "code" in value;
}

/** The live folder rows of the workspace's top `SURVEY_DEPTH` levels, at most `SURVEY_ROWS` rows read. */
export async function surveyFolders(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<Doc<"nodes">[]> {
  const folders: Doc<"nodes">[] = [];
  let read = 0;
  let level: (Id<"nodes"> | undefined)[] = [undefined];
  for (let depth = 1; depth <= SURVEY_DEPTH && level.length > 0; depth += 1) {
    const next: Id<"nodes">[] = [];
    for (const parentId of level) {
      if (read >= SURVEY_ROWS) return folders;
      const rows = await db
        .query("nodes")
        .withIndex("by_parent_name", (q) => q.eq("workspaceId", workspaceId).eq("parentId", parentId))
        .take(SURVEY_ROWS - read);
      read += rows.length;
      for (const row of rows) {
        if (row.kind !== "folder" || row.goneAt !== undefined) continue;
        folders.push(row);
        next.push(row._id);
      }
    }
    level = next;
  }
  return folders;
}
