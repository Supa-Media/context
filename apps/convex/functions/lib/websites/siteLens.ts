/**
 * Reads under the website's default name, judged where the folder is now
 * (`./siteRoot.ts`). Asked first by the credential barrier, for the reads the site makes
 * by name — `read`, `readMany`, a `manifest` of a folder, and the copy Publish
 * keeps of each page (`writeWebsiteRelease`) — and only
 * when a path names `website/` and the folder doing the website's job sits
 * somewhere else. Everything else passes through untouched, at no cost.
 *
 * The answer is relabelled to the names asked, so the route index, the
 * published copies and every caller keep the `website/...` keys they have.
 */

import { DEFAULT_WEBSITE_ROOT } from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileOperation, OperationResult } from "../filesFns/operationTypes";
import { namesWebsite, realSitePath, siteNameOf } from "./siteRoot";

type LensArgs<Operation> = { workspaceId: Id<"workspaces">; operation: Operation };

function lensPaths(operation: FileOperation): string[] {
  switch (operation.kind) {
    case "read":
      return [operation.path];
    case "readMany":
      return operation.paths;
    case "manifest":
      return operation.folder === undefined ? [] : [operation.folder];
    case "writeWebsiteRelease":
      return operation.pages.map((page) => page.path);
    default:
      return [];
  }
}

/** `operation` with each `website/...` path carried to `root`. */
function translated(operation: FileOperation, root: string): FileOperation {
  switch (operation.kind) {
    case "read":
      return { ...operation, path: realSitePath(root, operation.path) };
    case "readMany":
      return { ...operation, paths: operation.paths.map((path) => realSitePath(root, path)) };
    case "manifest":
      return operation.folder === undefined ? operation : { ...operation, folder: realSitePath(root, operation.folder) };
    case "writeWebsiteRelease":
      // Each page's copy is kept by its page id; only the read of the live note needs the real name.
      return { ...operation, pages: operation.pages.map((page) => ({ ...page, path: realSitePath(root, page.path) })) };
    default:
      return operation;
  }
}

/** `result` named as asked: each path under `root` back under `website/`. */
function relabelled(result: OperationResult, root: string, asked: ReadonlyMap<string, string>): OperationResult {
  const back = (path: string) => asked.get(path) ?? siteNameOf(root, path) ?? path;
  switch (result.kind) {
    case "file":
      return { ...result, path: back(result.path) };
    case "notes":
      return { ...result, results: result.results.map((entry) => ({ ...entry, path: back(entry.path) })) };
    case "manifest":
      return {
        ...result,
        entries: result.entries.map((entry) => ({ ...entry, path: back(entry.path) })),
        // The folders above the website's own are not the site's to name.
        folders: result.folders.flatMap((folder) => {
          if (folder.path === "") return [folder];
          const named = siteNameOf(root, folder.path);
          return named === null ? [] : [{ ...folder, path: named }];
        }),
      };
    default:
      return result;
  }
}

/**
 * How to run `args` through the lens: the operation with each `website/...`
 * path carried to the folder, and how to name the answer back. Null when
 * nothing needs carrying — no path names `website/`, or the folder has not
 * moved — which costs nothing, or one query when a path names it.
 */
export async function siteLens(
  ctx: ActionCtx,
  args: LensArgs<unknown>,
): Promise<{ operation: FileOperation; relabel: (result: OperationResult) => OperationResult } | null> {
  const operation = args.operation as FileOperation;
  const paths = lensPaths(operation);
  if (!paths.some(namesWebsite)) return null;
  // A tree that cannot answer leaves the name as asked: judged there, it reads as private.
  const root = await ctx
    .runQuery(internal.functions.websites.siteRootNow, { workspaceId: args.workspaceId })
    .catch(() => DEFAULT_WEBSITE_ROOT);
  if (root === DEFAULT_WEBSITE_ROOT) return null;
  const carried = translated(operation, root);
  // The folder is never under a root folder called `website` (`siteRoot`), so a carried path names it no more.
  if (lensPaths(carried).some(namesWebsite)) return null;
  const asked = new Map(paths.filter(namesWebsite).map((path) => [realSitePath(root, path), path]));
  return { operation: carried, relabel: (result) => relabelled(result, root, asked) };
}
