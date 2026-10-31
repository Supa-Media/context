/**
 * Where a new note's text is kept: in the bucket, or in Tex's Durable Object
 * (decided by the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * A note made inside a personal workspace's Tex folder (the folder doing the
 * `tex` job, wherever it is now) is kept in that person's object: its row's
 * key has the Tex form (`apps/mcp/src/store/texRouting.js`). Anywhere else, and in
 * a shared workspace, it is a bucket note as before. A note keeps where it
 * was made when it moves: the key travels with the row.
 */

import type { Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";
import { texKeyFor } from "../../../../mcp/src/store/texRouting.js";
import { idKeyFor } from "../nodes/noteIds";
import { nodeAt } from "./state";

/** The Tex folder's path in this workspace, or `null`: the folder with the `tex` job, else a root `tex` folder with none. */
async function texFolderPath(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<string | null> {
  const doing = await db
    .query("nodes")
    .withIndex("by_workspace_role", (q) => q.eq("workspaceId", workspaceId).eq("role", "tex"))
    .take(4);
  const live = doing.find((row) => row.goneAt === undefined && row.kind === "folder");
  if (live !== undefined) return live.path;
  const root = await nodeAt(db, workspaceId, "tex");
  if (root !== null && root.goneAt === undefined && root.kind === "folder" && root.parentId === undefined && root.role === undefined) return "tex";
  return null;
}

/**
 * For each of `paths` (already carried to where its job folder is), the Tex
 * object a new note there would be kept in, or nothing. One read of the
 * workspace and at most two of the tree, whatever the number of paths.
 */
export async function texHomesFor(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  paths: string[],
): Promise<Map<string, string>> {
  const homes = new Map<string, string>();
  if (paths.length === 0) return homes;
  const workspace = await db.get(workspaceId);
  if (workspace === null || workspace.kind !== "personal") return homes;
  const folder = await texFolderPath(db, workspaceId);
  if (folder === null) return homes;
  for (const path of paths) if (path.startsWith(`${folder}/`)) homes.set(path, `person:${workspaceId}`);
  return homes;
}

/** Whether `key` is the Tex key a new note `noteId` at `path` may be adopted under. */
export async function isTexKeyFor(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  path: string,
  noteId: string,
  key: string,
): Promise<boolean> {
  const owner = (await texHomesFor(db, workspaceId, [path])).get(path);
  return owner !== undefined && key === texKeyFor(owner, idKeyFor(noteId, path));
}
