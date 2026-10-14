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
import { getAuthUserId } from "@convex-dev/auth/server";
import { nameSaysSomething, suggestIconFor } from "@context/shared/src/iconSuggest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import { withJev } from "./lib/jev/client";
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

/**
 * The emoji the picker suggests for `path`, from its name alone, or `null`:
 * a name that says nothing (`untitled-2026-10-14`), switched
 * off, over the day's cap, or Clef not answering. Null is "no suggestion",
 * never an error; the picker still offers a random one.
 *
 * Only the name is sent, so nothing is read from the bucket and the answer
 * says nothing about whether `path` exists. Only an editor may ask, the one
 * who could set the icon, and it is metered on this workspace.
 */
export const suggest = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args): Promise<string | null> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId: userId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const path = args.path.slice(0, 1024);
    if (!nameSaysSomething(path)) return null;
    return await withJev(ctx, { feature: "iconSuggest", workspaceId: args.workspaceId }, async (jev): Promise<string | null> => {
      if (!jev) return null;
      return await suggestIconFor(path, (request) => jev.decide(request));
    });
  },
});
