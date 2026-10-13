/**
 * The whole-tree walk (`syncManifest`), answered from the Convex tree once it
 * serves the workspace (phase 2 of
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * A browser tab draws Home, pins, recents and its quick switcher from that
 * walk, and the desktop and phone apps feed their device copy from it. Before
 * this, it listed the per-workspace tree table or the bucket. Now it pages the
 * same rows the sidebar's live listings read, so every screen in a tab draws
 * from one tree.
 *
 * As with the live listing, nothing about privacy is decided here: the store
 * answers `list` from the rows and `privacy.md` from the tree's rules, and the
 * unchanged `syncManifest` decides what the caller sees with `canSee`.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps/store";
import { mirrorFile } from "./privacyMirror";
import { NODE_PRIVACY_KEY, type NodeRow, type PrivacyMirror } from "./table";

/** One page of live file rows in key order, from just after `after`. */
export type NodePage = (after: string | undefined, limit: number) => Promise<{ rows: NodeRow[]; cursor: string | null }>;

/**
 * A store whose listings page the tree's rows and whose `privacy.md` is the
 * tree's rules. Every other read is the bucket's own, through the prototype,
 * as `treeListingStore` (`apps/mcp/src/tree/source.js`) does it.
 *
 * The cursor it hands back is the last key of the page, a path the caller was
 * given, never anything about rows it was not.
 */
export function nodesPagedStore(base: FileStore, page: NodePage, mirror: PrivacyMirror | null): FileStore {
  const store = Object.create(base) as FileStore;
  store.list = async (options) => {
    const prefix = options?.prefix ?? "";
    const cursor = options?.cursor;
    let after = typeof cursor === "string" && cursor !== "" ? cursor : options?.startAfter;
    // Start at the prefix itself rather than at the top of the tree.
    if (prefix !== "" && (after === undefined || after < prefix)) after = prefix;
    const limit = options?.limit !== undefined && options.limit > 0 ? options.limit : 1000;
    const { rows, cursor: next } = await page(after, limit);
    const inside = rows.filter((row) => row.path.startsWith(prefix));
    // A row past the prefix means the rest of the tree is past it too.
    const done = next === null || inside.length < rows.length;
    return {
      objects: inside.map((row) => ({
        key: row.path,
        ...(row.etag !== undefined ? { etag: row.etag } : {}),
        ...(row.size !== undefined ? { size: row.size } : {}),
        ...(row.uploaded !== undefined ? { uploaded: new Date(row.uploaded) } : {}),
      })),
      truncated: !done,
      ...(done || rows.length === 0 ? {} : { cursor: rows[rows.length - 1]!.path }),
    };
  };
  store.get = async (key, ...rest) => {
    if (key !== NODE_PRIVACY_KEY) return await base.get(key, ...rest);
    return mirrorFile(mirror) as Awaited<ReturnType<FileStore["get"]>>;
  };
  return store;
}

/**
 * The store a walk of this workspace reads when the tree serves it, or `null`
 * when it does not (not yet proved, failing, or staff paused the migration),
 * and the walk reads what it read before.
 */
export async function servedNodesStore(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  base: FileStore,
): Promise<FileStore | null> {
  const served = await ctx.runQuery(internal.functions.nodes.served, { workspaceId });
  if (served === null) return null;
  const page: NodePage = async (after, limit) => {
    const result = await ctx.runQuery(internal.functions.nodes.listLive, {
      workspaceId,
      limit,
      ...(after === undefined ? {} : { after }),
    });
    return {
      rows: result.rows.map((row) => ({
        path: row.path,
        ...(row.etag === undefined ? {} : { etag: row.etag }),
        ...(row.size === undefined ? {} : { size: row.size }),
        ...(row.uploaded === undefined ? {} : { uploaded: row.uploaded }),
      })),
      cursor: result.cursor,
    };
  };
  return nodesPagedStore(base, page, served.mirror);
}
