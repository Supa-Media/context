/**
 * A path under a built-in folder's default name, carried to the folder doing
 * that job (`canonicalJobPath`). Asked first by the credential barrier, beside
 * the website's lens (`../websites/siteLens.ts`).
 *
 * Writers name the default spellings (`inbox/memories/...`, `projects/...`),
 * and since 2026-10-21 those are the plain names, while a workspace not yet
 * renamed still has `0-inbox` (owner: "need to get rid of the 1- 2-
 * prefixes"). A keyed write is carried by its row lookup already
 * (`noteIdsKeyed.keyedPathOf`); an unkeyed one was not, and the name-twin
 * guard refused it ("0-inbox is already this workspace's Inbox folder"), so
 * the memory, the meeting or the forwarded mail was lost. A listing was
 * carried nowhere, keyed or not. This lens carries both, before anything else
 * reads the path.
 *
 * Only the first segment is ever changed, and only when it is a job's name, no
 * live root folder has exactly that name, and another folder does the job; so
 * a folder somebody really called `projects` is always the one written.
 */

import { jobOfName } from "@context/shared/src/folderRoles.cjs";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileOperation } from "./operationTypes";

function firstSegment(path: string): string {
  const slash = path.indexOf("/");
  return slash < 0 ? path : path.slice(0, slash);
}

/** Whether `path` starts with a job's name, so it may need carrying. Costs nothing. */
function namesJob(path: string | undefined): path is string {
  return typeof path === "string" && path !== "" && jobOfName(firstSegment(path)) !== null;
}

function lensPaths(operation: FileOperation): string[] {
  switch (operation.kind) {
    case "read":
    case "write":
    case "list":
    case "createFolder":
      return [operation.path];
    case "readMany":
      return operation.paths;
    case "manifest":
      return operation.folder === undefined ? [] : [operation.folder];
    default:
      return [];
  }
}

function carried(operation: FileOperation, map: (path: string) => string): FileOperation {
  switch (operation.kind) {
    case "read":
    case "write":
    case "list":
    case "createFolder":
      return { ...operation, path: map(operation.path) };
    case "readMany":
      return { ...operation, paths: operation.paths.map(map) };
    case "manifest":
      return operation.folder === undefined ? operation : { ...operation, folder: map(operation.folder) };
    default:
      return operation;
  }
}

/**
 * `args.operation` with each default-named path carried to its job's folder,
 * or null when nothing changes: no path starts with a job's name (no query at
 * all), or every one already names a real folder.
 */
export async function jobLens(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; operation: unknown },
): Promise<FileOperation | null> {
  const operation = args.operation as FileOperation;
  const paths = lensPaths(operation).filter(namesJob);
  if (paths.length === 0) return null;
  const asked = [...new Set(paths)];
  const real: string[] = await ctx
    .runQuery(internal.functions.jobPaths.carry, { workspaceId: args.workspaceId, paths: asked })
    .catch(() => asked);
  const map = new Map(asked.map((path, index) => [path, real[index] ?? path]));
  if (asked.every((path) => map.get(path) === path)) return null;
  return carried(operation, (path) => map.get(path) ?? path);
}
