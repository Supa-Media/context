/**
 * The tree's side of the Tex folder rename (`texFolderNames.ts`): which workspaces are personal, which chats have a
 * home, and which of a few paths are live. Reads no credential, so it stays out of the decrypt-capable list, as
 * `texGroupMigrationRows.ts` does.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { liveNodeAt } from "./lib/nodes/paths";
import { chatHomeOf } from "./lib/textGroupHome";

const DEFAULT_PAGE = 25;

/** One page of personal workspaces, and where the next page starts. */
export const personalPage = internalQuery({
  args: { cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.object({ workspaceIds: v.array(v.id("workspaces")), seen: v.number(), cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, { cursor, limit }) => {
    const page = await ctx.db.query("workspaces").paginate({ cursor: cursor ?? null, numItems: limit ?? DEFAULT_PAGE });
    const workspaceIds = page.page.filter((row) => row.kind === "personal").map((row) => row._id);
    return { workspaceIds, seen: page.page.length, cursor: page.continueCursor, done: page.isDone };
  },
});

/** Every chat with a home: its key (for the names its notes had), the home's workspace, folder and row token. */
export const homes = internalQuery({
  args: {},
  returns: v.object({
    chats: v.number(),
    homes: v.array(v.object({ groupKey: v.string(), workspaceId: v.id("workspaces"), folder: v.string(), noteId: v.string() })),
  }),
  handler: async (ctx) => {
    const chats = await ctx.db.query("textGroups").collect();
    const homes = [];
    for (const chat of chats) {
      const home = await chatHomeOf(ctx, chat._id);
      if (home !== null) homes.push({ groupKey: chat.groupKey, ...home });
    }
    return { chats: chats.length, homes };
  },
});

/** Which of `paths` hold a live file in the workspace. */
export const liveFiles = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, { workspaceId, paths }) => {
    const live = [];
    for (const path of paths) {
      const row = await liveNodeAt(ctx.db, workspaceId, path);
      if (row !== null && row.kind === "file") live.push(path);
    }
    return live;
  },
});
