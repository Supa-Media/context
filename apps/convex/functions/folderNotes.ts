/**
 * A folder List or Board's notes from the tree's properties table: one query
 * instead of reading every note (decided by the owner, 2026-10-09). Any member
 * may ask, and is answered only with notes their clearance can see — see
 * `lib/filesFns/folderNotes.ts`. `available: false` means read the folder
 * from the bucket instead (`syncManifest` and `readNotes`).
 *
 * Its own module because `files.ts` is past the size a file may grow from.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import type { FolderNotesResult } from "./lib/filesFns/folderNotes";
import { folderNotesValidator } from "./lib/filesFns/validators";

export async function folderNotesHandler(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; folder: string; subfolders: boolean; cursor?: string },
): Promise<FolderNotesResult> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: {
      kind: "folderNotes",
      folder: args.folder,
      subfolders: args.subfolders,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    },
  });
  return result as FolderNotesResult;
}

export const folderNotes = action({
  args: {
    workspaceId: v.id("workspaces"),
    folder: v.string(),
    subfolders: v.boolean(),
    cursor: v.optional(v.string()),
  },
  returns: folderNotesValidator,
  handler: async (ctx, args): Promise<FolderNotesResult> => await folderNotesHandler(ctx, args),
});
