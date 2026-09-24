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

/**
 * Structured Obsidian plugin compatibility for the first-party console.
 *
 * Owner-only because `.obsidian/` is outside the privacy manifest: a member
 * may read the notes their scope permits, but that says nothing about whether
 * they may inventory another person's installed software or its settings.
 * The credential barrier returns only manifest metadata and scan findings;
 * bundle text and `data.json` never leave it.
 */
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

/**
 * What Context has installed in this bucket, cheap enough to ask on arrival.
 *
 * Owner-only, like `listObsidianPlugins` beside it and for the same reason:
 * what software a context runs is the owner's to know.
 *
 * The console calls this when the plugins pane opens, and it is the only plugin
 * read that does not wait for a press. It reads one pointer per install, opens
 * no bundle and writes nothing — `listManagedInstalls` carries the argument for
 * why that is a different cost from a scan, and what the missing answer cost.
 */
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
