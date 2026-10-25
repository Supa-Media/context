/**
 * Rows a test inserts by hand carry a path and nothing else of the tree's
 * shape. Paths are built from parents (`functions/lib/nodes/paths.ts`), so a
 * row with no parent is a top-level row, whatever its path says. `parentRows`
 * gives every row of a workspace the parent and name its stored path names,
 * standing a folder row wherever one is missing, as the product's own writes
 * always leave them.
 */

import { afterEach, beforeEach, vi } from "vitest";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { nodePaths } from "../../functions/lib/nodes/paths";
import { folderOf } from "../../functions/lib/nodes/parentCheck";
import { nameOf } from "../../functions/lib/nodes/table";

export async function parentRows(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect();
  const folders = new Map<string, Id<"nodes">>();
  for (const row of rows) if (row.kind === "folder" && row.goneAt === undefined) folders.set(row.path, row._id);
  const folderAt = async (path: string): Promise<Id<"nodes">> => {
    const known = folders.get(path);
    if (known !== undefined) return known;
    const above = folderOf(path);
    const parentId = above === null ? undefined : await folderAt(above);
    const id = await ctx.db.insert("nodes", { workspaceId, path, parentId, name: nameOf(path), kind: "folder", observedAt: 1 });
    folders.set(path, id);
    return id;
  };
  for (const row of rows as Doc<"nodes">[]) {
    const above = folderOf(row.path);
    const parentId = above === null ? undefined : await folderAt(above);
    if (row.parentId !== parentId || row.name !== nameOf(row.path)) await ctx.db.patch(row._id, { parentId, name: nameOf(row.path) });
  }
}

/**
 * For a describe block that tests what only stored paths have (a paged move, its row cap, the parent check
 * that sets parents from paths): it runs on stored paths whatever the suite builds (`CONTEXT_TREE_PATHS`).
 * Built paths have none of it: a move of any size is one row change.
 */
export function storedPathsOnly(): void {
  beforeEach(() => {
    vi.stubEnv("CONTEXT_TREE_PATHS", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

/** `run` on stored paths, for one test of what only they have (see `storedPathsOnly`). */
export async function onStoredPaths<T>(run: () => Promise<T>): Promise<T> {
  const was = process.env.CONTEXT_TREE_PATHS;
  process.env.CONTEXT_TREE_PATHS = "";
  try {
    return await run();
  } finally {
    if (was === undefined) delete process.env.CONTEXT_TREE_PATHS;
    else process.env.CONTEXT_TREE_PATHS = was;
  }
}

/**
 * Every row of a workspace, live and gone, each with `path` set to where the tree reads it
 * (`paths.ts`): built from parents or stored, by the workspace's switch. A row no chain reaches
 * shows as `?<stored path>`, so a test sees it rather than losing it.
 */
export async function rowsAsRead(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Doc<"nodes">[]> {
  const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect();
  const paths = await nodePaths(ctx.db, workspaceId);
  return await Promise.all(rows.map(async (row) => ({ ...row, path: (await paths.pathOf(row)) ?? `?${row.path}` })));
}
