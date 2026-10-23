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
 * answer at all (`treeServes`).
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import type { Clearance } from "../clearance";
import { folderVisibleAtScope, listFolder, type FolderListing } from "../fileOps/listing";
import { requireFolderPath } from "../fileOps/paths";
import type { FileStore } from "../fileOps/store";
import { mirrorFile, readMirror } from "./privacyMirror";
import { readerView } from "./readerRules";
import { audienceOfNames } from "../pinnedReaders";
import { childrenThroughMoves } from "./moveOverlay";
import { drawnMoves } from "./rowMoveChunks";
import { NODE_PRIVACY_KEY, type PrivacyMirror } from "./table";
import { folderJobsOf } from "./folderJobs";
import { compareListingEntries, isRowRole, jobAt, type RowRole } from "@context/shared/src/folderRoles.cjs";

export { readMirror };

/**
 * Rows of one folder a listing reads before calling itself short. A folder
 * bigger than this answers `truncated`, as a bucket listing past its page cap
 * does; the console already says so.
 */
export const NODE_LISTING_ROWS = 5_000;

/**
 * Whether this workspace's tree answers its readers: its `nodeTrees` row is
 * `ready`, the served marker the workspace was born with (`lib/noteIds/born.ts`).
 * A workspace without one is not served, and no reader is told it is loading.
 */
export function treeServes(tree: Pick<Doc<"nodeTrees">, "status"> | null): boolean {
  return tree !== null && tree.status === "ready";
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
/** Whether the tree serves this workspace now (`treeServes`). */
export async function treeServesNow(db: QueryCtx["db"], workspaceId: Id<"workspaces">): Promise<boolean> {
  const tree = await db
    .query("nodeTrees")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return treeServes(tree);
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
  const moves = await drawnMoves(ctx.db, workspaceId);
  const { rows, more } = moves.length === 0
    ? await childrenOf(ctx, workspaceId, folder)
    : await childrenThroughMoves(folder, moves, (source) => childrenOf(ctx, workspaceId, source), (key) => rowAt(ctx, workspaceId, key));
  // The rules readers judge by (`readerRules.ts`): the mirror's own, or the access rows' once they are the source.
  // A pin reader's names say they read as a guest (`lib/pinnedReaders.ts`), and they are judged by a guest's rules.
  const { mirror, judged } = await readerView(ctx, workspaceId, audienceOfNames(clearance.names));
  const manifestUsable = mirror !== null && mirror.etag !== undefined && !mirror.invalid;
  const listing = await listFolder(folderRowsStore(folder, rows, more, mirror), {
    path: folder,
    clearance,
    judged: { ...judged, manifestUsable },
  });
  // Read whether or not the caller may see the folder, so a withheld folder costs what an absent one does.
  const job = await ownJob(ctx, workspaceId, folder);
  const own = folderVisibleAtScope(folder, clearance, judged.rules, judged.overrides) ? job : null;
  return { ...(await withFolderJobs(ctx, workspaceId, folder, rows, listing)), ...(own === null ? {} : { role: own }) };
}

/**
 * The listed folder's own job, so a page opened on a nested built-in folder
 * (a website moved into Areas, opened before Areas has listed) knows what it
 * is without its parent's listing. Its row's job, or at the top level the one
 * its name gives it, as its parent's listing would say.
 */
async function ownJob(ctx: QueryCtx, workspaceId: Id<"workspaces">, folder: string): Promise<RowRole | null> {
  if (folder === "") return null;
  const row = await rowAt(ctx, workspaceId, folder);
  const byName = folder.includes("/") ? null : jobAt(await folderJobsOf(ctx.db, workspaceId), folder);
  if (row === null || row.goneAt !== undefined || row.kind !== "folder") return null;
  return isRowRole(row.role) ? row.role : byName;
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
      ...(isRowRole(row?.archiveOf) ? { archiveOf: row.archiveOf } : {}),
    };
  });
  entries.sort((a, b) => compareListingEntries(folder, a, b));
  return { ...listing, entries };
}
