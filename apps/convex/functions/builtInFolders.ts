/**
 * Adding a built-in folder a workspace does not have yet: an extra (Clients,
 * Teams, Products) from "Add a folder", or a main folder an older workspace
 * lacks. See `lib/fileOps/builtInFolders.ts`. Editor, like any new folder.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import type { OperationResult } from "./lib/filesFns/operationTypes";

/** Add the folder for `role` ("clients", "teams", "products", or a main role) under its fixed name. */
export const add = action({
  args: { workspaceId: v.id("workspaces"), role: v.string() },
  returns: v.object({ path: v.string(), readme: v.string() }),
  handler: async (ctx, args): Promise<{ path: string; readme: string }> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "addBuiltInFolder", role: args.role },
    })) as Extract<OperationResult, { kind: "folderCreated" }>;
    return { path: result.path, readme: result.readme };
  },
});
