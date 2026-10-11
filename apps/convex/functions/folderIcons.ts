/**
 * Folder icons: the emoji somebody gave a folder from "Set icon…" in its menu.
 *
 * Stored in the workspace's own bucket (`.context/folder-icons.json`, see
 * `@context/shared`'s `folderIcons.cjs`), reached through `runFileOperation`
 * like every other bucket read. Any member reads the icons of the folders
 * they can see; changing one changes what everybody's folder list looks like,
 * so it takes an editor, the same role renaming the folder takes.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import type { FileOperation as Operation, OperationResult } from "./lib/filesFns/operationTypes";

type Icons = Array<{ path: string; icon: string }>;

async function run(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  minimum: "member" | "editor",
  operation: Operation,
): Promise<Icons> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId,
    minimum,
  });
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId,
    scope,
    grantedNames,
    operation,
  })) as Extract<OperationResult, { kind: "folderIcons" }>;
  return result.icons;
}

const iconsValidator = v.array(v.object({ path: v.string(), icon: v.string() }));

/** Every icon on a folder the caller can see. Any member. */
export const list = action({
  args: { workspaceId: v.id("workspaces") },
  returns: iconsValidator,
  handler: async (ctx, args): Promise<Icons> => await run(ctx, args.workspaceId, "member", { kind: "folderIconsRead" }),
});

/** Give a folder an icon, or remove it with `icon: null`. Editor. Answers with every icon the caller can see. */
export const set = action({
  args: { workspaceId: v.id("workspaces"), path: v.string(), icon: v.union(v.string(), v.null()) },
  returns: iconsValidator,
  handler: async (ctx, args): Promise<Icons> =>
    await run(ctx, args.workspaceId, "editor", { kind: "folderIconSet", path: args.path, icon: args.icon }),
});
