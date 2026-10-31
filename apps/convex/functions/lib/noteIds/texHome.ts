/**
 * Where a new note's text is kept: in the bucket, or in Tex's Durable Object
 * (decided by the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * A note made inside a personal workspace's Tex folder (the folder doing the
 * `tex` job, wherever it is now) is kept in that person's object: its row's
 * key has the Tex form (`apps/mcp/src/store/texRouting.js`). A note made under a
 * group chat's home in the pinned workspace (`textGroupHome.ts`) is kept in that
 * chat's object, the one whose key the home's words name. Anywhere else, it is a
 * bucket note as before. A note keeps where it was made when it moves: the key
 * travels with the row.
 */

import { CHAT_HOMES_FOLDER } from "@context/shared";
import type { Id } from "../../../_generated/dataModel";
import type { DatabaseReader, QueryCtx } from "../../../_generated/server";
import { texKeyFor } from "../../../../mcp/src/store/texRouting.js";
import { pinnedContextWorkspace } from "../pinnedContext";
import { idKeyFor } from "../nodes/noteIds";
import { nodeAt } from "./state";

/** The Tex folder's path in this workspace, or `null`: the folder with the `tex` job, else a root `tex` folder with none. */
export async function texFolderPath(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<string | null> {
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

/** The three words a group chat's home is named with (`textGroupHome.ts`, `threeWords`). */
const HOME_WORDS = /^[a-z]+(?:-[a-z]+){2}$/;

/**
 * The group chat whose object a note at `path` belongs to, by its key, or null. A path counts only beneath a
 * chat's home folder, and the home is found by its words: two chats naming the same words are no answer at all.
 */
export async function chatKeyOfHome(db: DatabaseReader, path: string): Promise<string | null> {
  const prefix = `${CHAT_HOMES_FOLDER}/`;
  if (!path.startsWith(prefix)) return null;
  const [words, ...inside] = path.slice(prefix.length).split("/");
  if (words === undefined || inside.length === 0 || !HOME_WORDS.test(words)) return null;
  const chats = await db.query("textGroups").withIndex("by_home_words", (q) => q.eq("homeWords", words)).take(2);
  return chats.length === 1 ? chats[0].groupKey : null;
}

/**
 * For each of `paths` (already carried to where its job folder is), the Tex
 * object a new note there would be kept in, or nothing. In a personal workspace,
 * that is its Tex folder's notes, in the person's object. In the pinned workspace
 * alone, it is a note under a group chat's home, in that chat's object: the
 * pinned workspace is the only one that holds homes, so a note anywhere else
 * never takes a chat's key. One read of the workspace and at most two of the
 * tree, whatever the number of paths.
 */
export async function texHomesFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  paths: string[],
): Promise<Map<string, string>> {
  const homes = new Map<string, string>();
  if (paths.length === 0) return homes;
  const workspace = await ctx.db.get(workspaceId);
  if (workspace === null) return homes;
  if (workspace.kind === "personal") {
    const folder = await texFolderPath(ctx.db, workspaceId);
    if (folder === null) return homes;
    for (const path of paths) if (path.startsWith(`${folder}/`)) homes.set(path, `person:${workspaceId}`);
    return homes;
  }
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null || pinned._id !== workspaceId) return homes;
  for (const path of paths) {
    const chat = await chatKeyOfHome(ctx.db, path);
    if (chat !== null) homes.set(path, `chat:${chat}`);
  }
  return homes;
}

/** Whether `key` is the Tex key a new note `noteId` at `path` may be adopted under. */
export async function isTexKeyFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  path: string,
  noteId: string,
  key: string,
): Promise<boolean> {
  const owner = (await texHomesFor(ctx, workspaceId, [path])).get(path);
  return owner !== undefined && key === texKeyFor(owner, idKeyFor(noteId, path));
}
