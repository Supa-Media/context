/**
 * One folder's listing, answered from the Convex tree instead of the bucket
 * (phase 2 of `docs/decisions/app-and-console/convex-tree.md`).
 *
 * **The privacy decision is not reimplemented here.** The rows are handed to
 * the unchanged `listFolder` as a store that answers a delimited listing of one
 * folder, and `privacy.md` as the tree's mirror renders it. So who sees which
 * name is still `canSee` and `folderVisibleAtScope` over the same rules, and a
 * withheld folder still answers exactly as an absent one does. What this file
 * owns is only which rows make up a folder, and when the tree is there to
 * answer at all (`treeReadiness`).
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import type { Clearance } from "../clearance";
import { listFolder, type FolderListing } from "../fileOps/listing";
import { requireFolderPath } from "../fileOps/paths";
import type { FileStore } from "../fileOps/store";
import { mirrorFile, readMirror } from "./privacyMirror";
import { readerMirror, rulesForReaders } from "./readerRules";
import { childrenThroughMoves, pendingMoves } from "./moveOverlay";
import { NODE_PRIVACY_KEY, type PrivacyMirror } from "./table";
import { folderJobsOf } from "./folderJobs";
import { compareListingEntries, isRowRole, jobAt } from "@context/shared/src/folderRoles.cjs";

export { readMirror };

/**
 * Rows of one folder a listing reads before calling itself short. A folder
 * bigger than this answers `truncated`, as a bucket listing past its page cap
 * does; the console already says so.
 */
export const NODE_LISTING_ROWS = 5_000;

/**
 * Where a workspace's tree is, for a reader: `served` once its first copy has
 * finished, `loading` before that, `unsupported` for a store that cannot be
 * listed in key order (one that ignores key order), which no sweep can copy.
 *
 * Decided by the owner, 2026-10-13 ("the only thing that should be reading
 * from storage directly should be actually opening and editing a note"):
 * Convex always answers. Until then a reader read the bucket wherever the
 * last parity check differed, a pass failed, or staff paused the migration.
 * Now parity is an alarm for staff, a failed pass is retried behind a tree
 * that keeps serving, and Pause stops copying work only. A re-sweep of a
 * finished copy keeps `ready`, so it keeps serving the rows it has.
 */
export type TreeReadiness = "served" | "loading" | "unsupported";

export function treeReadiness(tree: Pick<Doc<"nodeTrees">, "status"> | null): TreeReadiness {
  if (tree === null) return "loading";
  if (tree.status === "unsupported") return "unsupported";
  return tree.status === "ready" ? "served" : "loading";
}

/** Whether this workspace's tree answers its readers: its first copy has finished. */
export function treeServes(tree: Pick<Doc<"nodeTrees">, "status"> | null): boolean {
  return treeReadiness(tree) === "served";
}

/**
 * The live children of `folder`: its own row's children, never a gone one.
 * `null` when the folder has no live row, which lists as an empty folder,
 * exactly what the bucket answers for a prefix nothing sits under.
 */
async function childrenOf(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  folder: string,
): Promise<{ rows: Doc<"nodes">[]; more: boolean }> {
  let parentId: Id<"nodes"> | undefined;
  if (folder !== "") {
    const node = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", folder))
      .unique();
    if (node === null || node.kind !== "folder" || node.goneAt !== undefined) return { rows: [], more: false };
    parentId = node._id;
  }
  const rows: Doc<"nodes">[] = [];
  const children = ctx.db
    .query("nodes")
    .withIndex("by_parent_name", (q) => q.eq("workspaceId", workspaceId).eq("parentId", parentId));
  for await (const row of children) {
    if (row.goneAt !== undefined) continue;
    if (rows.length === NODE_LISTING_ROWS) return { rows, more: true };
    rows.push(row);
  }
  return { rows, more: false };
}

/** The row at one bucket key, live or gone. */
async function rowAt(ctx: QueryCtx, workspaceId: Id<"workspaces">, path: string): Promise<Doc<"nodes"> | null> {
  return await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
    .unique();
}

/**
 * A store that answers the one delimited listing `listFolder` asks of it, and
 * `privacy.md` from the mirror. Anything else is refused: a listing reads
 * nothing more, and a store that quietly answered other calls would be a
 * second, untested source.
 */
export function folderRowsStore(
  folder: string,
  rows: readonly Pick<Doc<"nodes">, "path" | "kind" | "name" | "size" | "uploaded">[],
  more: boolean,
  mirror: PrivacyMirror | null,
): FileStore {
  const prefix = folder === "" ? "" : `${folder}/`;
  const refuse = () => {
    throw new Error("a tree listing reads one folder and privacy.md");
  };
  return {
    list: async (options?: { prefix?: string; delimiter?: string }) => {
      if (options?.prefix !== prefix || options.delimiter !== "/") refuse();
      const objects = rows
        .filter((row) => row.kind === "file")
        .map((row) => ({
          // A marker row (`a/`, named "") lists as the marker key itself, which `listFolder` skips.
          key: row.path,
          ...(row.size !== undefined ? { size: row.size } : {}),
          ...(row.uploaded !== undefined ? { uploaded: new Date(row.uploaded) } : {}),
        }));
      const delimitedPrefixes = rows.filter((row) => row.kind === "folder").map((row) => `${row.path}/`);
      // Short with no cursor: `listFolder` reports that as truncated, never as a total.
      return { objects, delimitedPrefixes, truncated: more };
    },
    get: async (key: string) => {
      if (key !== NODE_PRIVACY_KEY) refuse();
      return mirrorFile(mirror);
    },
  } as unknown as FileStore;
}

/** Where this workspace's tree is now, read in the caller's transaction. */
export async function treeReadinessNow(db: QueryCtx["db"], workspaceId: Id<"workspaces">): Promise<TreeReadiness> {
  const tree = await db
    .query("nodeTrees")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return treeReadiness(tree);
}

/** Whether the tree serves this workspace now (`treeReadiness`). */
export async function treeServesNow(db: QueryCtx["db"], workspaceId: Id<"workspaces">): Promise<boolean> {
  return (await treeReadinessNow(db, workspaceId)) === "served";
}

/** One folder's listing at `clearance`, from the tree's rows and its privacy mirror. */
export async function listFolderFromNodes(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  path: string,
  clearance: Clearance,
): Promise<FolderListing> {
  // The same refusal the bucket listing gives a malformed path, before any read.
  const folder = requireFolderPath(path);
  // Moves the tree shows already, folded in before privacy is judged (`moveOverlay.ts`).
  const moves = await pendingMoves(ctx.db, workspaceId);
  const { rows, more } = moves.length === 0
    ? await childrenOf(ctx, workspaceId, folder)
    : await childrenThroughMoves(folder, moves, (source) => childrenOf(ctx, workspaceId, source), (key) => rowAt(ctx, workspaceId, key));
  // The rules readers judge by (`readerRules.ts`): the mirror's own, or the access rows' once they are the source.
  const mirror = await readerMirror(ctx, workspaceId);
  const judged = await rulesForReaders(ctx, workspaceId);
  const manifestUsable = mirror !== null && mirror.etag !== undefined && !mirror.invalid;
  const listing = await listFolder(folderRowsStore(folder, rows, more, mirror), {
    path: folder,
    clearance,
    judged: { ...judged, manifestUsable },
  });
  return await withFolderJobs(ctx, workspaceId, folder, rows, listing);
}

/**
 * Each folder entry with its job and its order from its row (`folderJobs.ts`),
 * drawn in that order (`compareListingEntries`). At the root a folder whose
 * row has no job yet takes the one its name gives it, so a renamed and an
 * unrenamed Inbox list alike.
 */
async function withFolderJobs(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  folder: string,
  rows: readonly Doc<"nodes">[],
  listing: FolderListing,
): Promise<FolderListing> {
  if (!listing.entries.some((entry) => entry.kind === "folder")) return listing;
  const byPath = new Map(rows.filter((row) => row.kind === "folder").map((row) => [row.path, row]));
  const jobs = folder === "" ? await folderJobsOf(ctx.db, workspaceId) : null;
  const entries = listing.entries.map((entry) => {
    if (entry.kind !== "folder") return entry;
    const row = byPath.get(entry.path);
    const role = isRowRole(row?.role) ? row.role : jobs === null ? null : jobAt(jobs, entry.path);
    return {
      ...entry,
      ...(role === null ? {} : { role }),
      ...(typeof row?.order === "number" ? { order: row.order } : {}),
    };
  });
  entries.sort((a, b) => compareListingEntries(folder, a, b));
  return { ...listing, entries };
}
