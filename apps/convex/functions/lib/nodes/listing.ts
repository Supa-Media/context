/**
 * One folder's listing, answered from the Convex tree instead of the bucket
 * (phase 2 of `docs/decisions/app-and-console/convex-tree.md`).
 *
 * **The privacy decision is not reimplemented here.** The rows are handed to
 * the unchanged `listFolder` as a store that answers a delimited listing of one
 * folder, and `privacy.md` as the tree's mirror renders it. So who sees which
 * name is still `canSee` and `folderVisibleAtScope` over the same rules, and a
 * withheld folder still answers exactly as an absent one does. What this file
 * owns is only which rows make up a folder, and when the tree may answer at all
 * (`treeServes`).
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import type { Clearance } from "../clearance";
import { listFolder, type FolderListing } from "../fileOps/listing";
import { requireFolderPath } from "../fileOps/paths";
import type { FileStore } from "../fileOps/store";
import { renderMirror } from "./privacyMirror";
import { NODE_PRIVACY_KEY, type PrivacyMirror } from "./table";

/**
 * Rows of one folder a listing reads before calling itself short. A folder
 * bigger than this answers `truncated`, as a bucket listing past its page cap
 * does; the console already says so.
 */
export const NODE_LISTING_ROWS = 5_000;

/**
 * Whether this workspace's tree may answer a person's listing.
 *
 * Only a tree a parity check has proved equal to the bucket, at every
 * clearance, with the same rules, and whose last pass did not fail. Anything
 * else (never checked, differs, stuck, skipped, or staff paused the
 * migration) answers `false`, and the console reads the bucket as before. So
 * Pause in admin is also the way back for every reader at once.
 */
export function treeServes(tree: Doc<"nodeTrees"> | null, paused: boolean): boolean {
  if (paused || tree === null) return false;
  if (tree.status !== "ready" || tree.error !== undefined) return false;
  const parity = tree.parity;
  return parity !== undefined && parity.mismatches === 0 && parity.privacyMatches;
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
      const text = mirror === null ? null : renderMirror(mirror);
      if (mirror === null || mirror.etag === undefined || text === null) return null;
      const bytes = new TextEncoder().encode(text);
      return {
        etag: mirror.etag,
        text: async () => text,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      };
    },
  } as unknown as FileStore;
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
  const { rows, more } = await childrenOf(ctx, workspaceId, folder);
  const mirrorRow = await ctx.db
    .query("nodePrivacy")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  const mirror: PrivacyMirror | null =
    mirrorRow === null
      ? null
      : {
          ...(mirrorRow.etag === undefined ? {} : { etag: mirrorRow.etag }),
          invalid: mirrorRow.invalid,
          folders: mirrorRow.folders,
          notes: mirrorRow.notes,
        };
  return await listFolder(folderRowsStore(folder, rows, more, mirror), { path: folder, clearance });
}
