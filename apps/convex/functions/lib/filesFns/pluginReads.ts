/**
 * The owner's view of the plugins in their bucket: the Obsidian inventory and
 * Context's managed installs. Owner-only, and metadata only.
 *
 * Handler bodies of functions `functions/files.ts` registers, moved verbatim;
 * the registrations (names, args, returns) stay there.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { callerId } from "./access";
import type { OperationResult } from "./operationTypes";

export async function listObsidianPluginsHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
  },
): Promise<Extract<OperationResult, { kind: "pluginInventory" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "pluginInventory" },
  });
  return result as Extract<OperationResult, { kind: "pluginInventory" }>;
}

export async function listManagedPluginsHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
  },
): Promise<Extract<OperationResult, { kind: "pluginManagedInstalls" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "pluginManagedList" },
  });
  return result as Extract<OperationResult, { kind: "pluginManagedInstalls" }>;
}
