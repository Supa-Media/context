/**
 * Which folder does each built-in job, as the workspace object answers it for one reader (the `jobs` ask of
 * `workspaceStore/facts.js`). A port of the Convex branch that answers the same ask (`lib/nodes/gatewayFacts.ts`
 * over `folderJobsAndClaims` in `lib/nodes/folderJobs.ts`): the live folders that are top-level or carry a job, outside
 * the trash, through `folderJobs` (`packages/shared/src/folderRoles.cjs`); then each job's folder and each root are
 * named only where `folderSees` (the reader's `folderVisibleAtScope`) says the reader may see them.
 *
 * `rows` are the object's live rows (`gone = 0`): `{path, kind, role}`. Judged here, not by the caller: the trash and
 * anything that is not a folder. `apps/convex/__tests__/workspaceObjectJobs.test.ts` runs Convex's logic and this one
 * over the same fixtures and fails on any difference.
 */

import { folderJobs, isRowRole, NO_JOB } from "../../../../packages/shared/src/folderRoles.cjs";

/** The trash's folder row root (`TRASH_ROOT` in `apps/convex/functions/lib/fileOps/store.ts`). */
const TRASH_ROOT = ".context/trash";

function inTrash(path) {
  return path === TRASH_ROOT || path.startsWith(`${TRASH_ROOT}/`);
}

/**
 * `{served: true, jobs, roots}` for one reader: `jobs[job]` is the folder path doing it when `folderSees` allows, else
 * null; `roots` the root folder names it allows, sorted as `folderJobs` sorts them.
 *
 * @param {Array<{path: string, kind: string, role: string | null}>} rows
 * @param {(path: string) => boolean} folderSees
 */
export function folderJobsAnswer(rows, folderSees) {
  const live = rows.filter((row) => row.kind === "folder" && !inTrash(row.path));
  const named = live
    .filter((row) => !row.path.includes("/") || isRowRole(row.role))
    .map((row) => ({
      path: row.path,
      name: row.path,
      top: !row.path.includes("/"),
      ...(isRowRole(row.role) || row.role === NO_JOB ? { role: row.role } : {}),
    }));
  const answer = folderJobs(named);
  const jobs = {};
  for (const [job, path] of Object.entries(answer.jobs)) jobs[job] = path !== null && folderSees(path) ? path : null;
  return { served: true, jobs, roots: answer.roots.filter(folderSees) };
}
